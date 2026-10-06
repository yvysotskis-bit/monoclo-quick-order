import crypto from 'node:crypto';

// Plata by mono: https://api.monobank.ua/docs/acquiring.html
const BASE_URL = 'https://api.monobank.ua/api/merchant';

export function createMonobank({ token, fetchFn }) {
  let publicKeyPem = null;

  async function call(method, path, body) {
    const res = await fetchFn(`${BASE_URL}${path}`, {
      method,
      headers: { 'X-Token': token, 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* не JSON */ }
    if (!res.ok) {
      // Токен у помилку не потрапляє: лише шлях і відповідь банку
      throw new Error(`Monobank ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return data;
  }

  // Відкритий ключ банку для перевірки підпису вебхуків (base64 від PEM)
  async function publicKey(force = false) {
    if (!publicKeyPem || force) {
      const { key } = await call('GET', '/pubkey');
      const decoded = Buffer.from(String(key), 'base64').toString('utf8');
      publicKeyPem = decoded.includes('BEGIN') ? decoded : String(key);
    }
    return publicKeyPem;
  }

  return {
    // amount у копійках
    async createInvoice({ amount, reference, destination, redirectUrl, webHookUrl, validity }) {
      const data = await call('POST', '/invoice/create', {
        amount,
        ccy: 980,
        merchantPaymInfo: { reference, destination },
        redirectUrl,
        webHookUrl,
        validity,
        paymentType: 'debit',
      });
      if (!data.invoiceId || !data.pageUrl) throw new Error('Monobank не повернув посилання на оплату');
      return { invoiceId: data.invoiceId, pageUrl: data.pageUrl };
    },

    // Закриває неоплачений рахунок (щоб клієнт не заплатив за старим посиланням). Найкраща спроба: збій не критичний
    async removeInvoice(invoiceId) {
      await call('POST', '/invoice/remove', { invoiceId });
    },

    // Вебхук підписано ECDSA (заголовок X-Sign). Якщо підпис не збігся, один раз оновлюємо ключ банку
    // (він міг змінитися) і перевіряємо ще раз. Без дійсного підпису статусу довіряти не можна.
    async verifyWebhook(rawBody, signature) {
      for (const force of [false, true]) {
        try {
          const pem = await publicKey(force);
          if (crypto.createVerify('SHA256').update(rawBody).verify(pem, String(signature), 'base64')) return true;
        } catch {
          if (force) return false;
        }
      }
      return false;
    },
  };
}
