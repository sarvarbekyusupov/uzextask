export type Period = { from: string; to: string };
export type PeriodResult = { kind: 'period'; period: Period } | { kind: 'missing' | 'invalid' };

const months = [
  ['yanvar', 'январ'], ['fevral', 'феврал'], ['mart', 'март'], ['aprel', 'апрел'],
  ['may', 'май', 'мая', 'мае'], ['iyun', 'июн'], ['iyul', 'июл'], ['avgust', 'август'],
  ['sentabr', 'sentyabr', 'сентябр'], ['oktabr', 'oktyabr', 'октябр'],
  ['noyabr', 'ноябр'], ['dekabr', 'декабр'],
];

function iso(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return;
  return date.toISOString().slice(0, 10);
}

export function extractPeriod(question: string): PeriodResult {
  const lower = question.toLowerCase();
  if (/(bugun|kecha|сегодня|вчера|chorak|kvartal|квартал|hafta|недел)/iu.test(lower)) return { kind: 'invalid' };
  const dates: string[] = [];
  const matches = question.matchAll(/\b(?:(\d{4})-(\d{2})-(\d{2})|(\d{2})\.(\d{2})\.(\d{4}))\b/g);
  for (const match of matches) {
    const value = match[1] ? iso(Number(match[1]), Number(match[2]), Number(match[3])) : iso(Number(match[6]), Number(match[5]), Number(match[4]));
    if (!value) return { kind: 'invalid' };
    dates.push(value);
  }
  if (dates.length) {
    if (dates.length > 2 || dates[0] > (dates[1] ?? dates[0])) return { kind: 'invalid' };
    return { kind: 'period', period: { from: dates[0], to: dates[1] ?? dates[0] } };
  }
  const years = [...new Set(question.match(/\b(?:19|20)\d{2}\b/g) ?? [])];
  if (!years.length) return { kind: 'missing' };
  if (years.length > 1) {
    if (years.length !== 2 || !/\b(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}\b/u.test(question) || years[0] > years[1]) return { kind: 'invalid' };
    return { kind: 'period', period: { from: `${years[0]}-01-01`, to: `${years[1]}-12-31` } };
  }
  const named = months.flatMap((names, index) => names.some((name) => new RegExp(`(?:^|[^\\p{L}])${name}`, 'iu').test(lower)) ? [index + 1] : []);
  if (named.length > 1) return { kind: 'invalid' };
  const year = Number(years[0]);
  if (named.length) {
    // Named-day expressions need explicit ISO dates to avoid interpreting a day as a whole month.
    if (/\b\d{1,2}\s*[- ]?\p{L}+/u.test(lower.replace(/\b\d{4}\b/g, ''))) return { kind: 'invalid' };
    const month = named[0];
    return { kind: 'period', period: { from: `${year}-${String(month).padStart(2, '0')}-01`, to: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10) } };
  }
  if (/(?:^|[^\p{L}])(?:oy(?:ida|idagi|lik)?|месяц[а-я]*|kun(?:i|da|lik)?|день|дня)(?=$|[^\p{L}])/iu.test(lower.replace(/kunlik kurs|ежедневн[а-я]* курс/giu, ''))) return { kind: 'invalid' };
  return { kind: 'period', period: { from: `${year}-01-01`, to: `${year}-12-31` } };
}
