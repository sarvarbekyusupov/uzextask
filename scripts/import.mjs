import { DuckDBInstance } from '@duckdb/node-api';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const official = args[0] === '--official';
if (!args.length || (official && args.length !== 2)) {
  throw new Error('Usage: npm run import -- --official <extracted-directory> | normalized.csv [...]');
}

const files = official
  ? [2022, 2023, 2024, 2025, 2026].map((year) => resolve(args[1], `deals_${year}.csv`))
  : args.map((file) => resolve(file));

async function importOfficial(connection) {
  await connection.run(`
    CREATE TEMP TABLE contract_currency (
      contract_id VARCHAR PRIMARY KEY,
      product_name VARCHAR NOT NULL,
      currency VARCHAR NOT NULL CHECK (currency IN ('UZS', 'USD'))
    )
  `);
  await connection.run(`
    INSERT INTO contract_currency
    SELECT "Номер контракта", "Наименование продукта",
      CASE "Валюта" WHEN 'Узбекский сум' THEN 'UZS' WHEN 'Доллар США' THEN 'USD' END
    FROM read_csv(?, header = true, all_varchar = true, delim = ',')
  `, [resolve(args[1], 'contracts.csv')]);

  await connection.run(`
    INSERT INTO sellers SELECT "ИНН", "Наименование"
    FROM read_csv(?, header = true, all_varchar = true, delim = ',')
  `, [resolve(args[1], 'participants.csv')]);

  await connection.run(`CREATE TABLE contracts AS SELECT * FROM read_csv(?, header=true, all_varchar=true)`, [resolve(args[1], 'contracts.csv')]);
  await connection.run(`CREATE TABLE participants AS SELECT * FROM read_csv(?, header=true, all_varchar=true)`, [resolve(args[1], 'participants.csv')]);
  await connection.run(`CREATE TABLE brokers AS SELECT * FROM read_csv(?, header=true, all_varchar=true)`, [resolve(args[1], 'brokers.csv')]);
  await connection.run(`INSERT INTO rates SELECT CAST(strptime("Дата", '%d.%m.%Y') AS DATE), CAST("Курс" AS DECIMAL(18,6)) FROM read_csv(?, header=true, all_varchar=true)`, [resolve(args[1], 'usd_rates.csv')]);
  await connection.run('CREATE TEMP TABLE imported_ids (deal_id VARCHAR PRIMARY KEY)');
  for (const file of files) {
    await connection.run(`
      CREATE OR REPLACE TEMP TABLE raw_deals AS
      SELECT "Номер сделки" AS deal_id,
        CAST(strptime("Дата сделки", '%d.%m.%Y') AS DATE) AS deal_date,
        CAST(replace("Сумма сделки", ' ', '') AS DECIMAL(28, 8)) AS amount,
        c.currency, c.product_name, d."ИНН продавца" AS seller_tax_id, d."ИНН покупателя" AS buyer_tax_id,
        d."Номер сделки" AS deal_id, d."Номер контракта" AS contract_id,
        CAST(replace(d."Количество", ' ', '') AS DECIMAL(28,8)) AS quantity,
        CAST(replace(d."Лот", ' ', '') AS DECIMAL(28,8)) AS lot,
        d."Единица измерения" AS unit, d."Брокер продавца" AS seller_broker,
        d."Брокер покупателя" AS buyer_broker, d."Регион" AS region,
        d."Состояние сделки" AS status
      FROM read_csv(?, header = true, all_varchar = true, delim = ',') AS d
      LEFT JOIN contract_currency AS c ON c.contract_id = d."Номер контракта"
    `, [file]);
    await connection.run('INSERT INTO imported_ids SELECT deal_id FROM raw_deals');
    await connection.run('INSERT INTO deals SELECT deal_date, amount, currency, product_name, seller_tax_id, buyer_tax_id, deal_id, contract_id, quantity, lot, unit, seller_broker, buyer_broker, region, status FROM raw_deals');
  }
}

const target = resolve(process.env.UZEX_DB ?? 'data/uzex.duckdb');
await mkdir(dirname(target), { recursive: true });
const temporary = `${target}.${randomUUID()}.tmp`;
try {
  const database = await DuckDBInstance.create(temporary);
  try {
    const connection = await database.connect();
    try {
      await connection.run(`
        CREATE TABLE deals (
          deal_date DATE NOT NULL,
          amount DECIMAL(28, 8) NOT NULL,
          currency VARCHAR NOT NULL CHECK (length(trim(currency)) > 0),
          product_name VARCHAR,
          seller_tax_id VARCHAR,
          buyer_tax_id VARCHAR,
          deal_id VARCHAR,
          contract_id VARCHAR,
          quantity DECIMAL(28,8),
          lot DECIMAL(28,8),
          unit VARCHAR,
          seller_broker VARCHAR,
          buyer_broker VARCHAR,
          region VARCHAR,
          status VARCHAR
        )
      `);
      await connection.run('CREATE TABLE rates (rate_date DATE PRIMARY KEY, rate DECIMAL(18,6) NOT NULL)');
      await connection.run('CREATE TABLE sellers (tax_id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL)');
      if (official) {
        await importOfficial(connection);
      } else {
        for (const file of files) {
          await connection.run(`
            INSERT INTO deals (deal_date, amount, currency)
            SELECT CAST(deal_date AS DATE), CAST(amount AS DECIMAL(28, 8)), upper(trim(currency))
            FROM read_csv(?, header = true, all_varchar = true)
          `, [file]);
        }
      }
      const report = await connection.runAndReadAll('SELECT count(*) FROM deals');
      const [[count]] = report.getRows();
      if (count === 0n) throw new Error('No deals found');
      await connection.run(`
        CREATE TABLE coverage AS
        SELECT min(year(deal_date)) AS first_year, max(year(deal_date)) AS last_year, min(deal_date) AS first_date, max(deal_date) AS last_date FROM deals
      `);
      await connection.run('CHECKPOINT');
      process.stdout.write(`Imported ${count} rows.\n`);
    } finally {
      connection.closeSync();
    }
  } finally {
    database.closeSync();
  }
  await rename(temporary, target);
} finally {
  await rm(temporary, { force: true });
  await rm(`${temporary}.wal`, { force: true });
}
