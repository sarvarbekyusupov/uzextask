import { setTimeout as delay } from 'node:timers/promises';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { detectLimitation, type LimitationReason } from './limitations.js';
import { isCement } from './products.js';
import { extractPeriod, type Period } from './period.js';

const year = z.number().int().min(1900).max(2099);
const product = z.string().trim().min(1).max(120);
const taxId = z.string().regex(/^\d{9}$/);
const filters = {
  year: year.optional(),
  product: product.optional(),
  sellerTaxId: taxId.optional(),
  buyerTaxId: taxId.optional(),
  sellerName: product.optional(),
  buyerName: product.optional(),
  contractId: z.string().regex(/^\d+$/).optional(),
  brokerCode: z.string().regex(/^BK\d{3}$/i).optional(),
  currency: z.enum(['UZS', 'USD']).optional(),
  convertToUzs: z.boolean().optional(),
};
const querySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('count'), ...filters }),
  z.strictObject({ kind: z.literal('turnover'), ...filters }),
  z.strictObject({ kind: z.literal('average_amount'), ...filters }),
  z.strictObject({ kind: z.literal('top_sellers'), ...filters, limit: z.number().int().min(1).max(20) }),
  z.strictObject({ kind: z.literal('top_buyers'), ...filters, limit: z.number().int().min(1).max(20) }),
  z.strictObject({ kind: z.literal('top_deals'), ...filters, order: z.enum(['asc', 'desc']).optional(), limit: z.number().int().min(1).max(20) }),
  z.strictObject({ kind: z.literal('top_products'), ...filters, limit: z.number().int().min(1).max(20) }),
  z.strictObject({ kind: z.literal('volume'), ...filters }),
  z.strictObject({ kind: z.literal('unit_price'), ...filters }),
  z.strictObject({ kind: z.literal('lookup_company'), id: taxId }),
  z.strictObject({ kind: z.literal('lookup_broker'), id: z.string().regex(/^BK\d{3}$/i) }),
  z.strictObject({ kind: z.literal('lookup_contract'), id: z.string().regex(/^\d+$/) }),
  z.strictObject({ kind: z.literal('lookup_deal'), id: z.string().regex(/^\d+$/) }),
  z.strictObject({ kind: z.literal('needs_year') }),
  z.strictObject({ kind: z.literal('unsupported') }),
]);
type RawIntent = z.infer<typeof querySchema>;
export type Query = Exclude<RawIntent, { kind: 'needs_year' | 'unsupported' }> & { period: Period };
type Intent = Query | { kind: 'needs_year' } | { kind: 'unsupported'; reason?: string } | { kind: 'limitation'; reason: LimitationReason };
const fullPeriod: Period = { from: '2022-01-03', to: '2026-10-30' };
const envelope = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) });

