import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const cases = JSON.parse(await readFile(new URL('./verification-cases.json', import.meta.url), 'utf8'));
const base = process.env.UZEX_QUESTIONS_URL ?? 'http://127.0.0.1:3000/questions';
function normalizeNumbers(text) {
  return text.replace(/(?<=\d)\s+(?=\d)/gu, '').replace(/\d+\.\d+/gu, number => number.replace(/0+$/u, '').replace(/\.$/u, ''));
}
let failures = 0;
for (const [index, test] of cases.entries()) {
  try {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: test.question }),
      signal: AbortSignal.timeout(50_000),
    });
    const result = await response.json();
    const pass = response.ok && result.kind === test.kind && test.expected.every(value => normalizeNumbers(result.answer ?? '').includes(normalizeNumbers(value)));
    if (!pass) failures++;
    process.stdout.write(`${index + 1}/${cases.length} ${pass ? 'PASS' : 'FAIL'} ${test.question}\n`);
  } catch {
    failures++;
    process.stdout.write(`${index + 1}/${cases.length} FAIL request error\n`);
  }
  await delay(3000);
}
process.stdout.write(`${cases.length - failures}/${cases.length} passed\n`);
process.exitCode = failures ? 1 : 0;
