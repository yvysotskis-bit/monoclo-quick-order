// Подарункові сертифікати «Свій принт».
// Сертифікат продається на сайті звичайним товаром («Подарунковий сертифікат «Свій принт»», варіанти Виріб × Формат),
// замовлення проходить через GetCheckout і потрапляє в KeyCRM. Сервер раз на CERT_POLL_MINUTES переглядає свіжі
// замовлення KeyCRM, на кожен сертифікат створює унікальний код (SP-XXXXXX) і надсилає картку в групу менеджерів:
// код, виріб і сума, формат (електронний - надіслати після повної оплати; друкований - вкласти листівку в посилку)
// і готовий текст для покупця. Погашення - кнопкою в Telegram (з картки сертифіката, з картки заявки «Свій принт»,
// де клієнт вказав код, або після того, як менеджер напише код у групі).
import crypto from 'node:crypto';
import { escapeHtml, formatMoney } from './message.js';
import { customItems } from './custom-print.js';

// Без символів, які легко сплутати (0/O, 1/I/L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
export const CODE_RE = /\bSP-?([A-Z0-9]{6})\b/i;
const PRINTED_EXTRA_UAH = 150;

export function generateCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[bytes[i] % ALPHABET.length];
  return `SP-${code}`;
}

// «sp 7k3f2q», «SP7K3F2Q», «sp-7k3f2q» → «SP-7K3F2Q»; інше → ''
export function normalizeCode(raw) {
  const compact = String(raw || '').toUpperCase().replace(/[\s_–-]+/g, '');
  const m = /^SP([A-Z0-9]{6})$/.exec(compact);
  return m ? `SP-${m[1]}` : '';
}

export function findCode(text) {
  const m = CODE_RE.exec(String(text || ''));
  return m ? `SP-${m[1].toUpperCase()}` : '';
}

// Виріб сертифіката з назви й властивостей товару KeyCRM («Худі / Друкований (+150 ₴)» тощо).
// Порядок важливий: «Футболка дитяча» перевіряємо раніше за «Футболка».
const ITEM_PATTERNS = [
  ['kids', /футболк\S*\s+дитяч|дитяч\S*\s+футболк/i],
  ['hoodie', /худі|hoodie/i],
  ['a3', /постер\s*a3|\ba3\b/i],
  ['a2', /постер\s*a2|\ba2\b/i],
  ['tee', /футболк/i],
];

function lineText(product) {
  const props = Array.isArray(product?.properties) ? product.properties : [];
  return [product?.name, ...props.map((p) => `${p?.name || ''}: ${p?.value || ''}`), product?.offer?.properties?.map?.((p) => p?.value).join(' ')]
    .filter(Boolean).join(' / ');
}

// Рядки замовлення KeyCRM, які є сертифікатами: [{ lineKey, itemKey, itemLabel, amountUah, printed }], по одному на штуку
export function extractCertificates(crmOrder, { match = 'сертифікат', items = customItems() } = {}) {
  const products = Array.isArray(crmOrder?.products) ? crmOrder.products : [];
  const needle = String(match || 'сертифікат').toLowerCase();
  const out = [];
  products.forEach((product, index) => {
    const name = String(product?.name || '');
    if (!name.toLowerCase().includes(needle)) return;
    const text = lineText(product);
    const printed = /друк/i.test(text);
    // Виріб шукаємо спершу у варіанті (властивості), потім у назві (KeyCRM може дописати варіант у назву);
    // якщо не знайшли - сума з ціни рядка
    const variantText = text.slice(name.length);
    const hit = ITEM_PATTERNS.find(([, re]) => re.test(variantText)) || ITEM_PATTERNS.find(([, re]) => re.test(name));
    const itemKey = hit?.[0] || '';
    const item = itemKey ? items[itemKey] : null;
    const unitUah = Number(product?.price) || 0;
    const amountUah = item ? item.priceUah : Math.max(0, unitUah - (printed ? PRINTED_EXTRA_UAH : 0));
    const quantity = Math.min(Math.max(Math.floor(Number(product?.quantity) || 1), 1), 20);
    for (let n = 1; n <= quantity; n += 1) {
      out.push({
        lineKey: `${index}:${n}`,
        itemKey,
        itemLabel: item?.label || 'виріб на вибір',
        amountUah,
        printed,
      });
    }
  });
  return out;
}

const paidUahOf = (o) => {
  const payments = Array.isArray(o?.payments) ? o.payments : [];
  const sum = payments.filter((p) => String(p.status || '').toLowerCase() === 'paid').reduce((s, p) => s + (Number(p.amount) || 0), 0);
  return sum || Number(o?.payments_total) || 0;
};

