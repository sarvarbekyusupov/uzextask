import { setTimeout as delay } from 'node:timers/promises';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token || !/^\d+:[\w-]+$/.test(token)) throw new Error('Set TELEGRAM_BOT_TOKEN in .env');
const backend = process.env.UZEX_QUESTIONS_URL ?? 'http://127.0.0.1:3000/questions';

async function telegram(method, body = {}) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    });
  } catch {
    throw new Error(`Telegram ${method}: connection failed`);
  }
  const data = await response.json();
  if (!data.ok) throw new Error(`Telegram ${method}: HTTP ${response.status}, code ${data.error_code}`);
  return data.result;
}

const bot = await telegram('getMe');
const webhook = await telegram('getWebhookInfo');
if (webhook.url) throw new Error('This bot already has a webhook. Polling requires an empty webhook.');
console.log(`Telegram bot ready: @${bot.username}`);

let offset;
const pendingQuestions = new Map();
while (true) {
  try {
    const updates = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
    for (const update of updates) {
      offset = update.update_id + 1;
      const message = update.message;
      if (message?.chat?.type !== 'private' || typeof message.text !== 'string') continue;
      const question = message.text.trim();
      const russian = /[а-яё]/iu.test(question);
      for (const [chat, pending] of pendingQuestions) {
        if (pending.expires < Date.now()) pendingQuestions.delete(chat);
      }
      const previousQuestion = pendingQuestions.get(message.chat.id)?.question;
      let answer;
      if (/^\/(start|help)(?:@\w+)?(?:\s|$)/u.test(question)) {
        pendingQuestions.delete(message.chat.id);
        answer = 'Salom! UZEX bitimlari bo‘yicha savolingizni yozing.\nЗадайте вопрос о сделках UZEX.';
      } else if (!question || question.length > 300) {
        answer = russian ? 'Введите вопрос до 300 символов.' : '300 belgigacha savol yozing.';
      } else {
        void telegram('sendChatAction', { chat_id: message.chat.id, action: 'typing' }).catch(() => undefined);
        try {
          const response = await fetch(backend, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, previousQuestion }),
            signal: AbortSignal.timeout(50_000),
          });
          const result = await response.json();
          if (!response.ok || typeof result.answer !== 'string') throw new Error('Backend unavailable');
          answer = result.answer;
          if (result.kind === 'needs_year') {
            if (pendingQuestions.size >= 1000) pendingQuestions.clear();
            pendingQuestions.set(message.chat.id, { question: previousQuestion ?? question, expires: Date.now() + 10 * 60_000 });
          } else {
            pendingQuestions.delete(message.chat.id);
          }
        } catch {
          answer = russian ? 'Сервис временно недоступен. Попробуйте ещё раз.' : 'Xizmat vaqtincha ishlamayapti. Qayta urinib ko‘ring.';
        }
      }
      for (let index = 0; index < answer.length; index += 3900) {
        await telegram('sendMessage', { chat_id: message.chat.id, text: answer.slice(index, index + 3900) });
      }
    }
  } catch (error) {
    console.error(error.message);
    if (/code (401|409)$/.test(error.message)) process.exit(1);
    await delay(3000);
  }
}
