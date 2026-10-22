// Нова пошта API 2.0: https://developers.novaposhta.ua/
// Ключ API лежить лише на сервері; сторінка сайту звертається до наших адрес /proxy/np/*.
const API_URL = 'https://api.novaposhta.ua/v2.0/json/';

// Типи відділень у довіднику Нової пошти
export const TYPE_BRANCH = '841339c7-591a-42e2-8233-7a0a00f0ed6f'; // Поштове відділення
export const TYPE_POSTOMAT = 'f9316480-5f2d-425d-bc2c-ac7cd29decf0'; // Поштомат

const text = (value) => (typeof value === 'string' ? value.trim() : '');

export function normalizeCity(raw) {
  return {
    ref: text(raw.Ref),
    name: text(raw.MainDescription),
    present: text(raw.Present),
    area: text(raw.Area),
    region: text(raw.Region),
    warehouses: Number(raw.Warehouses) || 0,
    // DeliveryCity — CityRef для накладної; AddressDeliveryAllowed — чи доступна адресна доставка
    deliveryCity: text(raw.DeliveryCity),
    addressDelivery: raw.AddressDeliveryAllowed === undefined ? true : raw.AddressDeliveryAllowed === true || raw.AddressDeliveryAllowed === 1 || raw.AddressDeliveryAllowed === '1',
  };
}

const DAYS = [['Monday', 'Пн'], ['Tuesday', 'Вт'], ['Wednesday', 'Ср'], ['Thursday', 'Чт'], ['Friday', 'Пт'], ['Saturday', 'Сб'], ['Sunday', 'Нд']];

// Графік роботи коротко: «Пн–Пт 09:00–20:00, Сб–Нд 09:00–18:00»; вихідні пропускаються
export function formatSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return '';
  const groups = [];
  for (const [key, label] of DAYS) {
    const value = text(schedule[key]).replace('-', '–');
    const open = value && value !== '–' && !/^0?0:00–0?0:00$/.test(value);
    const last = groups.at(-1);
    if (last && last.value === (open ? value : '') && last.open === open) last.to = label;
    else groups.push({ from: label, to: label, value: open ? value : '', open });
  }
  const parts = groups.filter((g) => g.open).map((g) => `${g.from === g.to ? g.from : `${g.from}–${g.to}`} ${g.value}`);
  if (parts.length === 1 && groups.length === 1) return `Щодня ${groups[0].value}`;
  return parts.join(', ');
}

const coordinate = (value) => {
  const n = Number(text(value).replace(',', '.'));
  return Number.isFinite(n) && n !== 0 ? n : null;
};

// Відстань між двома точками на Землі, метри (формула гаверсинусів)
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return Math.round(12_742_000 * Math.asin(Math.min(1, Math.sqrt(a))));
}

export function normalizePoint(raw, kind) {
  const description = text(raw.Description);
  return {
    ref: text(raw.Ref),
    number: text(raw.Number),
    name: description,
    address: text(raw.ShortAddress),
    hours: formatSchedule(raw.Schedule),
    kind,
    lat: coordinate(raw.Latitude),
    lon: coordinate(raw.Longitude),
  };
}

export function normalizeStreet(raw) {
  return {
    ref: text(raw.SettlementStreetRef),
    name: text(raw.Present) || text(raw.SettlementStreetDescription),
  };
}

