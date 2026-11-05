# UZEX bitimlari yordamchisi

NestJS veb-ilovasi va Telegram bot. Rasmiy 500 000 bitim DuckDB bazasida saqlanadi. OpenRouter savolni tekshiriladigan so‘rovga aylantiradi. SQL raqamlarni hisoblaydi, kompaniya va broker nomlari katalogdan olinadi.

## Lokal ishga tushirish

Node.js 26 talab qilinadi.

```sh
npm ci
npm run build
cp -n .env.example .env
```

`.env` ichiga `OPENROUTER_API_KEY` va `TELEGRAM_BOT_TOKEN` kiriting. Kalitlarni Git’ga qo‘shmang. Database va raw CSV fayllari Git repositoriyga kiritilmagan. Rasmiy datasetni yuklab, quyidagi import bosqichini bajaring. Lokal tayyor baza mavjud bo‘lsa, qayta import shart emas.

```sh
npm start
```

Veb-sahifa http://127.0.0.1:3000 manzilida ochiladi. Alohida terminalda Telegram botni ishga tushiring:

```sh
npm run telegram
```

Bir token uchun bitta bot jarayoni ishlasin. Botdagi savollar veb-ilova ishlatayotgan hisoblash xizmatiga boradi.

## Rasmiy datasetni import qilish

Dataset papkasi — https://drive.google.com/drive/folders/1BcjcDi1N0ym1MwX3OrgZYfDqsWLOkVeL

```sh
unzip /absolute/path/uzex_spot_data.zip -d data/raw
npm run import -- --official data/raw/uzex_spot_data
```

Import beshta deals_*.csv fayli, contracts.csv, participants.csv, brokers.csv va usd_rates.csv fayllarini oladi. Kalitlar takrorlanishi va majburiy qiymatlar tekshiriladi. Baza vaqtinchalik faylda yaratiladi va muvaffaqiyatli tugagach almashtiriladi. Yangilangan bazani o‘qish uchun servisni qayta ishga tushiring.

Eski sinov CSV formati ham ishlaydi: deal_date,amount,currency. `npm run import -- sample.csv` orqali import qilinadi. Kengaytirilgan imkoniyatlar uchun rasmiy import talab qilinadi.

## Savollar

- 2025-yilda nechta bitim bo‘lgan?
- 2025-yil yanvar oyida jami aylanma qancha?
- 2025-02-01 dan 2025-03-15 gacha nechta bitim bo‘lgan?
- 2025-yilda sement bo‘yicha top 3 ta sotuvchi kim?
- 2025 yil BK001 broker qatnashgan bitimlar soni qancha?
- 2025 yil sotuvchi STIR 984713635 nechta bitim qilgan?
- 2025 yil barcha bitimlar aylanmasini USDni kunlik kurs orqali so‘mga o‘girib hisobla
- 2025 yilda sement savdo hajmi qancha?
- 2025 yil sementning o‘rtacha birlik narxi qancha?
- Shartnoma 100008 haqida
- BK001 broker haqida ma’lumot
- STIR 984713635 kompaniya haqida ma’lumot
- 100001 raqamli bitim haqida ma’lumot
- Топ-5 продавцов по обороту цемента за 2025 год?

Ruscha erkin savollar ham LLM orqali talqin qilinadi. Savolda yil yoki aniq davr kerak. Bot yilni so‘raganda keyingi “2025” javobi oldingi savolga bog‘lanadi. Telegram’da bu kontekst 10 daqiqa saqlanadi.

## Hisoblash va chegaralar

Davr kod tomonidan ajratiladi: kalendar yili, nomlangan oy, ISO yoki DD.MM.YYYY ko‘rinishidagi bir sana yoki ikki sana. Oraliqning ikkala cheti hisobga kiradi. Ikki alohida yilni taqqoslash, choraklar va nisbiy sanalar hozir aniqlashtirish talab qiladi.

2026-yil reyestri 30-oktabrgacha. Javobda so‘ralgan davr hamda datasetning mavjud davri ko‘rsatiladi. Bo‘sh natijada mavjud bo‘lmagan fakt yaratilmaydi.

