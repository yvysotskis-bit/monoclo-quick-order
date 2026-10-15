# Нова пошта API: підключення й автентифікація

Джерело: портал розробників Нової пошти, https://developers.novaposhta.ua/ (розділ «Інтерфейси API», «Коди помилок»).
Це стислі робочі нотатки проєкту, а не копія документації. Перевіряйте деталі на офіційному порталі.

## Точка входу
- JSON: `https://api.novaposhta.ua/v2.0/json/` (XML: `https://api.novaposhta.ua/v2.0/xml/`).
- Метод HTTP: POST (допускається й GET). Формат у адресі пишеться **малими літерами**.
- Тіло запиту: `{ "apiKey", "modelName", "calledMethod", "methodProperties": {...} }`.
- У документації назви моделей із суфіксом `General` (`InternetDocumentGeneral`, `AddressGeneral`, `CommonGeneral`, `TrackingDocumentGeneral`). У проєкті зараз використовуються старіші назви (`InternetDocument`, `Address`, `AddressGeneral`); вони працюють, але це варто пам'ятати при змінах.

## API-ключ
- Створюється в бізнес-кабінеті: «Налаштування» → «Безпека» → «Створити ключ». У проєкті лежить у змінній оточення `NOVA_POSHTA_API_KEY` (лише на сервері Render, у код не потрапляє).
- Відомі помилки ключа: `API key expired`, `ApiKey auth failed`, `ApiKey does not exist`, `apiKey is empty`.

## Відповіді
- **HTTP-код завжди 200, навіть при логічних помилках.** Успіх визначається полем `success` у тілі; помилки в `errors` (текст) та `errorCodes`. У проєкті це враховано (`server/novaposhta.js`).
- Крім `data` приходять `warnings`, `info`, `messageCodes`, `warningCodes`. Попередження (наприклад, `Cost is changed`, `DateTime is set to current`) не є помилкою: проєкт показує їх менеджеру в повідомленні про ТТН.

## Ліміти
- Відповідь `To many requests` отримано на практиці. Офіційного числового ліміту в наданих сторінках немає. У проєкті: повтор із паузою 2 с до 3 разів для створення ТТН; кеш підказок 10 хв; довідник відділень кешується на 6 год.

## Де це в коді
`server/novaposhta.js` (`call`), `server/ttn.js`.
