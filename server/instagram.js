// Покупки з Instagram Direct для реклами на повідомлення (Conversions API for Business Messaging).
// Meta приписує покупку рекламі, з якої почалась розмова, лише коли подія має action_source=business_messaging
// і Instagram-scoped ID клієнта (ig_sid). Телефон тут не допомагає: Meta зіставляє саме розмову.
// Звідки беремо ig_sid: KeyCRM підтягує в картку клієнта нік Instagram із чату, а Conversations API сторінки
// віддає учасників розмов (нік + ig_sid). Тож зіставляємо нік із KeyCRM з ніком у розмовах.
// Документація: https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging

const DAY = 24 * 3600e3;

// Нік Instagram: латиниця, цифри, крапка, підкреслення; до 30 символів
const USERNAME_RE = /^[a-z0-9._]{1,30}$/;

export function normUsername(value) {
  const s = String(value || '').trim().toLowerCase()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//, '')
    .replace(/[/?#].*$/, '');
  return USERNAME_RE.test(s) && !/^\d+$/.test(s) ? s : '';
}

// Шукає нік Instagram у будь-якому об'єкті KeyCRM (покупець, замовлення). Структура соцмереж у публічному API
// KeyCRM не задокументована, тож дивимось і на посилання instagram.com/<нік>, і на поля, де в назві є instagram.
// Номери телефонів (Viber/Telegram у тому ж блоці картки) ніком не вважаються.
export function findInstagramUsername(obj) {
  const seen = new Set();
  let found = '';
  const walk = (node, keyPath) => {
    if (found || node == null || seen.has(node)) return;
    if (typeof node === 'string') {
      const link = /instagram\.com\/([A-Za-z0-9._]{1,30})/i.exec(node);
      if (link) { found = normUsername(link[1]); return; }
      if (/instagram|insta\b|\big\b/i.test(keyPath)) found = normUsername(node);
      return;
    }
    if (typeof node !== 'object') return;
    seen.add(node);
    // Пара { type/name/network: 'instagram', value/username/login: '<нік>' }
    const kind = String(node.type || node.name || node.network || node.platform || node.social || node.messenger || '');
    if (/instagram/i.test(kind)) {
      for (const k of ['username', 'login', 'value', 'nickname', 'nick', 'link', 'url', 'profile']) {
        const u = normUsername(node[k]);
        if (u) { found = u; return; }
      }
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${keyPath}.${k}`);
  };
  walk(obj, '');
  return found;
}

// Шляхи полів (без значень) для діагностики: щоб після запуску побачити, де KeyCRM зберігає соцмережі
export function keyPaths(obj, prefix = '', out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4 || out.length > 80) return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') keyPaths(Array.isArray(v) ? v[0] : v, `${p}${Array.isArray(v) ? '[]' : ''}`, out, depth + 1);
    else out.push(p);
  }
  return out;
}

export function buildIgPurchaseEvent({ igSid, igAccountId, valueCents, eventTimeMs, crmOrderId }) {
  return {
    event_name: 'Purchase',
    event_time: Math.floor(eventTimeMs / 1000),
    // Meta не прибирає дублі для цього API; event_id лишаємо для звірки (той самий формат, що й у CSV)
    event_id: `keycrm-${crmOrderId}`,
    action_source: 'business_messaging',
    messaging_channel: 'instagram',
    user_data: {
      instagram_business_account_id: String(igAccountId),
      ig_sid: String(igSid),
    },
    custom_data: { currency: 'UAH', value: valueCents / 100 },
  };
}

// Довідник «нік → ig_sid» з розмов Instagram сторінки. Розмови йдуть від найсвіжіших, тож при кожній синхронізації
// гортаємо, доки не дійдемо до вже переглянутих (з запасом у добу). Перший прохід — до maxPages сторінок назад.
export function createIgDirectory({ c, store, fetchFn, now, log }) {
  const diag = { lastSync: null, lastError: null };

  async function graph(path, params) {
    const query = new URLSearchParams({ ...params, access_token: c.igPageToken });
    const res = await fetchFn(`https://graph.facebook.com/${c.metaApiVersion}/${path}?${query}`, { signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* не JSON */ }
    if (!res.ok) throw Object.assign(new Error(`Instagram ${res.status}: ${data?.error?.message || text.slice(0, 200)}`), { status: res.status });
    return data;
  }

  async function sync({ full = false } = {}) {
    const nowMs = now().getTime();
    const watermark = full ? 0 : Number(store.getMeta('ig_conversations_synced_at') || 0);
    const stopAt = watermark ? watermark - DAY : nowMs - (c.igLookbackDays || 60) * DAY;
    let after = '';
    let pages = 0;
    let saved = 0;
    try {
      while (pages < (c.igMaxPages || 40)) {
        const data = await graph(`${c.igPageId}/conversations`, {
          platform: 'instagram', fields: 'updated_time,participants', limit: '50', ...(after ? { after } : {}),
        });
        pages += 1;
        let older = false;
        for (const conv of data.data || []) {
          const updated = Date.parse(String(conv.updated_time || '').replace(/\+0000$/, 'Z'));
          if (Number.isFinite(updated) && updated < stopAt) { older = true; break; }
          for (const p of conv.participants?.data || []) {
            if (String(p.id) === String(c.igAccountId)) continue;
            const username = normUsername(p.username);
            if (username && p.id && store.saveIgUser(username, String(p.id), nowMs)) saved += 1;
          }
        }
        after = data.paging?.cursors?.after;
        if (older || !data.paging?.next || !after) break;
      }
      store.setMeta('ig_conversations_synced_at', nowMs);
      diag.lastSync = { at: new Date(nowMs).toISOString(), pages, saved, known: store.igUserCount() };
    } catch (err) {
      diag.lastError = { at: new Date(nowMs).toISOString(), message: String(err.message).slice(0, 200) };
      log.error('instagram: conversations sync failed', err.message);
      throw err;
    }
  }

  return { sync, lookup: (username) => store.igUserSid(normUsername(username)), diag };
}