export function createNovaPoshta({ apiKey, fetchFn, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  // Збій звʼязку (тайм-аут, обрив, HTTP-помилка, не-JSON) позначається err.transport: запит міг дійти до Нової пошти й виконатись,
  // тому для запитів, що створюють дані (накладна), повтор без перевірки небезпечний
  async function call(modelName, calledMethod, methodProperties, { retries = 0, timeoutMs = 8000 } = {}) {
    let res;
    try {
      res = await fetchFn(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey, modelName, calledMethod, methodProperties }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      err.transport = true;
      throw err;
    }
    if (!res.ok) throw Object.assign(new Error(`Нова пошта відповіла ${res.status}`), { transport: true });
    const data = await res.json().catch(() => null);
    if (data === null) throw Object.assign(new Error('Нова пошта повернула некоректну відповідь'), { transport: true });
    if (!data?.success) {
      // Обмеження частоти запитів: чекаємо й пробуємо знову (лише там, де це дозволено)
      const text = (data?.errors || []).join(' ');
      if (retries > 0 && /many requests/i.test(text)) {
        await sleep(2000);
        return call(modelName, calledMethod, methodProperties, { retries: retries - 1, timeoutMs });
      }
      // Ключ у помилку не потрапляє: лише відповідь API
      throw new Error(`Нова пошта: ${(data?.errors || []).join('; ') || 'невідома помилка'}`);
    }
    // Попередження Нової пошти (наприклад, скоригована дата) не є помилкою, але їх корисно бачити
    const rows = data.data || [];
    rows.warnings = Array.isArray(data.warnings) ? data.warnings : [];
    return rows;
  }

  // Повний перелік точок міста для запасного пошуку: кешується на кілька годин (Нова пошта радить кешувати довідник),
  // а одночасні запити діляться одним завантаженням
  const scanCache = new Map();
  const SCAN_TTL_MS = 6 * 3600e3;
  const MAX_PAGES = 8;
  const SCAN_CACHE_MAX = 40; // повні переліки великих міст важать мегабайти: пам'ять не має рости з кожним новим містом

  function scanPoints(settlement) {
    const hit = scanCache.get(settlement);
    if (hit && hit.expires > Date.now()) return hit.promise;
    const promise = (async () => {
      const seen = new Set();
      const all = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const chunk = await call('AddressGeneral', 'getWarehouses', {
          SettlementRef: settlement, Limit: '500', Page: String(page), Language: 'UA',
        }, { timeoutMs: 20000 });
        // Нова пошта для деяких міст віддає весь довідник одним файлом (редірект) і ігнорує Page:
        // нових записів немає, значить перелік уже повний
        const fresh = chunk.filter((r) => r.Ref && !seen.has(r.Ref));
        fresh.forEach((r) => { seen.add(r.Ref); all.push(r); });
        if (!fresh.length || chunk.length > 500 || chunk.length < 500) break;
      }
      return all;
    })();
    if (scanCache.size >= SCAN_CACHE_MAX) scanCache.delete(scanCache.keys().next().value);
    scanCache.set(settlement, { promise, expires: Date.now() + SCAN_TTL_MS });
    // Невдале завантаження не кешуємо
    promise.catch(() => scanCache.delete(settlement));
    return promise;
  }

  return {
    call,
    // Статуси накладних (до 100 за запит): [{ number, phone }] → масив відповідей НП
    async trackDocuments(documents) {
      return call('TrackingDocument', 'getStatusDocuments', {
        Documents: documents.map((d) => ({ DocumentNumber: d.number, ...(d.phone ? { Phone: d.phone } : {}) })),
      });
    },

    async searchCities(query) {
      const rows = await call('Address', 'searchSettlements', { CityName: query, Limit: '10', Page: '1' });
      return (rows[0]?.Addresses || []).map(normalizeCity).filter((c) => c.ref && c.name);
    },

    // kind: 'warehouse' (відділення) або 'postomat'
    // near: { lat, lon } — найближчі до користувача (усі точки міста з відстанню, найближчі перші)
    async searchPoints({ settlement, query, kind, near }) {
      const wantPostomat = kind === 'postomat';
      const isPostomat = (r) =>
        r.CategoryOfWarehouse === 'Postomat' ||
        r.TypeOfWarehouse === TYPE_POSTOMAT ||
        // PostMachineType заповнений лише в поштоматів (у відділень порожній)
        text(r.PostMachineType) !== '' ||
        /поштомат/i.test(text(r.Description));
      // DenyToSelect = 1: з/на цей склад не можна створити накладну, тож клієнтові його пропонувати не можна
      const selectable = (r) => text(r.DenyToSelect) !== '1';
      const q = text(query).toLowerCase();
      const matches = (r) =>
        !q ||
        [r.Number, r.Description, r.ShortAddress].some((v) => text(v).toLowerCase().includes(q));
      const fetchPage = (extra, page) =>
        call('AddressGeneral', 'getWarehouses', {
          SettlementRef: settlement,
          Limit: '500',
          Page: String(page),
          Language: 'UA',
          ...extra,
        }, { timeoutMs: 15000 });
      const usable = (rows) => rows.filter((r) => isPostomat(r) === wantPostomat).filter(selectable).filter(matches);

      if (near) {
        const all = usable(await scanPoints(settlement))
          .map((r) => normalizePoint(r, wantPostomat ? 'postomat' : 'branch'))
          .filter((p) => p.ref && p.name && p.lat !== null && p.lon !== null)
          .map((p) => ({ ...p, distance: distanceMeters(near.lat, near.lon, p.lat, p.lon) }))
          .sort((a, b) => a.distance - b.distance);
        const seen = new Set();
        return all.filter((p) => (seen.has(p.ref) ? false : seen.add(p.ref))).slice(0, 15);
      }

      // 1) швидкий пошук на стороні Нової пошти (за типом і введеним текстом), результат ще раз фільтруємо самі
      const typed = wantPostomat ? { TypeOfWarehouseRef: TYPE_POSTOMAT } : {};
      let rows = await fetchPage(q ? { ...typed, FindByString: text(query) } : typed, 1);
      let picked = usable(rows);
      if (!picked.length && /^\d{1,6}$/.test(q)) {
        // 2) пошук за номером (документований параметр WarehouseId)
        picked = usable(await fetchPage({ ...typed, WarehouseId: q }, 1));
      }
      if (!picked.length) {
        // 3) запасний шлях: усі точки міста (у великих містах їх понад 500, тож кілька сторінок; кешується),
        // потрібні відбираємо самі: Нова пошта не завжди знаходить номер чи адресу через FindByString
        picked = usable(await scanPoints(settlement));
      }
      // Без повторів за Ref
      const unique = new Map();
      for (const r of picked) if (r.Ref && !unique.has(r.Ref)) unique.set(r.Ref, r);
      return [...unique.values()]
        .slice(0, 40)
        .map((r) => normalizePoint(r, wantPostomat ? 'postomat' : 'branch'))
        .filter((p) => p.ref && p.name);
    },

    async searchStreets({ settlement, query }) {
      const rows = await call('Address', 'searchSettlementStreets', {
        StreetName: query,
        SettlementRef: settlement,
        Limit: '10',
      });
      return (rows[0]?.Addresses || []).map(normalizeStreet).filter((s) => s.name);
    },
  };
}

// Дата з відповіді НП («21.11.2021 13:53:47», «2026-10-02 08:50:08», «02-10-2026 …») → «РРРР-ММ-ДД» або ''
export function npDateKey(value) {
  const v = text(value);
  let key = '';
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) key = `${m[1]}-${m[2]}-${m[3]}`;
  else if ((m = /^(\d{2})[.-](\d{2})[.-](\d{4})/.exec(v))) key = `${m[3]}-${m[2]}-${m[1]}`;
  else if ((m = /\b(\d{2})\.(\d{2})\.(\d{4})\b/.exec(v))) key = `${m[3]}-${m[2]}-${m[1]}`;
  // «0001-01-01 00:00:00» Нова пошта пише замість порожньої дати: це не дата
  return key && Number(key.slice(0, 4)) >= 2000 ? key : '';
}
