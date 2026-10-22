// Підбір розміру за історією замовлень цього ж магазину: зріст і вага → розмір, який реально обирали й не повертали.
// Назовні віддаємо лише агрегат (розмір, частка, кількість) і лише коли вибірка достатня, щоб ніхто не впізнавався.

const SIZE_OPTION = /^(size|розмір|размер)/i;
const HOODIE_RE = /худі|hoodie|світшот|sweatshirt|кофта|зіп/i;
// Нова пошта: відмова, повернення, припинено зберігання. Такі покупки не рахуємо
const RETURNED_NP = new Set(['102', '103', '105', '106']);
const RADII = [4, 6, 8, 10]; // допуск за зростом (см) і вагою (кг), розширюємо, доки не набереться вибірка

export const productClass = (title) => (HOODIE_RE.test(String(title || '')) ? 'hoodie' : 'tee');

export function sizeOf(order) {
  const pair = (order.data.options || []).find((o) => SIZE_OPTION.test(String(o.name || '')));
  return pair ? String(pair.value).trim().toUpperCase() : '';
}

// Замовлення, що дійшло до покупки (оплата чи ТТН) і не повернулось
export function isKeptPurchase(order) {
  if (RETURNED_NP.has(String(order.np_status_code || ''))) return false;
  if (order.status === 'spam' || order.status === 'cancelled') return false;
  return Boolean(order.ttn_number || order.pay_paid_at);
}

export function createSizeAdvisor({ store, minSamples = 5, now = () => Date.now(), ttlMs = 60_000 }) {
  // Вибірка зі 5000 замовлень не перераховується на кожен запит: кеш на хвилину на магазин
  const cache = new Map();
  const samplesFor = (shopKey) => {
    const hit = cache.get(shopKey || 'main');
    if (hit && now() - hit.at < ttlMs) return hit.rows;
    const rows = loadSamples(shopKey);
    cache.set(shopKey || 'main', { at: now(), rows });
    return rows;
  };
  const loadSamples = (shopKey) => store.sizeHistory(shopKey)
    .filter(isKeptPurchase)
    .map((o) => ({ size: sizeOf(o), height: Number(o.data.body?.height), weight: Number(o.data.body?.weight), handle: o.data.productHandle, cls: productClass(o.data.productTitle), phone: o.data.phone, at: o.created_at }))
    .filter((s) => s.size);

  function tally(rows) {
    const counts = new Map();
    for (const r of rows) counts.set(r.size, (counts.get(r.size) || 0) + 1);
    const [size, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
    return { size, count, n: rows.length };
  }

  // available — розміри, що існують у цього товару; повертає { size, share, n } або null, якщо даних замало чи вони розмиті
  function recommend({ shopKey, height, weight, handle, title, available = [] }) {
    const base = samplesFor(shopKey).filter((s) => Number.isFinite(s.height) && Number.isFinite(s.weight));
    const have = new Set(available.map((v) => String(v).toUpperCase()));
    const cls = productClass(title);
    for (const scope of [(s) => s.handle === handle, (s) => s.cls === cls]) {
      const pool = base.filter(scope);
      for (const r of RADII) {
        const near = pool.filter((s) => Math.abs(s.height - height) <= r && Math.abs(s.weight - weight) <= r);
        if (near.length < minSamples) continue;
        const top = tally(near.filter((s) => !have.size || have.has(s.size)));
        if (!top.size || top.n < minSamples) continue;
        const share = Math.round((top.count / near.length) * 100);
        // Розмитий розподіл (жоден розмір не переважає) не радимо: краще лишити таблицю
        return share >= 40 ? { size: top.size, share, n: near.length } : null;
      }
    }
    return null;
  }

  // Останні куплені й не повернуті розміри цього номера за типом речі: { tee: 'M', hoodie: 'L' }
  function lastSizes({ shopKey, phone }) {
    const out = {};
    for (const s of samplesFor(shopKey).filter((r) => r.phone === phone).sort((a, b) => b.at - a.at)) {
      if (!out[s.cls]) out[s.cls] = s.size;
    }
    return out;
  }

  return { recommend, lastSizes };
}