- Hajm = miqdor × lot. Turli birliklar alohida jamlanadi.
- Birlik narxi = jami summa / jami hajm. Bu hajm bilan og‘irliklangan narx.
- Summalar odatda valyuta bo‘yicha alohida. So‘mga aylantirish so‘ralsa, USD bitimlari bitim kunidagi kursga ko‘paytiriladi.
- Bitim holati bo‘yicha alohida filtr so‘ralmaganida reyestrdagi barcha holatlar hisobga kiradi.
- “sement”, “цемент”, “цемента” nomida “цемент” bor mahsulotlarni birga hisoblaydi. Boshqa mahsulotlarda katalogdagi to‘liq nom talab qilinadi.
- Kompaniya nomi bir nechta yozuvga mos kelsa, STIR so‘raladi.
- Model raqam yoki javob yozmaydi. Biroq erkin savolni tushunish model sifatiga bog‘liq. Noaniq yoki qo‘llanmaydigan shartlarda bot javobni aniqlashtirishni so‘raydi.
- OpenRouter free xizmatida limit va provayder xatolari bo‘lishi mumkin. Aniq namunalar LLM chaqiruvisiz ishlaydi.

## OpenRouter

`OPENROUTER_API_KEY` mavjud bo‘lsa, model `OPENROUTER_MODEL` orqali tanlanadi. `.env.example` faylida pullik `deepseek/deepseek-v4.1-flash-1017` tanlangan. Sozlama berilmasa, kod `openrouter/free` ni ishlatadi. `OPENROUTER_MODEL` bilan boshqa model tanlash mumkin. Kalit bo‘sh bo‘lsa, ixtiyoriy `LLM_CHAT_URL`, `LLM_MODEL`, `LLM_API_KEY` ishlatiladi.

## Serverga joylash

Docker konfiguratsiyasi API va Telegram jarayonlarini alohida ishga tushiradi.

```sh
docker compose up -d --build
docker compose logs -f
```

Buning oldidan `.env` va tayyor `data/uzex.duckdb` kerak. API faqat serverning 127.0.0.1:3000 manzilida ochiladi. Telegram polling uchun public HTTP endpoint kerak emas. Veb-sayt topshirilsa, hostingda HTTPS reverse proxy va domen sozlang.

Docker image’ga .env va tokenlar kirmaydi. Ular ishga tushish vaqtida beriladi. `GET /health` bazadan so‘rov qilib tayyorlikni tekshiradi.

## Topshirish

Rasmiy sahifa: https://hackathon.uzex.uz/saralash/
Forma: https://forms.gle/5ALB3PrWdKf6TTCf8

Bot: https://t.me/uzextaskbot

Jamoa a’zolari, rahbar telefoni va yechim tavsifini formaga kiriting. Deadline — 2026-yil 5-noyabr 18:00, Toshkent vaqti. Topshirishdan oldin botni boshqa Telegram akkauntidan tekshiring.

## Qayta tekshirish

Ishlayotgan API va rasmiy baza bilan `npm run verify` 48 ta tayyor savolni tekshiradi. Kutilgan sonlar CSV’dan mustaqil hisoblangan. Buyruq ayrim savollar uchun OpenRouter bepul limitidan foydalanadi. Texnik xizmat xatosi ham FAIL sifatida ko‘rsatiladi.

## Qo‘llanmaydigan shartlar va xizmat xatolari

Istisno (“tashqari”), datasetda yo‘q qo‘shimcha faktlar, qo‘llanmaydigan filtrlar va valyutalarni kurssiz qo‘shish talabi model chaqirilishidan oldin tekshiriladi. Shu holatlar uchun aniq tushuntirish qaytariladi. Bu til qoidalari konservativ va barcha mumkin bo‘lgan ifodalar to‘g‘riligini kafolatlamaydi.

Modelning vaqtinchalik tarmoq, timeout, 5xx yoki noto‘g‘ri JSON xatosida bitta qayta urinish bor. Har urinish 20 soniyagacha. Rate limit va autentifikatsiya xatolari darhol qayta urinilmaydi. Telegram backend javobini 50 soniyagacha kutadi. Diagnostikaga kalit yoki xabar matni yozilmaydi.

`npm test` hisoblashdan oldingi cheklovlar va model xatosida qayta urinish regressiyalarini tekshiradi.

## Eng qimmat lotlar va tashqi havolalar

“Eng qimmat lotlar” so‘rovi reyestrdagi eng katta jami summali bitimlarni ko‘rsatadi. Bu birlik yoki bitta lot narxi bo‘yicha reyting emas. Davr yozilmasa, mavjud datasetning butun davri olinadi. Taqqoslash uchun USD summalari bitim kunidagi kurs bilan UZS’ga aylantiriladi va javobda bu asos ko‘rsatiladi.

Tashqi URL raqamlari datasetdagi bitim yoki shartnoma ID’si sifatida talqin qilinmaydi. Bot tashqi lot sahifasini yuklamaydi va berilgan reyestr doirasini tushuntiradi. Masalan, uzex.uz/trade/offer/552 havolasi shunchaki 552 raqamli dataset kartochkasi deb olinmaydi.
