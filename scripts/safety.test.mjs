import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLimitation } from '../dist/limitations.js';
import { formatNumber } from '../dist/format.js';
import { QuestionParser } from '../dist/question-parser.js';

const requests = [
  ['2025-yilda sementdan tashqari barcha mahsulotlar aylanmasi qancha?', 'exclusion'],
  ['Сколько сделок за 2025 год, исключая долларовые?', 'exclusion'],
  ['2025-yil sement bo‘yicha top 5 sotuvchi va ularning direktorlarini ayt.', 'unavailable_facts'],
  ['Назови прибыль продавцов цемента за 2025 год.', 'unavailable_facts'],
  ['2025-yilda eng ishonchli kompaniya qaysi?', 'unavailable_facts'],
  ['2025-yilda barcha valyutalar aylanmasini bitta raqam qilib ber, kurs ishlatma.', 'mixed_currencies'],
  ['2025-yilda summasi 1 milliard so‘mdan katta bitimlar soni qancha?', 'unsupported_filter'],
  ['2025-yilda yetkazib berish muddati buzilgan bitimlar soni qancha?', 'unsupported_filter'],
  ['2025-yilda sement savdo hajmi va shu kompaniyalarning bank hisoblarini ko‘rsat.', 'unavailable_facts'],
];
await test('unsupported constraints are explained before model or SQL', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Model should not be called'); };
  try {
    for (const [question, reason] of requests) {
      assert.deepEqual(await new QuestionParser().parse(question), { kind: 'limitation', reason });
    }
  } finally { globalThis.fetch = original; }
});

await test('company names are not interpreted as missing financial metrics', async () => {
  const result = await new QuestionParser().parse('2025-yilda «Foyda» sotuvchisi nechta bitim tuzgan?');
  assert.equal(result.kind, 'count');
  assert.equal(result.sellerName, 'Foyda');
});

const question = 'Подсчитай все сделки за 2025 год';
const valid = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"kind":"count","year":2025}' } }] }));
async function withModel(responses, run) {
  const original = globalThis.fetch;
  const key = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  let calls = 0;
  globalThis.fetch = async () => {
    const result = responses[calls++];
    assert.ok(result, 'Unexpected extra retry');
    if (result instanceof Error) throw result;
    return result();
  };
  try { await run(() => calls); }
  finally {
    globalThis.fetch = original;
    if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key;
  }
}
for (const [name, failure] of [
  ['network failure', new TypeError('network')],
  ['timeout', new DOMException('timeout', 'TimeoutError')],
  ['upstream 503', () => new Response('{}', { status: 503 })],
  ['invalid model JSON', () => new Response(JSON.stringify({ choices: [{ message: { content: '{broken' } }] }))],
]) {
  await test(`one retry recovers from ${name}`, async () => {
    await withModel([failure, valid], async calls => {
      assert.equal((await new QuestionParser().parse(question)).kind, 'count');
      assert.equal(calls(), 2);
    });
  });
}
await test('rate limit is not retried immediately', async () => {
  await withModel([() => new Response('{}', { status: 429 })], async calls => {
    await assert.rejects(() => new QuestionParser().parse(question), /Model HTTP 429/);
    assert.equal(calls(), 1);
  });
});
await test('retries stop after two failed attempts', async () => {
  await withModel([new TypeError('network'), new TypeError('network')], async calls => {
    await assert.rejects(() => new QuestionParser().parse(question), /Model connection unavailable/);
    assert.equal(calls(), 2);
  });
});

await test('number formatting preserves exact decimal digits and identifiers stay separate', () => {
  assert.equal(formatNumber('55976577480267.05510000000000'), '55 976 577 480 267.0551');
  assert.equal(formatNumber('115763'), '115 763');
  assert.equal(formatNumber('0.00000001'), '0.00000001');
  assert.equal(formatNumber('0.00000000'), '0');
  assert.equal(formatNumber('951319.67066277'), '951 319.67066277');
});

await test('currency and leader-name paraphrases are caught before planning', async () => {
  for (const question of [
    '2025 yil aylanmani chiqar, valyutani hisobga olish shart emas.',
    'За 2025 год дай одну общую сумму, разницу между валютами игнорируй.',
    '2024 yil summalarni valyuta kodlarisiz bitta yakuniy son qilib ber.',
    'Сложи USD и UZS в одно число без учёта валют.',
    'Barcha valyutalar uchun bitta summa kerak.',
    'Посчитай общий оборот, считая один доллар равным одному суму.',
  ]) assert.equal(detectLimitation(question), 'mixed_currencies', question);
  for (const question of [
    '2025 yil eng katta 3 sotuvchining rahbarlari kim?',
    'Sement sotuvchilarining boshliqlarini yoz.',
    'Назови руководителей компаний за 2025 год.',
  ]) assert.equal(detectLimitation(question), 'unavailable_facts', question);
});
await test('valid currency requests and company names remain supported', () => {
  for (const question of [
    '2025 yil barcha bitimlar aylanmasini USDni kunlik kurs orqali so‘mga o‘girib hisobla',
    'Все валюты за 2025 год пересчитай в сумы по курсу на дату сделки одной суммой',
    '2025 yil faqat USD aylanmasini bitta summa qilib ber',
    '2025-yilda «Rahbar Savdo» sotuvchisi nechta bitim tuzgan?',
  ]) assert.equal(detectLimitation(question), undefined, question);
});