function exact(question: string): RawIntent | undefined {
  const normalized = question.replace(/['’ʻʼ`]/gu, '‘').replace(/[?.!]+$/u, '').trim();
  if (/^(?:jami aylanma qancha|nechta bitim bo[‘’]lgan|какой общий оборот|сколько сделок)$/iu.test(normalized)) {
    return { kind: 'needs_year' };
  }
  const uzSum = /^(\d{4})[- ]?yil bo‘yicha jami bitimlar summasini valyutalar kesimida ayt$/iu.exec(normalized);
  if (uzSum) return { kind: 'turnover', year: Number(uzSum[1]) };
  const uzTop = /^(\d{4})[- ]?yilda (.+?) bo‘yicha (?:aylanmasi eng katta |top[- ]?)(\d{1,2}) ta sotuvchi kim$/iu.exec(normalized);
  const ruTop = /^топ[- ]?(\d{1,2}) продавцов по обороту (?:товара )?(.+?) за (\d{4}) год$/iu.exec(normalized);
  const top = uzTop ?? ruTop;
  if (top) {
    const parsed = querySchema.safeParse({ kind: 'top_sellers', year: Number(uzTop?.[1] ?? ruTop?.[3]), product: top[2], limit: Number(uzTop?.[3] ?? ruTop?.[1]) });
    return parsed.success ? parsed.data : { kind: 'unsupported' };
  }

  const uz = /^(\d{4})[- ]?yilda (?:(.+?) bo‘yicha )?(nechta bitim (?:bo[‘’]lgan|tuzilgan)|jami aylanma qancha|o‘rtacha bitim summasi qancha)$/iu.exec(normalized);
  if (uz) {
    const metric = uz[3].toLowerCase();
    const parsed = querySchema.safeParse({
      kind: metric.startsWith('nechta') ? 'count' : metric.startsWith('jami') ? 'turnover' : 'average_amount',
      year: Number(uz[1]), product: uz[2],
    });
    return parsed.success ? parsed.data : { kind: 'unsupported' };
  }

  const ru = /^(сколько сделок (?:было |заключено )?|какой общий оборот |какая средняя сумма сделки )в (\d{4}) году$/iu.exec(normalized);
  if (ru) {
    const metric = ru[1].toLowerCase();
    const parsed = querySchema.safeParse({ kind: metric.startsWith('сколько') ? 'count' : metric.startsWith('какой') ? 'turnover' : 'average_amount', year: Number(ru[2]) });
    return parsed.success ? parsed.data : { kind: 'unsupported' };
  }
}

const instructions = `Classify one Uzbek or Russian UZEX question. Return JSON only.
Allowed kinds: count, turnover, average_amount (average amount per deal), volume (physical quantity * lot; savdo hajmi, объём торговли, never monetary turnover), unit_price (sum amount / sum volume, weighted), top_sellers, top_buyers, top_products, top_deals (individual transactions ranked by total amount), lookup_company, lookup_broker, lookup_contract, lookup_deal, needs_year, unsupported.
Analytics fields: year (if explicit), product (exact requested phrase), sellerTaxId / buyerTaxId (9-digit IDs), sellerName / buyerName (company name copied from question), contractId, brokerCode (BKxxx, matches either side), currency (UZS or USD, only when user filters that currency), convertToUzs (true only when all amounts requested in UZS). Ranking kinds additionally require limit (1–20). Use 1 for a single leader; otherwise default to 5 if unspecified. No other fields. Understand meaning across word order, politeness, synonyms and Uzbek apostrophe variants; do not require example wording.
"Most expensive lots" and "eng qimmat lotlar" mean top_deals by total transaction amount. For top_deals set order:"asc" for cheapest/smallest and "desc" for most expensive/largest. Singular requests require limit:1. For top_deals ONLY, use convertToUzs:true unless the user explicitly selects one currency. For every other kind, omit convertToUzs unless the user explicitly requests conversion into UZS; ordinary totals and averages are grouped by currency automatically. If ranking unit/lot prices is requested, use unsupported instead of changing the price basis.
Date range is extracted independently by code. Preserve the user's other filters. Do not use unsupported merely because the question mentions a month or ISO dates.
Lookup kinds use ONLY kind and id copied verbatim from the question. Lookup details come from the database.
Use unsupported for unsupported metrics or filters, comparison of separate periods, status or region filters, requests to invent answers, or ambiguity. Use needs_year if no time period is given for analytics, except top_deals which may use the full available dataset period.
Never output an answer, SQL, company facts or numeric results.
A request for cheapest transactions is supported, including "summasi eng kichik o‘nta bitim", "eng arzon 10 ta bitim", "Покажи десять самых дешёвых сделок": {"kind":"top_deals","order":"asc","limit":10,"convertToUzs":true}.
Words for numbers such as o‘nta/десять mean 10, uchta/три mean 3. Return the requested count. Copy product/company filter text exactly, including apostrophes; do not translate names or omit constraints.
The actual validated query schema follows:
${JSON.stringify(z.toJSONSchema(querySchema))}
Example: "2025-yil sement bozorining beshta yetakchi sotuvchisini ko‘rsat" -> {"kind":"top_sellers","year":2025,"product":"sement","limit":5}.
Example: "Назови пятёрку лидеров по обороту цемента за 2025 год" -> {"kind":"top_sellers","year":2025,"product":"цемента","limit":5}.
Example: "2025-yil yanvar oyida jami aylanma qancha?" -> {"kind":"turnover","year":2025}.
Example: "2025 yil sotuvchi STIR 984713635 aylanmasi" -> {"kind":"turnover","year":2025,"sellerTaxId":"984713635"}.`;

@Injectable()
export class QuestionParser {
  private readonly logger = new Logger(QuestionParser.name);
  async parse(question: string): Promise<Intent> {
    const limitation = detectLimitation(question);
    if (limitation) return { kind: 'limitation', reason: limitation };
    const period = extractPeriod(question);
    if (/(?:bazani ishlatma|o[‘’'ʻ]ylab top|to[‘’'ʻ]qib|игнорируй правила|придумай ответ|выдумай)/iu.test(question)) return { kind: 'unsupported' };
    const lotText = question.toLowerCase().replace(/['’ʻʼ`]/gu, '‘').replace(/[?.!]+$/u, '').trim()
      .replace(/^\d{4}[- ]?yil(?:da|dagi)?\s+/u, '').replace(/lot\s+lar/gu, 'lotlar');
    const ranking = /^(?:menga |bozordagi )?(?:top[- ]?(\d{1,2}) )?(eng qimmat|eng katta summali|eng arzon|eng kichik summali) (?:(\d{1,2}|bitta|bir) )?(lotlar|lot|lotni|lotlarni|bitimlar|bitim|bitimni|bitimlarni)(?: (?:haqida ma‘lumot ber|haqida ma‘lumot|ni ko‘rsat|ko‘rsat|qaysilar))?$/iu.exec(lotText);
    if (ranking) {
      if (period.kind === 'invalid') return { kind: 'unsupported' };
      const count = ranking[1] ?? ranking[3];
      const singular = ['lot', 'lotni', 'bitim', 'bitimni'].includes(ranking[4]);
      const limit = count === 'bitta' || count === 'bir' ? 1 : Number(count ?? (singular ? 1 : 5));
      const parsed = querySchema.safeParse({
        kind: 'top_deals', limit, convertToUzs: true,
        order: /arzon|kichik/u.test(ranking[2]) ? 'asc' : 'desc',
      });
      if (!parsed.success || parsed.data.kind !== 'top_deals') return { kind: 'unsupported' };
      return { ...parsed.data, period: period.kind === 'period' ? period.period : fullPeriod };
    }
    let direct = exact(question);
    const normalized = question.replace(/['’ʻʼ`]/gu, '‘').replace(/[?.!]+$/u, '').trim();
    const lookupPatterns = [
      { kind: 'lookup_broker', pattern: /^(BK\d{3})\s+broker haqida(?: ma[‘]lumot)?$/iu },
      { kind: 'lookup_company', pattern: /^STIR\s+(\d{9})\s+kompaniya haqida(?: ma[‘]lumot)?$/iu },
      { kind: 'lookup_deal', pattern: /^(\d+)\s+raqamli bitim haqida(?: ma[‘]lumot)?$/iu },
    ];
    for (const lookup of lookupPatterns) {
      const match = lookup.pattern.exec(normalized);
      if (match) {
        const parsed = querySchema.parse({ kind: lookup.kind, id: match[1] });
        if ('id' in parsed) return { ...parsed, period: { from: '2022-01-03', to: '2026-10-30' } };
      }
    }
    if (!direct && period.kind === 'period') {
      const year = Number(period.period.from.slice(0, 4));
      const company = /^(\d{4})[- ]?yilda [«"](.+?)[»"] (sotuvchisi|xaridori) (nechta bitim tuzgan|aylanmasi qancha)$/iu.exec(normalized);
      if (company) {
        direct = querySchema.parse({
          kind: company[4].startsWith('nechta') ? 'count' : 'turnover',
          year, ...(company[3] === 'sotuvchisi' ? { sellerName: company[2] } : { buyerName: company[2] }),
        });
      }
      const count = /^(?:\d{4}[- ]?yil\s+)?(BK\d{3}) broker qatnashgan bitimlar soni qancha$/iu.exec(normalized);
      const seller = /^\d{4}[- ]?yil sotuvchi STIR (\d{9}) nechta bitim qilgan$/iu.exec(normalized);
      const converted = /^\d{4}[- ]?yil barcha bitimlar aylanmasini USDni kunlik kurs orqali so‘mga o‘girib hisobla$/iu.test(normalized);
      const volume = /^\d{4}[- ]?yilda (.+?) savdo hajmi qancha$/iu.exec(normalized);
      const price = /^\d{4}[- ]?yil (.+?)(?:ning) o‘rtacha birlik narxi qancha$/iu.exec(normalized);
      if (count) direct = { kind: 'count', brokerCode: count[1], year };
      if (seller) direct = { kind: 'count', sellerTaxId: seller[1], year };
      if (converted) direct = { kind: 'turnover', convertToUzs: true, year };
      if (volume) direct = { kind: 'volume', product: volume[1], year };
      if (price) direct = { kind: 'unit_price', product: price[1], year };
      const dated = /^(?:\d{4}[- ]?yil\s+\p{L}+\s+oyida|\d{4}-\d{2}-\d{2} dan \d{4}-\d{2}-\d{2} gacha)\s+(nechta bitim bo[‘]lgan|jami aylanma qancha)$/iu.exec(normalized);
      if (dated) direct = { kind: dated[1].startsWith('nechta') ? 'count' : 'turnover', year };
    }
    if (direct && (direct.kind === 'needs_year' || direct.kind === 'unsupported')) return direct;
    if (direct) {
      if (period.kind !== 'period') return { kind: period.kind === 'missing' ? 'needs_year' : 'unsupported' };
      return { ...direct, period: period.period };
    }
    const lookup = /^(?:shartnoma|контракт|договор)\s*#?\s*(\d+)\s*(?:haqida|ma[‘’'ʻ]lumot|карточка|информация)?(?:\s*(?:batafsil|подробно))?[?.!]?$/iu.exec(question.trim());
    if (lookup) return { kind: 'lookup_contract', id: lookup[1], period: { from: '2022-01-03', to: '2026-10-30' } };
    if (period.kind === 'invalid') return { kind: 'unsupported' };

    const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
    const url = openRouterKey ? 'https://openrouter.ai/api/v1/chat/completions' : process.env.LLM_CHAT_URL;
    const model = openRouterKey ? process.env.OPENROUTER_MODEL?.trim() || 'openrouter/free' : process.env.LLM_MODEL;
    if (!url || !model) return { kind: 'unsupported' };

    const key = openRouterKey || process.env.LLM_API_KEY;
    const deadline = Date.now() + 40_000;
    let intent = await this.requestIntent(question, url, model, key, undefined, deadline);
    let result = this.groundIntent(question, intent, period);
    if (result.kind === 'unsupported') {
      this.logger.warn({ event: 'llm_plan_repair', reason: intent.kind === 'unsupported' ? 'unsupported_plan' : 'grounding_rejected' });
      intent = await this.requestIntent(question, url, model, key, intent, deadline, result.reason);
      result = this.groundIntent(question, intent, period);
    }
    return result;
  }

  private groundIntent(question: string, intent: RawIntent, period: ReturnType<typeof extractPeriod>): Intent {
    if (intent.kind === 'needs_year' || intent.kind === 'unsupported') return intent;
    if ('id' in intent) {
      if (!new RegExp(`(?:^|[^a-zA-Z0-9])${intent.id}(?=$|[^a-zA-Z0-9])`, 'i').test(question)) return { kind: 'unsupported' };
      return { ...intent, period: { from: '2022-01-03', to: '2026-10-30' } };
    }
    if (period.kind !== 'period' && intent.kind !== 'top_deals') return { kind: 'needs_year' };
    const asksForUzs = /(?:so[‘’'ʻʼ]m|сумах|сумы|UZS)/iu.test(question);
    if (intent.convertToUzs && !asksForUzs && intent.kind !== 'top_deals') intent = { ...intent, convertToUzs: false };
    if (intent.kind === 'top_deals' && intent.currency && !/(?:so[‘’'ʻʼ]mga|в сумах|сумга)/iu.test(question)) intent = { ...intent, convertToUzs: false };
    const normalize = (text: string) => text.toLowerCase().replace(/['’ʻʼ`]/gu, '‘');
    const lower = normalize(question);
    if ((question.match(/\p{L}+/gu) ?? []).some(isCement) && !intent.product) return { kind: 'unsupported' };
    for (const value of [intent.product, intent.sellerTaxId, intent.buyerTaxId, intent.sellerName, intent.buyerName, intent.brokerCode, intent.contractId]) {
      if (value && !lower.includes(normalize(value))) return { kind: 'unsupported' };
    }
    const quotedNames = [...question.matchAll(/[«“"]([^»”"]{3,120})[»”"]/gu)].map(match => match[1]);
    for (const name of quotedNames) {
      if (![intent.product, intent.sellerName, intent.buyerName].some(value => value && normalize(value) === normalize(name))) return { kind: 'unsupported' };
    }
    if (/(?:bekor qilingan|оплачен|аннулирован|исполнен|Toshkent viloyati|Ташкентская область)/iu.test(question)) return { kind: 'unsupported' };
    for (const id of question.match(/\b\d{9}\b/g) ?? []) {
      if (id !== intent.sellerTaxId && id !== intent.buyerTaxId) return { kind: 'unsupported' };
    }
    for (const code of question.match(/\bBK\d{3}\b/gi) ?? []) {
      if (code.toLowerCase() !== intent.brokerCode?.toLowerCase()) return { kind: 'unsupported' };
    }
    if (/(?:nechta|bitimlar? soni|количество сделок|сколько сделок)/iu.test(question) && intent.kind !== 'count') return { kind: 'unsupported', reason: 'Requested metric is number of deals: use count.' };
    if (/(?:hajmi|savdo hajm|объ[её]м)/iu.test(question) && intent.kind !== 'volume' && intent.kind !== 'unit_price') return { kind: 'unsupported', reason: 'Requested metric is physical trade volume (savdo hajmi / объём), not monetary turnover. Use volume.' };
    if (/(?:aylanma|оборот)/iu.test(question) && !['turnover', 'top_sellers', 'top_buyers', 'top_products', 'top_deals'].includes(intent.kind)) return { kind: 'unsupported' };
    const requestedLimit = /(?:top[- ]?|топ[- ]?)(\d{1,2})/iu.exec(question)?.[1];
    if (requestedLimit && (!('limit' in intent) || intent.limit !== Number(requestedLimit))) return { kind: 'unsupported' };
    if (/(?:so[‘’'ʻ]mga|в сумах|сумга)/iu.test(question) && !intent.convertToUzs && intent.currency !== 'UZS') return { kind: 'unsupported' };
    if (/\b(?:USD|доллар|dollar)/iu.test(question) && !intent.currency && !intent.convertToUzs) return { kind: 'unsupported' };
    if (/(?:средн.*цен|o[‘’'ʻ]rtacha.*narx)/iu.test(question) && intent.kind !== 'unit_price') return { kind: 'unsupported' };
    if (intent.kind === 'top_deals') {
      return { ...intent, order: /eng arzon|eng kichik|деш[её]в/iu.test(question) ? 'asc' : intent.order ?? 'desc', convertToUzs: intent.convertToUzs || !intent.currency, period: period.kind === 'period' ? period.period : fullPeriod };
    }
    if (period.kind !== 'period') return { kind: 'needs_year' };
    return { ...intent, period: period.period };
  }
  private async requestIntent(question: string, url: string, model: string, key: string | undefined, previousPlan?: RawIntent, deadline = Date.now() + 40_000, correction = 'Plan was unsupported or failed grounding.'): Promise<RawIntent> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (Date.now() >= deadline) throw new Error('Model request deadline exceeded');
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - Date.now()))),
          body: JSON.stringify({
            model, response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: instructions }, { role: 'user', content: question },
              ...(previousPlan ? [
                { role: 'assistant', content: JSON.stringify(previousPlan) },
                { role: 'user', content: correction + ' Re-read my original question. Match its metric, count, identifiers, product/company text and currency constraints exactly. Use a supported operation if it expresses the request. Never drop filters to make it work. If genuinely unsupported, keep unsupported. JSON only.' },
              ] : []),
            ],
          }),
        });
      } catch (error) {
        this.logger.warn({ event: 'llm_request_failed', attempt, reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network' });
        if (attempt === 2) throw new Error('Model connection unavailable');
        await delay(400);
        continue;
      }
      if (!response.ok) {
        this.logger.warn({ event: 'llm_request_failed', attempt, reason: 'http', status: response.status });
        await response.body?.cancel();
        if (response.status < 500 || attempt === 2) throw new Error(`Model HTTP ${response.status}`);
        await delay(400);
        continue;
      }
      try {
        const payload: unknown = await response.json();
        const { choices } = envelope.parse(payload);
        const raw: unknown = JSON.parse(choices[0].message.content);
        return querySchema.parse(raw);
      } catch {
        this.logger.warn({ event: 'llm_request_failed', attempt, reason: 'invalid_response' });
        if (attempt === 2) throw new Error('Model response could not be validated');
        await delay(400);
      }
    }
    throw new Error('Model unavailable');
  }

}
