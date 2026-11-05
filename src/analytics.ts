import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DuckDBInstance } from '@duckdb/node-api';
import { isCement } from './products.js';
import type { Query } from './question-parser.js';

@Injectable()
export class Analytics implements OnModuleDestroy {
  private readonly database = DuckDBInstance.create(process.env.UZEX_DB ?? 'data/uzex.duckdb', { access_mode: 'READ_ONLY' });
  constructor() { void this.database.catch(() => undefined); }

  async onModuleDestroy() { (await this.database).closeSync(); }

  async annualSummary(query: Query) {
    const connection = await (await this.database).connect();
    try {
      if ('id' in query) {
        const lookups = {
          lookup_company: { table: 'participants', column: '"ИНН"' },
          lookup_broker: { table: 'brokers', column: '"Код брокера"' },
          lookup_contract: { table: 'contracts', column: '"Номер контракта"' },
          lookup_deal: { table: 'deals', column: 'deal_id' },
        };
        const { table, column } = lookups[query.kind];
        const exists = await connection.runAndReadAll('SELECT count(*) FROM information_schema.tables WHERE table_name = ?', [table]);
        if (exists.getRows()[0]?.[0] === 0n) return { kind: 'lookup', rows: [] } as const;
        const result = await connection.runAndReadAll(`SELECT * FROM ${table} WHERE ${column} = ? LIMIT 1`, [query.id.toUpperCase()]);
        return { kind: 'lookup', rows: result.getRowObjects() } as const;
      }
      const conditions = ['d.deal_date >= CAST(? AS DATE)', 'd.deal_date <= CAST(? AS DATE)'];
      const values: (string | number)[] = [query.period.from, query.period.to];
      for (const [field, column] of [
        [query.sellerName, 'seller_tax_id'], [query.buyerName, 'buyer_tax_id'],
      ]) {
        if (!field) continue;
        const matches = await connection.runAndReadAll('SELECT tax_id, name FROM sellers WHERE contains(lower(name), lower(?)) ORDER BY tax_id LIMIT 6', [field]);
        const companies = matches.getRowObjects();
        if (!companies.length) return { kind: 'summary', rows: [] } as const;
        if (companies.length > 1) return { kind: 'ambiguous', rows: companies } as const;
        const id = companies[0].tax_id;
        if (typeof id !== 'string') throw new Error('Invalid company identifier');
        conditions.push(`d.${column} = ?`);
        values.push(id);
      }
      if (query.product) {
        const cement = isCement(query.product);
        conditions.push(cement ? "contains(lower(d.product_name), 'цемент')" : 'lower(d.product_name) = lower(?)');
        if (!cement) values.push(query.product);
      }
      for (const [field, column] of [
        [query.sellerTaxId, 'seller_tax_id'], [query.buyerTaxId, 'buyer_tax_id'],
        [query.contractId, 'contract_id'], [query.currency, 'currency'],
      ]) {
        if (!field) continue;
        conditions.push(`d.${column} = ?`);
        values.push(field);
      }
      if (query.brokerCode) {
        conditions.push('(d.seller_broker = ? OR d.buyer_broker = ?)');
        values.push(query.brokerCode.toUpperCase(), query.brokerCode.toUpperCase());
      }
      const where = conditions.join(' AND ');
      const coverageReader = await connection.runAndReadAll('SELECT CAST(first_date AS VARCHAR) AS first_date, CAST(last_date AS VARCHAR) AS last_date FROM coverage');
      const [coverage] = coverageReader.getRowObjects();
      if (!coverage || query.period.to < String(coverage.first_date) || query.period.from > String(coverage.last_date)) {
        return { kind: 'outside_coverage', rows: [] } as const;
      }
      const metadata = { coverage };
      const currency = query.convertToUzs ? "'UZS'" : 'd.currency';
      const amount = query.convertToUzs ? "CASE WHEN d.currency = 'USD' THEN d.amount * r.rate ELSE d.amount END" : 'd.amount';
      const from = 'deals d LEFT JOIN rates r ON r.rate_date = d.deal_date';
      if (query.convertToUzs) {
        const missing = await connection.runAndReadAll(`SELECT count(*) AS missing FROM ${from} WHERE ${where} AND d.currency = 'USD' AND r.rate IS NULL`, values);
        if (missing.getRows()[0]?.[0] !== 0n) throw new Error('Missing exchange rates');
      }
      if (query.kind === 'top_deals') {
        const reader = await connection.runAndReadAll(`
          WITH ranked AS (
            SELECT d.deal_id AS entity, d.product_name AS name, ${currency} AS currency,
              ${amount} AS total, row_number() OVER (ORDER BY ${amount} DESC, d.deal_id) AS rank
            FROM ${from} WHERE ${where} AND d.deal_id IS NOT NULL
          )
          SELECT entity, name, currency, CAST(total AS VARCHAR) AS amount,
            CAST(rank AS VARCHAR) AS rank, '1' AS deals
          FROM ranked WHERE rank <= ? ORDER BY ranked.rank
        `, [...values, query.limit]);
        return { kind: 'summary', rows: reader.getRowObjects(), ...metadata } as const;
      }
      if ('limit' in query) {
        const group = { top_sellers: 'd.seller_tax_id', top_buyers: 'd.buyer_tax_id', top_products: 'd.product_name' }[query.kind];
        const label = query.kind === 'top_products' ? 'entity' : 'sellers.name';
        const reader = await connection.runAndReadAll(`
          WITH totals AS (
            SELECT ${currency} AS currency, ${group} AS entity, SUM(${amount}) AS amount, COUNT(*) AS deals
            FROM ${from} WHERE ${where} AND ${group} IS NOT NULL GROUP BY ${currency}, entity
          ), ranked AS (
            SELECT *, row_number() OVER (PARTITION BY currency ORDER BY amount DESC, entity) AS rank FROM totals
          )
          SELECT currency, entity, ${label} AS name, CAST(round(amount, 8) AS VARCHAR) AS amount,
            CAST(deals AS VARCHAR) AS deals, CAST(rank AS VARCHAR) AS rank
          FROM ranked LEFT JOIN sellers ON sellers.tax_id = ranked.entity
          WHERE rank <= ? ORDER BY currency, ranked.rank
        `, [...values, query.limit]);
        return { kind: 'summary', rows: reader.getRowObjects(), ...metadata } as const;
      }
      let sql: string;
      if (query.kind === 'count') {
        sql = `SELECT CAST(count(*) AS VARCHAR) AS deals FROM ${from} WHERE ${where}`;
      } else if (query.kind === 'volume') {
        sql = `SELECT d.unit, CAST(SUM(d.quantity * d.lot) AS VARCHAR) AS volume, CAST(count(*) AS VARCHAR) AS deals
          FROM ${from} WHERE ${where} GROUP BY d.unit ORDER BY d.unit`;
      } else if (query.kind === 'unit_price') {
        sql = `SELECT ${currency} AS currency, d.unit, CAST(round(SUM(${amount}) / NULLIF(SUM(d.quantity * d.lot), 0), 8) AS VARCHAR) AS amount,
          CAST(count(*) AS VARCHAR) AS deals FROM ${from} WHERE ${where} GROUP BY ${currency}, d.unit ORDER BY currency, d.unit`;
      } else {
        const aggregate = query.kind === 'average_amount' ? `round(AVG(${amount}), 2)` : `SUM(${amount})`;
        sql = `SELECT ${currency} AS currency, CAST(${aggregate} AS VARCHAR) AS amount, CAST(count(*) AS VARCHAR) AS deals
          FROM ${from} WHERE ${where} GROUP BY ${currency} ORDER BY currency`;
      }
      const reader = await connection.runAndReadAll(sql, values);
      return { kind: 'summary', rows: reader.getRowObjects(), ...metadata } as const;
    } finally { connection.closeSync(); }
  }
}
