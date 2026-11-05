export type LimitationReason = 'exclusion' | 'unavailable_facts' | 'mixed_currencies' | 'unsupported_filter' | 'invented_answer' | 'external_link';

export function detectLimitation(question: string): LimitationReason | undefined {
  if (/https?:\/\//iu.test(question)) return 'external_link';
  const text = question.toLowerCase().replace(/['’ʻ]/gu, '‘').replace(/[«“"]([^»”"]{1,120})[»”"]/gu, ' ');
  if (/(?:tashqari|исключая|исключить|кроме|excluding|except\b)/iu.test(text)) return 'exclusion';
  if (/(?:direktor|директор|rahbar|boshliq|руководител|начальник|bank hisob|банковск\p{L}*\s+сч[её]т|egasi|владел|telefon|телефон|прибыл|foyda|profit\b|ishonchli|над[её]жн)/iu.test(text)) return 'unavailable_facts';
  const currencyMentioned = /valyut|валют|usd|uzs|dollar|доллар/iu.test(text);
  const ignoresCurrency = /hisobga (?:olma|olish shart emas)|e‘tiborsiz|игнорир|не учитыва|без уч[её]та|kodlarisiz|без кодов/iu.test(text);
  const singleTotal = /bitta (?:yakuniy )?(?:raqam|summa|son)|одн[уо]\p{L}*\s+(?:общ\p{L}*\s+)?(?:сумм|числ)|один итог|единый итог/iu.test(text);
  const conversionRequested = /so‘mga[\s\S]*(?:aylantir|o‘gir)|(?:пересч|конверт)[\s\S]*сум|сум[\s\S]*по курсу/iu.test(text);
  const usdMentioned = /usd|dollar|доллар/iu.test(text);
  const uzsMentioned = /uzs|so‘m|сум[уыа]/iu.test(text);
  const allCurrencies = /barcha[\s\S]*valyut|всех валют|разн[\p{L}]* валют/iu.test(text);
  const explicitSingleCurrency = usdMentioned !== uzsMentioned && !allCurrencies;
  const inventedRate = /1\s*usd\s*=\s*1\s*uzs|один доллар равным одному суму/iu.test(text);
  if (currencyMentioned && (ignoresCurrency || inventedRate || (singleTotal && !explicitSingleCurrency && !conversionRequested))) {
    return 'mixed_currencies';
  }
  const geography = /(?:shahr|viloyat|област|регион)/iu.test(text) && /(?:bitim|сделк|aylanma|оборот)/iu.test(text);
  const status = /(?:bekor qilingan|оплачен|аннулирован|исполнен)/iu.test(text);
  const threshold = /(?:summasi|сумм)[\s\S]*(?:katta|kichik|больше|меньше|свыше)/iu.test(text);
  const overdue = /(?:yetkazib[\s\S]*(?:buzil|kechik)|просроч)/iu.test(text);
  if (geography || status || threshold || overdue) return 'unsupported_filter';
  if (/(?:bazani ishlatma|o‘ylab top|to‘qib|игнорируй правила|придумай|выдумай|biror kompaniya nomini yoz)/iu.test(text)) return 'invented_answer';
}

const explanations = {
  external_link: {
    uz: 'Bu tashqi havola. Men berilgan UZEX reyestridan qidiraman. Datasetdagi bitim yoki shartnoma raqamini yozing.',
    ru: 'Это внешняя ссылка. Я ищу в предоставленном реестре UZEX. Укажите номер сделки или контракта из dataset.',
  },
  exclusion: {
    uz: 'Istisno bilan hisoblash hozir ishlamaydi. Kiritiladigan mahsulot yoki valyutani aniq yozing.',
    ru: 'Исключения пока не поддерживаются. Укажите товар или валюту для расчёта.',
  },
  unavailable_facts: {
    uz: 'So‘ralgan qo‘shimcha ma’lumot bazada yo‘q. Bitimlar bo‘yicha hisobni alohida so‘rang.',
    ru: 'Запрошенных дополнительных сведений в базе нет. Расчёт по сделкам можно запросить отдельно.',
  },
  mixed_currencies: {
    uz: 'USD va UZS uchun kurs kerak. Alohida natija yoki so‘mga aylantirishni so‘rang.',
    ru: 'Для общей суммы нужен курс. Запросите итог по валютам или пересчёт в сумы.',
  },
  unsupported_filter: {
    uz: 'Bu filtr hozir qo‘llanmaydi. Sana, mahsulot yoki STIR bilan so‘rab ko‘ring.',
    ru: 'Этот фильтр пока не поддерживается. Попробуйте запрос по дате, товару или ИНН.',
  },
  invented_answer: {
    uz: 'Aniq savolingizni yozing. Javobni bazadagi ma’lumotdan olaman.',
    ru: 'Задайте конкретный вопрос. Ответ будет основан на данных базы.',
  },
} satisfies Record<LimitationReason, { uz: string; ru: string }>;

export function limitationExplanation(reason: LimitationReason, russian: boolean): string {
  return explanations[reason][russian ? 'ru' : 'uz'];
}
