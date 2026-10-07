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
  };
}

export function normalizePoint(raw, kind) {
  const description = text(raw.Description);
  return {
    ref: text(raw.Ref),
    number: text(raw.Number),
    name: description,
    address: text(raw.ShortAddress),
    kind,
  };
}

export function normalizeStreet(raw) {
  return {
    ref: text(raw.SettlementStreetRef),
    name: text(raw.Present) || text(raw.SettlementStreetDescription),
  };
}

export function createNovaPoshta({ apiKey, fetchFn }) {
  async function call(modelName, calledMethod, methodProperties) {
    const res = await fetchFn(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey, modelName, calledMethod, methodProperties }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Нова пошта відповіла ${res.status}`);
    const data = await res.json().catch(() => null);
    if (!data?.success) {
      // Ключ у помилку не потрапляє: лише відповідь API
      throw new Error(`Нова пошта: ${(data?.errors || []).join('; ') || 'невідома помилка'}`);
    }
    return data.data || [];
  }

  return {
    async searchCities(query) {
      const rows = await call('Address', 'searchSettlements', { CityName: query, Limit: '10', Page: '1' });
      return (rows[0]?.Addresses || []).map(normalizeCity).filter((c) => c.ref && c.name);
    },

    // kind: 'warehouse' (відділення) або 'postomat'
    async searchPoints({ settlement, query, kind }) {
      const wantPostomat = kind === 'postomat';
      const isPostomat = (r) =>
        r.CategoryOfWarehouse === 'Postomat' ||
        r.TypeOfWarehouse === TYPE_POSTOMAT ||
        /поштомат/i.test(text(r.Description));
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
        });

      // Пошук за типом (швидко); номер/адресу фільтруємо самі, бо FindByString їх часто не знаходить
      let rows = await fetchPage(wantPostomat ? { TypeOfWarehouseRef: TYPE_POSTOMAT } : {}, 1);
      let picked = rows.filter((r) => isPostomat(r) === wantPostomat).filter(matches);
      if (!picked.length && wantPostomat) {
        // Запасний шлях: усі точки міста (до 3 сторінок), поштомати відбираємо самі
        rows = [];
        for (let page = 1; page <= 3; page += 1) {
          const chunk = await fetchPage({}, page);
          rows = rows.concat(chunk);
          if (chunk.length < 500) break;
        }
        picked = rows.filter(isPostomat).filter(matches);
      }
      return picked
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