export function buyerText(cert, storeOrigin) {
  const link = `${storeOrigin}/pages/svii-prynt?cert=${cert.code}#brif`;
  return [
    '🎁 Подарунковий сертифікат MONOCLO «Свій принт»',
    `Код: ${cert.code}`,
    `${cert.item_label} - ${formatMoney(cert.amount_uah * 100)}`,
    '',
    'Як скористатися: заповніть бриф за посиланням (код уже буде вписано) або напишіть менеджеру @manager_monoclo і назвіть код. Ми підготуємо ескіз з вашим фото чи ідеєю, 3 правки безкоштовно.',
    link,
  ].join('\n');
}

export function certificateMessage(cert, { storeOrigin, timezone }) {
  const when = (ms) => new Intl.DateTimeFormat('uk-UA', { timeZone: timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  const lines = [
    `<b>🎁 Подарунковий сертифікат · <code>${escapeHtml(cert.code)}</code></b>`,
    `Виріб: <b>${escapeHtml(cert.item_label)}</b> · ${escapeHtml(formatMoney(cert.amount_uah * 100))}`,
    cert.printed
      ? 'Формат: 🖨 <b>друкований</b> - роздрукуйте листівку з кодом і вкладіть у посилку'
      : 'Формат: 📩 <b>електронний</b> - надішліть текст нижче покупцю <b>після повної оплати</b>',
    `Замовлення: ${escapeHtml(cert.order_label)}${cert.grand_total_uah ? ` · оплачено ${escapeHtml(formatMoney(cert.paid_uah * 100))} з ${escapeHtml(formatMoney(cert.grand_total_uah * 100))}` : ''}`,
  ];
  if (cert.buyer_name || cert.buyer_phone) lines.push(`👤 ${escapeHtml([cert.buyer_name, cert.buyer_phone].filter(Boolean).join(' · '))}`);
  lines.push('', '<b>Текст для покупця:</b>', `<blockquote>${escapeHtml(buyerText(cert, storeOrigin))}</blockquote>`);
  if (cert.status === 'used') {
    lines.push('', `✅ <b>Погашено</b>: ${escapeHtml(cert.used_by || 'менеджер')}, ${escapeHtml(when(cert.used_at))}${cert.used_note ? ` · ${escapeHtml(cert.used_note)}` : ''}`);
  }
  lines.push('', '#сертифікат');
  return lines.join('\n');
}

export const certificateKeyboard = (cert) => ({
  inline_keyboard: [[cert.status === 'used'
    ? { text: '↩️ Скасувати погашення', callback_data: `cert:undo:${cert.code}` }
    : { text: '✅ Погасити сертифікат', callback_data: `cert:use:${cert.code}` }]],
});

// Короткий стан для картки заявки й відповіді в чаті
export function describeCertificate(cert, code) {
  if (!cert) return `🎁 Сертифікат ${code}: ❗️ не знайдено - перевірте код`;
  const base = `🎁 Сертифікат ${cert.code}: ${cert.item_label} · ${formatMoney(cert.amount_uah * 100)}`;
  return cert.status === 'used' ? `${base} · ⚠️ вже погашено (${cert.used_by || 'менеджер'})` : `${base} · ✅ дійсний`;
}

export function createCertificates({ config, store, keycrm, telegram, now, log }) {
  const pollMs = (Number(config.certPollMinutes) || 10) * 60_000;
  const lookbackMs = (Number(config.certLookbackDays) || 3) * 86_400_000;
  const enabled = Boolean(keycrm) && config.certEnabled !== false;
  const items = customItems(config.customPrintPrices);
  const utcStamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  const storeOrigin = config.storeOrigin;

  function uniqueCode() {
    for (let i = 0; i < 20; i += 1) {
      const code = generateCode();
      if (!store.getCertificate(code)) return code;
    }
    throw new Error('Не вдалося згенерувати унікальний код сертифіката');
  }

  // Перегляд свіжих замовлень KeyCRM і видача кодів
  async function poll() {
    if (!enabled) return;
    const nowMs = now().getTime();
    if (nowMs - Number(store.getMeta('cert_polled_at') || 0) < pollMs) return;
    store.setMeta('cert_polled_at', nowMs);
    // Не видаємо коди за замовлення, створені до першого запуску функції (або до CERT_FROM)
    let startMs = Number(store.getMeta('cert_start_at') || 0);
    if (!startMs) { startMs = config.certFrom || nowMs - 86_400_000; store.setMeta('cert_start_at', startMs); }
    const since = Math.max(nowMs - lookbackMs, startMs);
    const sourceIds = config.certSourceIds?.length ? config.certSourceIds : [0];
    for (const sourceId of sourceIds) {
      for (let page = 1; page <= 10; page += 1) {
        const result = await keycrm.listOrders({ sourceId, from: utcStamp(since - 86_400_000), to: utcStamp(nowMs + 86_400_000), page });
        for (const o of result.orders) {
          if (!o?.id) continue;
          const created = Date.parse(String(o.created_at || '').replace(' ', 'T'));
          if (Number.isFinite(created) && created < since) continue;
          const certs = extractCertificates(o, { match: config.certProductMatch, items });
          for (const c of certs) {
            store.insertCertificate({
              code: uniqueCode(),
              crmOrderId: o.id,
              lineKey: c.lineKey,
              itemKey: c.itemKey,
              itemLabel: c.itemLabel,
              amountUah: c.amountUah,
              printed: c.printed,
              orderLabel: `KeyCRM ${o.id}${o.source_uuid ? ` (${String(o.source_uuid).slice(0, 40)})` : ''}`,
              buyerName: String(o.buyer?.full_name || '').slice(0, 80),
              buyerPhone: String(o.buyer?.phone || '').slice(0, 30),
              paidUah: paidUahOf(o),
              grandTotalUah: Number(o.grand_total) || 0,
              createdAt: nowMs,
            });
          }
        }
        if (!result.hasMore) break;
      }
    }
  }

  // Картки нових сертифікатів у групу (з повтором, якщо Telegram був недоступний)
  async function announce() {
    for (const cert of store.certificatesToAnnounce()) {
      try {
        const sent = await telegram.sendText(certificateMessage(cert, { storeOrigin, timezone: config.timezone }), { replyMarkup: certificateKeyboard(cert) });
        store.setCertificateMessage(cert.code, sent.message_id);
        log.log(JSON.stringify({ event: 'certificate_issued', code: cert.code, crm_order: cert.crm_order_id, amount: cert.amount_uah }));
      } catch (err) {
        log.error('certificate announce failed', err.message);
        return;
      }
    }
  }

  async function tick() {
    await poll();
    await announce();
  }

  // Оновлює картку сертифіката (якщо вона є) після погашення чи скасування
  async function refreshCard(cert) {
    if (!cert?.tg_message_id) return;
    await telegram.editHtml({
      messageId: cert.tg_message_id,
      text: certificateMessage(cert, { storeOrigin, timezone: config.timezone }),
      replyMarkup: certificateKeyboard(cert),
    }).catch((e) => log.error('certificate card update failed', e.message));
  }

  // Кнопки cert:use:CODE / cert:undo:CODE
  async function callback(query, actor) {
    const m = /^cert:(use|undo):(SP-[A-Z0-9]{6})$/.exec(query.data || '');
    if (!m) return false;
    const [, action, code] = m;
    const nowMs = now().getTime();
    const before = store.getCertificate(code);
    let answer;
    if (!before) answer = 'Сертифікат не знайдено';
    else if (action === 'use') {
      answer = store.redeemCertificate(code, { actor, at: nowMs, note: '' }) ? `Погашено: ${code}` : `Вже погашено раніше (${before.used_by || 'менеджер'})`;
    } else {
      answer = store.unredeemCertificate(code) ? `Погашення скасовано: ${code}` : 'Сертифікат не був погашений';
    }
    const cert = store.getCertificate(code);
    await refreshCard(cert);
    // Кнопка не на картці сертифіката (відповідь у чаті чи під заявкою) - оновлюємо і її
    if (cert && query.message?.message_id !== cert.tg_message_id) {
      await telegram.editHtml({
        messageId: query.message.message_id,
        text: escapeHtml(describeCertificate(cert, code)),
        replyMarkup: certificateKeyboard(cert),
      }).catch(() => {});
    }
    await telegram.answerCallback(query.id, answer).catch(() => {});
    return true;
  }

  // Менеджер написав у групі код - бот відповідає станом і кнопкою
  async function lookupMessage(message) {
    const code = findCode(message.text);
    if (!code) return false;
    const cert = store.getCertificate(code);
    await telegram.sendText(escapeHtml(describeCertificate(cert, code)), {
      replyTo: message.message_id,
      replyMarkup: cert ? certificateKeyboard(cert) : undefined,
    }).catch((e) => log.error('certificate lookup reply failed', e.message));
    return true;
  }

  // Для заявки «Свій принт»: що відомо про код, вказаний клієнтом
  function forBrief(code) {
    if (!code) return null;
    const cert = store.getCertificate(code);
    return {
      code,
      found: Boolean(cert),
      status: cert?.status || null,
      itemLabel: cert?.item_label || '',
      amountUah: cert?.amount_uah || 0,
      line: describeCertificate(cert, code),
    };
  }

  // Відповідь під карткою заявки з кнопкою погашення
  async function replyToBrief(order) {
    const c = order.data.certificate;
    if (!c?.found || !order.tg_message_id) return;
    const cert = store.getCertificate(c.code);
    if (!cert) return;
    await telegram.sendText(escapeHtml(describeCertificate(cert, c.code)), {
      replyTo: order.tg_message_id,
      replyMarkup: certificateKeyboard(cert),
    }).catch((e) => log.error('certificate brief reply failed', e.message));
  }

  return { enabled, tick, callback, lookupMessage, forBrief, replyToBrief };
}
