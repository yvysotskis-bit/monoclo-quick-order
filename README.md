# Monoclo Quick Order

Швидке замовлення («Замовити в 1 клік») для Shopify-магазину Monoclo замість ручного коду в темі.
Замовлення приходить менеджерам у Telegram з кнопками «Взято в роботу» / «Спам».

```
Сторінка товару ──► App block (кнопка) + App embed (попап)      extensions/quick-order
        │ POST /apps/quick-order/submit
        ▼
Shopify App Proxy (підписує запит) ──► server/  (Node 22, без залежностей)
                                         ├─ перевіряє підпис і магазин
                                         ├─ валідує дані, ліміти, захист від дублів і спаму
                                         ├─ бере ціну й наявність із /products/<handle>.js
                                         └─ шле повідомлення в Telegram
```

## Що змінилося порівняно з кодом у темі
- Токен Telegram більше не потрапляє в браузер: він лише в змінних оточення сервера.
- Ціна й наявність перевіряються на сервері, форма не може підмінити суму.
- Один раз вмикається app embed, і кнопка додається блоком на будь-якому шаблоні (худі, футболки…).
- Новий попап: панель справа на десктопі, bottom sheet на мобільному; кнопка неактивна, доки не обрано
  колір/розмір, імʼя й телефон; недоступні розміри перекреслені; залишок; маска телефону +380;
  екран успіху замість зникаючого тосту; запамʼятовує імʼя й телефон.

## Запуск локально

```bash
npm install
npm test                 # тести бекенду
npm run preview          # збирає preview/out/index.html з реальних Liquid-блоків
npm run preview:shots    # E2E у Chromium + скріншоти (preview/out/shots)
```

Прев'ю відкривайте як файл у браузері. Параметри: `?mode=network|soldout|invalid` (помилки відправки),
`?hours=off` (імітація неробочого часу).

## Налаштування

### 1. Telegram
1. У @BotFather: `/revoke`, щоб відкликати **старий токен** (він був у коді теми й у Google Doc), і взяти новий.
2. Заповніть `.env` за зразком `.env.example` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`).
3. Після деплою сервера: `node --env-file=.env scripts/set-telegram-webhook.js`: це вмикає кнопки статусу.

### 2. Shopify
1. Створіть додаток у Shopify Dev Dashboard, тип розповсюдження: custom (один магазин).
2. Підставте `client_id` і адресу сервера в `shopify.app.toml`.
3. Client secret покладіть у `SHOPIFY_API_SECRET` на сервері: ним підписується App Proxy.
4. `shopify app deploy`, потім встановіть додаток на магазин `SHOPIFY_SHOP`.
5. Online Store → Themes → Customize → **App embeds** → увімкніть **Quick Order popup** і заповніть тексти/години.
6. На шаблоні товару: Product information → Add block → Apps → **Quick Order button**. Повторіть для кожного
   шаблону товару (худі тощо). Старий код (`show_quick_order`, `{% render 'quick-order' %}`) після перевірки можна прибрати.

### 3. Хостинг
Сервер без залежностей: `node server/index.js` (є `Dockerfile`). Підійде Fly.io, Render, Railway або VPS.
Тримайте **один інстанс**: ліміти запитів і захист від дублів зберігаються в памʼяті.

## Змінні оточення
Див. `.env.example`. Обовʼязкові: `SHOPIFY_SHOP`, `SHOPIFY_API_SECRET`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`.

## Події для аналітики
Після успішного замовлення: `document` отримує `quickorder:submitted` (`detail`: order_number, value, currency),
у `dataLayer` (якщо є) додається `{event: 'quick_order'}`. Piksel/GA підключаються на ваш розсуд.

## Відомі обмеження
- Ukrainian-маска телефону (+380); міжнародні номери попап не приймає.
- Кнопка «Подзвонити» в Telegram неможлива (Telegram не дозволяє `tel:` у кнопках), але номер у тексті клікабельний.
- Швидке замовлення не створює Draft Order у Shopify (за потреби додається окремим кроком, як і KeyCRM).
