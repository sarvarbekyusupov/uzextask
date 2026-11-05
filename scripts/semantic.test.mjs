import 'reflect-metadata';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { QuestionParser } from '../dist/question-parser.js';
import { Analytics } from '../dist/analytics.js';

if (!process.env.OPENROUTER_API_KEY && !process.env.LLM_CHAT_URL) throw new Error('Configure an LLM before running semantic tests');
const cases = [
  ["Top 10 eng arzon bitimlar haqida ma’lumot ber", {kind:'top_deals',limit:10,order:'asc'}],
  ["Iltimos, summasi eng kichik o‘nta bitimni topib ber", {kind:'top_deals',limit:10,order:'asc'}],
  ['Покажи десять самых дешёвых сделок', {kind:'top_deals',limit:10,order:'asc'}],
  ['Eng arzon 10 ta bitimni koʼrsat', {kind:'top_deals',limit:10,order:'asc'}],
  ['Menga narxi eng baland bitimni topib ber', {kind:'top_deals',limit:1,order:'desc'}],
  ['Какая сделка самая дорогая?', {kind:'top_deals',limit:1,order:'desc'}],
  ['Eng kichik summali uchta bitim kerak', {kind:'top_deals',limit:3,order:'asc'}],
  ['Самые крупные пять сделок по общей сумме', {kind:'top_deals',limit:5,order:'desc'}],
  ['2025 yil eng arzon beshta bitimni top', {kind:'top_deals',limit:5,order:'asc',year:2025}],
  ['За 2025 год найди три самые дешёвые сделки', {kind:'top_deals',limit:3,order:'asc',year:2025}],
  ['2024 yilda eng katta summali bitta bitim qaysi?', {kind:'top_deals',limit:1,order:'desc',year:2024}],
  ['Выведи 7 сделок с наименьшей общей суммой', {kind:'top_deals',limit:7,order:'asc'}],
  ['Eng arzon 2 ta lot haqida maʼlumot bera olasanmi?', {kind:'top_deals',limit:2,order:'asc'}],
  ['Menga eng qimmat 4 ta bitimni ro‘yxat qilib ber', {kind:'top_deals',limit:4,order:'desc'}],
  ['2025 yil faqat USD valyutadagi eng arzon uchta bitim', {kind:'top_deals',limit:3,order:'asc',year:2025,currency:'USD',convertToUzs:false}],
  ['Три самые дорогие сделки в UZS за 2024 год', {kind:'top_deals',limit:3,order:'desc',year:2024,currency:'UZS',convertToUzs:false}],
  ['2025 yil nechta savdo bitimi tuzilganini hisoblab ber', {kind:'count',year:2025}],
  ['Посчитай количество сделок за 2024 год, пожалуйста', {kind:'count',year:2024}],
  ['2025 yil davomida jami qancha pulga savdo bo‘lgan?', {kind:'turnover',year:2025}],
  ['Каков суммарный оборот за 2024 год?', {kind:'turnover',year:2024}],
  ['2025 yildagi bitimlarning o‘rtacha summasini hisobla', {kind:'average_amount',year:2025}],
  ['2025 yil BK002 orqali nechta bitim tuzilgan?', {kind:'count',year:2025,brokerCode:'BK002'}],
  ['За 2025 год посчитай сделки брокера BK001', {kind:'count',year:2025,brokerCode:'BK001'}],
  ['2025 yil sotuvchi STIR 984713635 bo‘yicha bitimlar sonini hisobla', {kind:'count',year:2025,sellerTaxId:'984713635'}],
  ['2025 yil sement bo‘yicha jami savdo hajmini hisobla', {kind:'volume',year:2025,product:'sement'}],
  ['2025 yil sement bo‘yicha yetakchi uchta sotuvchi kim?', {kind:'top_sellers',year:2025,limit:3,product:'sement'}],
  ['2025 yil sement sotuvchilarining direktorlarini ayt', {kind:'limitation'}],
  ['2025 yil bitimlar aylanmasini o‘ylab top', {kind:'limitation'}],
  ['2025 yil summasi 1 milliarddan katta bitimlar soni', {kind:'limitation'}],
  ['2025 yil barcha valyutalarni hisobga olmay bitta summa chiqar', {kind:'limitation'}],
];
const database = await DuckDBInstance.create(process.env.UZEX_DB ?? 'data/uzex.duckdb', {access_mode:'READ_ONLY'});
const connection = await database.connect();
const parser = new QuestionParser();
const analytics = new Analytics();
const results = [];
try {
  // Two workers bound provider load. Each answer gets checked against an independent database query.
  let next = 0;
  async function worker() {
    while (next < cases.length) {
      const index = next++;
      const [question, expected] = cases[index];
      try {
        const plan = await parser.parse(question);
        for (const [key, value] of Object.entries(expected)) assert.equal(key === 'convertToUzs' ? Boolean(plan[key]) : plan[key], value, key);
        if (plan.kind !== 'limitation') {
          const result = await analytics.annualSummary(plan);
          assert.equal(result.kind, 'summary');
          assert.ok(result.rows.length, 'Empty answer');
          const clauses = ['deal_date BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)'];
          const values = [plan.period.from, plan.period.to];
          if (expected.currency) { clauses.push('currency = ?'); values.push(expected.currency); }
          if (expected.sellerTaxId) { clauses.push('seller_tax_id = ?'); values.push(expected.sellerTaxId); }
          if (expected.brokerCode) { clauses.push('(seller_broker = ? OR buyer_broker = ?)'); values.push(expected.brokerCode, expected.brokerCode); }
          if (expected.product) clauses.push("contains(lower(product_name), 'цемент')");
          const where = clauses.join(' AND ');
          if (expected.kind === 'top_deals') {
            const amount = plan.convertToUzs ? "CASE WHEN currency = 'USD' THEN amount * rate ELSE amount END" : 'amount';
            const ref = await connection.runAndReadAll(`SELECT deal_id, CAST(${amount} AS VARCHAR) AS total FROM deals LEFT JOIN rates ON rate_date = deal_date WHERE ${where} ORDER BY ${amount} ${expected.order === 'asc' ? 'ASC' : 'DESC'}, deal_id LIMIT ?`, [...values,expected.limit]);
            assert.deepEqual(result.rows.map(r=>[r.entity,r.amount]),ref.getRowObjects().map(r=>[r.deal_id,r.total]));
          } else if (['turnover','average_amount'].includes(expected.kind)) {
            const aggregate = expected.kind === 'turnover' ? 'sum(amount)' : 'round(avg(amount),2)';
            const ref = await connection.runAndReadAll(`SELECT currency, CAST(${aggregate} AS VARCHAR) AS total FROM deals WHERE ${where} GROUP BY currency ORDER BY currency`, values);
            assert.deepEqual(result.rows.map(r=>[r.currency,r.amount]),ref.getRowObjects().map(r=>[r.currency,r.total]));
          } else if (expected.kind === 'volume') {
            const ref = await connection.runAndReadAll(`SELECT unit, CAST(sum(quantity * lot) AS VARCHAR) AS total FROM deals WHERE ${where} GROUP BY unit ORDER BY unit`, values);
            assert.deepEqual(result.rows.map(r=>[r.unit,r.volume]),ref.getRowObjects().map(r=>[r.unit,r.total]));
          } else if (expected.kind === 'top_sellers') {
            const ref = await connection.runAndReadAll(`WITH totals AS (SELECT currency, seller_tax_id AS entity, round(sum(amount),8) AS total FROM deals WHERE ${where} GROUP BY currency, seller_tax_id), ranked AS (SELECT *, row_number() OVER (PARTITION BY currency ORDER BY total DESC, entity) AS n FROM totals) SELECT currency, entity, CAST(total AS VARCHAR) AS total FROM ranked WHERE n <= ? ORDER BY currency, n`, [...values,expected.limit]);
            assert.deepEqual(result.rows.map(r=>[r.currency,r.entity,r.amount]),ref.getRowObjects().map(r=>[r.currency,r.entity,r.total]));
          } else if (expected.kind === 'count') {
            const ref = await connection.runAndReadAll(`SELECT CAST(count(*) AS VARCHAR) FROM deals WHERE ${where}`, values);
            assert.equal(result.rows[0].deals,ref.getRows()[0][0]);
          }
        }
        results[index] = {question,pass:true};
        console.log('PASS', index + 1, question);
      } catch (error) {
        results[index] = {question,pass:false,error:error.message};
        console.log('FAIL', index + 1, question, error.message);
      }
    }
  }
  await Promise.all([worker(),worker()]);
} finally { connection.closeSync(); database.closeSync(); await analytics.onModuleDestroy(); }
if (process.env.SEMANTIC_REPORT) writeFileSync(process.env.SEMANTIC_REPORT, JSON.stringify(results,null,2));
console.log(`${results.filter(r=>r.pass).length}/${cases.length} passed`);
if (results.some(r=>!r.pass)) process.exitCode = 1;