await test('expensive-lot screenshot phrases map to explicit transaction rankings', async () => {
  const parser = new QuestionParser();
  for (const question of [
    "Menga eng qimmat lotlar haqida ma'lumot ber",
    "Bozordagi top 5 eng qimmat lot lar haqida ma'lumot ber",
  ]) {
    assert.deepEqual(await parser.parse(question), {
      kind: 'top_deals', limit: 5, convertToUzs: true, order: 'desc',
      period: { from: '2022-01-03', to: '2026-10-30' },
    });
  }
  const yearly = await parser.parse('2025-yildagi eng qimmat 5 bitim');
  assert.equal(yearly.kind, 'top_deals');
  assert.deepEqual(yearly.period, { from: '2025-01-01', to: '2025-12-31' });
});
await test('external offer IDs never become dataset lookup IDs', async () => {
  const parser = new QuestionParser();
  for (const id of ['552', '3409', '100008']) {
    assert.deepEqual(await parser.parse(`https://uzex.uz/trade/offer/${id}`), {
      kind: 'limitation', reason: 'external_link',
    });
  }
});


await test('singular and cheapest transaction requests preserve limit and direction', async () => {
  const parser = new QuestionParser();
  for (const [question, limit, order] of [
    ["Top 3 eng arzon lotlar haqida ma'lumot ber", 3, 'asc'],
    ['Eng qimmat bitim haqida ma’lumot ber', 1, 'desc'],
    ['2025 yil eng qimmat bitta bitimni ko‘rsat', 1, 'desc'],
    ['Eng arzon lot haqida ma’lumot ber', 1, 'asc'],
    ['Top 5 eng qimmat lotlar haqida ma’lumot ber', 5, 'desc'],
  ]) {
    const result = await parser.parse(question);
    assert.equal(result.kind, 'top_deals', question);
    assert.equal(result.limit, limit, question);
    assert.equal(result.order, order, question);
  }
});

await test('semantic rankings normalize currencies without requiring UZS wording', async () => {
  await withModel([() => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({kind:'top_deals',order:'asc',limit:10,convertToUzs:true}) } }] }))], async calls => {
    const result = await new QuestionParser().parse('Покажи десять самых дешёвых сделок');
    assert.equal(result.kind, 'top_deals');
    assert.equal(result.limit, 10);
    assert.equal(result.order, 'asc');
    assert.equal(result.convertToUzs, true);
    assert.equal(calls(), 1);
  });
});
await test('rankings are not mistaken for numeric threshold filters', () => {
  assert.equal(detectLimitation('Iltimos, summasi eng kichik o‘nta bitimni topib ber'), undefined);
  assert.equal(detectLimitation('2025-yilda summasi 1 milliard so‘mdan katta bitimlar soni qancha?'), 'unsupported_filter');
});
await test('one semantic repair recovers an unsupported plan', async () => {
  const reply = plan => () => new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(plan)}}]}));
  await withModel([reply({kind:'unsupported'}),reply({kind:'top_deals',order:'asc',limit:10,convertToUzs:true})], async calls => {
    const result = await new QuestionParser().parse('Eng arzon 10 ta bitimni koʼrsat');
    assert.equal(result.kind, 'top_deals');
    assert.equal(result.limit, 10);
    assert.equal(calls(), 2);
  });
});
await test('semantic repair never permits an invented company filter', async () => {
  const bad = () => new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({kind:'turnover',year:2025,sellerName:'Invented Company'})}}]}));
  await withModel([bad,bad], async calls => {
    assert.equal((await new QuestionParser().parse('2025 yil sotuvchi aylanmasini top')).kind, 'unsupported');
    assert.equal(calls(), 2);
  });
});
await test('an unsolicited conversion does not reject totals or change a selected currency', async () => {
  for (const [question, plan, expected] of [
    ['Каков суммарный оборот за 2024 год?', {kind:'turnover',year:2024,convertToUzs:true}, 'turnover'],
    ['Покажи три самых дешёвых сделки в USD за 2025 год', {kind:'top_deals',year:2025,currency:'USD',convertToUzs:true,order:'asc',limit:3}, 'top_deals'],
  ]) {
    await withModel([() => new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(plan)}}]}))], async () => {
      const result = await new QuestionParser().parse(question);
      assert.equal(result.kind, expected);
      assert.equal(result.convertToUzs, false);
    });
  }
});
await test('metric correction repairs monetary turnover misread as physical volume', async () => {
  const reply = kind => () => new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({kind,year:2025,product:'sement'})}}]}));
  await withModel([reply('turnover'),reply('volume')], async calls => {
    const result = await new QuestionParser().parse('2025 yil sement bo‘yicha jami savdo hajmini hisobla');
    assert.equal(result.kind, 'volume');
    assert.equal(calls(), 2);
  });
});
