import 'reflect-metadata';
import { BadRequestException, Body, Controller, Get, Header, Module, Post, ServiceUnavailableException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { formatNumber } from './format.js';
import { Analytics } from './analytics.js';
import { z } from 'zod';
import { limitationExplanation } from './limitations.js';
import { QuestionParser } from './question-parser.js';

const input = z.strictObject({ question: z.string().trim().min(1).max(300), previousQuestion: z.string().trim().min(1).max(300).optional() });
@Controller()
class Questions {
  constructor(private readonly analytics: Analytics, private readonly parser: QuestionParser) {}

  @Get('health')
  async health() {
    const result = await this.analytics.annualSummary({ kind: 'count', period: { from: '2022-01-03', to: '2026-10-30' } });
    return { status: result.kind === 'summary' ? 'ok' : 'unavailable' };
  }

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  home() {
    return `<!doctype html><html lang="uz"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>UZEX | Bitimlar tahlili</title>
<style>body{max-width:42rem;margin:10vh auto;padding:0 1.25rem;font:1rem/1.6 system-ui;color:#162c2a;background:#f4faf8}input,button{font:inherit;padding:.65rem}input{width:100%;box-sizing:border-box}button{margin-top:.7rem}output{display:block;white-space:pre-wrap;margin-top:1.2rem}</style>
<h1>UZEX bitimlari</h1>
<p>Savol bering / Задайте вопрос</p>
<form><input aria-label="Savol / Вопрос" maxlength="300" required placeholder="2025-yilda nechta bitim bo‘lgan?"><button>So‘rash / Спросить</button></form>
<p>2025-yil yanvar oyida jami aylanma qancha?<br>2025-02-01 dan 2025-03-15 gacha nechta bitim bo‘lgan?<br>Shartnoma 100008 haqida<br>Сколько сделок было в 2025 году?<br>2025-yilda sement bo‘yicha aylanmasi eng katta 5 ta sotuvchi kim?<br>Топ-5 продавцов по обороту цемента за 2025 год?</p>
<output aria-live="polite"></output>
<script>
const form = document.querySelector('form'), output = document.querySelector('output'), button = form.querySelector('button');
let pendingQuestion;
form.onsubmit = async (event) => {
  event.preventDefault();
  const question = form.querySelector('input').value;
  button.disabled = true;
  output.textContent = '…';
  try {
    const response = await fetch('/questions', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({question, previousQuestion:pendingQuestion})});
    const result = await response.json();
    output.textContent = result.answer ?? result.message;
    if (response.ok) pendingQuestion = result.kind === 'needs_year' ? (pendingQuestion ?? question) : undefined;
  } catch {
    output.textContent = 'Ulanishda xato / Ошибка подключения';
  } finally {
    button.disabled = false;
  }
};
</script></html>`;
  }

  @Post('questions')
  async answer(@Body() body: unknown) {
    const parsed = input.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Savol 1–300 belgidan iborat bo‘lishi kerak / Введите от 1 до 300 символов.');

    let { question } = parsed.data;
    const social = question.toLowerCase().replace(/['’ʻ]/gu, '‘').replace(/[!?.,]+$/u, '').replace(/\s+/gu, ' ').trim();
    const greeting = /^(hi|hello|hey|salom|assalomu alaykum|привет|здравствуйте|добрый день)$/u.test(social);
    const help = /^(help|yordam|nima qila olasan|nima qila olasiz|qanday savol bersam bo‘ladi|(?:sendan|sizdan) (?:nima haqida|qanday) savol so‘rasam bo‘ladi|nima haqida so‘rasam bo‘ladi|qanday savollar bera olaman|what can i ask|помощь|о ч[её]м можно спросить|какие вопросы можно задать|что ты умеешь|что вы умеете)$/u.test(social);
    if (greeting || help) {
      const ru = /[а-яё]/iu.test(social);
      const answer = greeting
        ? (ru ? 'Здравствуйте! Что хотите узнать о сделках UZEX?' : 'Salom! UZEX bitimlari bo‘yicha nima bilmoqchisiz?')
        : (ru ? 'Ищу сделки, оборот и рейтинги в предоставленном реестре. Например: «Сколько сделок было в 2025 году?»' : 'Berilgan reyestrdan bitimlar, aylanma va reytinglarni topaman. Masalan: «2025-yildagi eng qimmat 5 bitim».');
      return { kind: 'conversation', answer };
    }
    if (/^(rahmat|katta rahmat|thanks|thank you|спасибо|благодарю)$/u.test(social)) {
      return { kind: 'conversation', answer: /[а-яё]/iu.test(social) ? 'Пожалуйста!' : 'Marhamat!' };
    }
    const yearReply = /^(?:19|20)\d{2}(?:[- ]?yil(?:da)?| году| год)?[.!?]?$/iu.test(question);
    if (parsed.data.previousQuestion && yearReply) {
      const previous = parsed.data.previousQuestion;
      if (/\b(?:19|20)\d{2}\b/u.test(previous)) {
        return { kind: 'unsupported', answer: 'Savolni yil bilan birga yozing / Напишите вопрос вместе с годом.' };
      }
      const year = question.match(/\d{4}/u)?.[0];
      question = /[а-яё]/iu.test(previous)
        ? previous.replace(/[?.!]+$/u, '') + ` в ${year} году`
        : `${year}-yilda ` + previous.replace(/[?.!]+$/u, '');
    }
    const russian = !/\byilda\b/iu.test(question) && /[а-яё]/iu.test(question);
    const query = await this.parser.parse(question).catch(() => {
      throw new ServiceUnavailableException(russian ? 'Не удалось обработать вопрос. Повторите попытку.' : 'Savolni tahlil qilib bo‘lmadi. Qayta urinib ko‘ring.');
    });
    if (query.kind === 'limitation') {
      return { kind: 'limitation', reason: query.reason, answer: limitationExplanation(query.reason, russian) };
    }
    if (query.kind === 'needs_year') {
      return { kind: query.kind, answer: russian ? 'За какой год нужен расчёт?' : 'Qaysi yil bo‘yicha hisob kerak?' };
    }
    if (query.kind === 'unsupported') {
      return { kind: query.kind, answer: russian ? 'Попробуйте задать вопрос иначе.' : 'Savolni boshqacha yozib ko‘ring.' };
    }
    const result = await this.analytics.annualSummary(query).catch(() => {
      throw new ServiceUnavailableException(russian ? 'База сделок сейчас недоступна.' : 'Bitimlar bazasi hozir mavjud emas.');
    });
    if (result.kind === 'outside_coverage') {
      return { kind: result.kind, answer: russian ? 'Этот год отсутствует в загруженных данных.' : 'Yuklangan ma’lumotlarda bu yil yo‘q.' };
    }
    if (result.kind === 'ambiguous') {
      const names = result.rows.map(row => `${row.name} · STIR ${row.tax_id}`).join('\n');
      return { kind: 'clarify', answer: (russian ? 'Найдено несколько компаний. Укажите ИНН.\n' : 'Bir nechta kompaniya topildi. STIRni yozing.\n') + names };
    }
    if (result.kind === 'lookup') {
      if (!result.rows.length) return { kind: 'no_data', answer: russian ? 'Запись не найдена.' : 'Yozuv topilmadi.' };
      const uzLabels: Record<string, string> = {
        'Валюта': 'Valyuta', 'Базисная цена': 'Boshlang‘ich narx', 'Единица измерения': 'Birlik',
        'Лот': 'Lot hajmi', 'ИНН продавца': 'Sotuvchi STIR',
        'Номер контракта': 'Shartnoma raqami', 'Наименование продукта': 'Mahsulot nomi',
        'ИНН': 'STIR', 'Наименование': 'Nomi', 'Код брокера': 'Broker kodi', 'Регион': 'Hudud',
        'Вид деятельности': 'Faoliyat turi', 'Роль': 'Roli', 'Плательщик НДС': 'QQS to‘lovchi',
        deal_id: 'Bitim raqami', contract_id: 'Shartnoma raqami', deal_date: 'Bitim sanasi',
        amount: 'Bitim summasi', currency: 'Valyuta', product_name: 'Mahsulot',
        seller_tax_id: 'Sotuvchi STIR', buyer_tax_id: 'Xaridor STIR', quantity: 'Lotlar soni',
        lot: 'Lot hajmi', unit: 'O‘lchov birligi', seller_broker: 'Sotuvchi brokeri',
        buyer_broker: 'Xaridor brokeri', region: 'Hudud', status: 'Bitim holati',
      };
      const ruLabels: Record<string, string> = {
        deal_id: 'Номер сделки', contract_id: 'Номер контракта', deal_date: 'Дата сделки',
        amount: 'Сумма сделки', currency: 'Валюта', product_name: 'Товар',
        seller_tax_id: 'ИНН продавца', buyer_tax_id: 'ИНН покупателя', quantity: 'Количество лотов',
        lot: 'Размер лота', unit: 'Единица измерения', seller_broker: 'Брокер продавца',
        buyer_broker: 'Брокер покупателя', region: 'Регион', status: 'Состояние сделки',
      };
      const labels = russian ? ruLabels : uzLabels;
      const compactFields = {
        lookup_company: ['ИНН', 'Наименование', 'Регион', 'Роль'],
        lookup_broker: ['Код брокера', 'Наименование', 'ИНН', 'Регион'],
        lookup_contract: ['Номер контракта', 'Наименование продукта', 'Валюта', 'Базисная цена', 'Единица измерения', 'Лот', 'ИНН продавца'],
        lookup_deal: ['deal_id', 'contract_id', 'deal_date', 'product_name', 'amount', 'currency', 'seller_tax_id', 'buyer_tax_id', 'status'],
      };
      const detailed = /batafsil|to[‘’'ʻ]liq|подробн|все поля|hamma maydon|marka|марка|сорт|lot|лот|miqdor|количество|o‘lcham|размер|адрес|manzil|срок|muddat/iu.test(question);
      const selected = 'id' in query ? compactFields[query.kind] : [];
      const fields = Object.entries(result.rows[0])
        .filter(([field]) => detailed || selected.includes(field))
        .filter(([, value]) => value !== null && value !== '').map(([name, value]) => `${labels[name] ?? name} — ${(['amount', 'quantity', 'lot', 'Базисная цена', 'Лот'].includes(name) ? formatNumber(value) : String(value))}`);
      return { kind: 'answer', answer: [...fields, 'UZEX'].join('\n') };
    }
    if (!result.rows.length || result.rows[0]?.deals === '0') {
      return { kind: 'no_data', answer: russian ? 'По этим условиям сделки не найдены.' : 'Bu shartlarga mos bitim topilmadi.' };
    }
    if ('id' in query) throw new Error('Unexpected lookup response');
    const lines = result.rows.map(({ deals, currency, amount, rank, name, entity, unit, volume }) => {
      const count = russian ? `Сделок: ${formatNumber(deals)}` : `Bitimlar soni: ${formatNumber(deals)}`;
      if ('limit' in query) {
        const label = query.kind !== 'top_products' && name ? `${name} (${entity})` : entity;
        return `${rank}. ${label} · ${formatNumber(amount)} ${currency}`;
      }
      if (query.kind === 'count') return count;
      if (query.kind === 'volume') return `${formatNumber(volume)} ${unit}`;
      if (query.kind === 'unit_price') return `${formatNumber(amount)} ${currency}/${unit}`;
      const label = query.kind === 'average_amount'
        ? (russian ? 'Средняя сумма сделки' : 'O‘rtacha bitim summasi')
        : (russian ? 'Оборот' : 'Aylanma');
      return `${label}: ${formatNumber(amount)} ${currency}`;
    });
    const wholeYear = query.period.from.endsWith('-01-01') && query.period.to.endsWith('-12-31') &&
      query.period.from.slice(0, 4) === query.period.to.slice(0, 4);
    const periodLabel = wholeYear ? query.period.from.slice(0, 4) : `${query.period.from} — ${query.period.to}`;
    const sourceName = query.kind === 'top_deals' ? (russian ? 'Предоставленный реестр' : 'Berilgan reyestr') : 'UZEX';
    const source = `${sourceName} · ${periodLabel}`;
    const coverage = 'coverage' in result ? result.coverage : undefined;
    const availableFrom = coverage && query.period.from < String(coverage.first_date) ? String(coverage.first_date) : query.period.from;
    const availableTo = coverage && query.period.to > String(coverage.last_date) ? String(coverage.last_date) : query.period.to;
    const partial = availableFrom !== query.period.from || availableTo !== query.period.to;
    const filter = [
      partial && `${russian ? 'Данные' : 'Ma’lumot'}: ${availableFrom} — ${availableTo}`,
      query.kind === 'top_deals' && (russian ? 'По общей сумме сделки' : 'Jami bitim summasi bo‘yicha'),
      query.convertToUzs && (russian ? 'USD → UZS по курсу дня сделки' : 'USD → UZS: bitim kunidagi kurs'),
      query.contractId && `${russian ? 'Контракт' : 'Shartnoma'} ${query.contractId}`,
      query.brokerCode && `Broker ${query.brokerCode}`,
      query.sellerName,
      query.buyerName,
      query.currency,
      query.product,
      query.sellerTaxId && `${russian ? 'ИНН продавца' : 'Sotuvchi STIR'} ${query.sellerTaxId}`,
      query.buyerTaxId && `${russian ? 'ИНН покупателя' : 'Xaridor STIR'} ${query.buyerTaxId}`,
    ].filter(Boolean).join(' · ');
    return { kind: 'answer', answer: [...lines, source, filter].filter(Boolean).join('\n') };
  }
}

@Module({ controllers: [Questions], providers: [Analytics, QuestionParser] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000, process.env.HOST ?? '127.0.0.1');
}

void bootstrap();
