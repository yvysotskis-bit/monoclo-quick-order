import { isKeptPurchase } from './sizes.js';
import { escapeHtml } from './message.js';

// Мапа спільноти «Де носять Monoclo»: скільки покупців у кожному місті. Лише агрегати; міста з меншою за поріг кількістю
// покупців не називаємо й не малюємо, щоб нікого не можна було впізнати.
const BOUNDS = { lonMin: 22.0, lonMax: 40.3, latMin: 44.2, latMax: 52.5 };

export function createCommunity({ store, np, now, log, minCity = 3, brand = 'Monoclo' }) {
  const geoKey = (ref) => `geo:${ref}`;

  async function geoFor(ref) {
    const cached = store.getMeta(geoKey(ref));
    if (cached) return cached === 'none' ? null : JSON.parse(cached);
    const found = await np.cityGeo(ref);
    store.setMeta(geoKey(ref), found ? JSON.stringify(found) : 'none');
    return found;
  }

  // Перерахунок раз на годину (його викликає tick). За один запуск не більше 8 нових запитів координат
  async function refresh() {
    const at = now().getTime();
    if (at - Number(store.getMeta('community_at') || 0) < 3600e3) return;
    const cities = new Map();
    const everyone = new Set();
    for (const o of store.sizeHistory('main').filter(isKeptPurchase)) {
      const ref = o.data.delivery?.city?.ref;
      everyone.add(o.data.phone);
      if (!ref) continue;
      const entry = cities.get(ref) || { name: o.data.delivery.city.name, phones: new Set() };
      entry.phones.add(o.data.phone);
      cities.set(ref, entry);
    }
    const points = [];
    let lookups = 0;
    let hidden = 0;
    for (const [ref, entry] of cities) {
      const n = entry.phones.size;
      if (n < minCity) { hidden += 1; continue; }
      if (!store.getMeta(geoKey(ref))) {
        if (lookups >= 8) continue;
        lookups += 1;
        try { await geoFor(ref); } catch (err) { log.error('city geo failed', err.message); continue; }
      }
      const geo = await geoFor(ref);
      if (geo) points.push({ name: entry.name, n, lat: geo.lat, lon: geo.lon });
    }
    points.sort((a, b) => b.n - a.n);
    store.setMeta('community', JSON.stringify({ at, owners: everyone.size, cities: cities.size, hidden, points }));
    store.setMeta('community_at', at);
  }

  function snapshot() {
    try { return JSON.parse(store.getMeta('community') || ''); } catch { return { at: 0, owners: 0, cities: 0, hidden: 0, points: [] }; }
  }

  function html() {
    const s = snapshot();
    const W = 1000;
    const scale = Math.cos((48.3 * Math.PI) / 180);
    const spanX = (BOUNDS.lonMax - BOUNDS.lonMin) * scale;
    const spanY = BOUNDS.latMax - BOUNDS.latMin;
    const H = Math.round((W * spanY) / spanX);
    const x = (lon) => ((lon - BOUNDS.lonMin) * scale / spanX) * W;
    const y = (lat) => ((BOUNDS.latMax - lat) / spanY) * H;
    const top = s.points.slice(0, 10);
    const dots = s.points
      .filter((p) => p.lon >= BOUNDS.lonMin && p.lon <= BOUNDS.lonMax && p.lat >= BOUNDS.latMin && p.lat <= BOUNDS.latMax)
      .map((p) => {
        const r = Math.min(30, 6 + 4 * Math.sqrt(p.n));
        const cx = x(p.lon).toFixed(1);
        const cy = y(p.lat).toFixed(1);
        return `<g><circle cx="${cx}" cy="${cy}" r="${(r * 2.4).toFixed(1)}" fill="url(#glow)"/><circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="#fff"><title>${escapeHtml(p.name)}: ${p.n}</title></circle>${p.n >= top.at(-1)?.n && top.length ? `<text x="${cx}" y="${(Number(cy) - r - 8).toFixed(1)}" text-anchor="middle">${escapeHtml(p.name)}</text>` : ''}</g>`;
      }).join('');
    const rows = top.map((p, i) => `<li><span>${i + 1}</span><b>${escapeHtml(p.name)}</b><i>${p.n}</i></li>`).join('');
    return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Де носять ${escapeHtml(brand)}</title>
<style>
body{margin:0;background:#0b0b0c;color:#fff;font:16px/1.5 -apple-system,Segoe UI,Arial,sans-serif}
main{max-width:1000px;margin:0 auto;padding:32px 16px 56px}
h1{font-size:28px;letter-spacing:.04em;margin:0 0 6px}
.lead{color:#aaa;margin:0 0 24px}
.stats{display:flex;gap:32px;flex-wrap:wrap;margin:0 0 20px}
.stats b{display:block;font-size:36px;line-height:1.1}.stats span{color:#aaa;font-size:14px}
svg{width:100%;height:auto;display:block;border:1px solid #222;border-radius:16px;background:radial-gradient(circle at 50% 40%,#17171a,#0b0b0c)}
svg text{fill:#ddd;font-size:15px}
ol{list-style:none;padding:0;margin:24px 0 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px 32px}
li{display:flex;gap:12px;align-items:baseline;border-bottom:1px solid #222;padding:8px 0}
li span{color:#777;width:22px}li b{flex:1;font-weight:500}li i{font-style:normal;color:#aaa}
.note{color:#777;font-size:13px;margin-top:20px}
</style></head><body><main>
<h1>Де носять ${escapeHtml(brand)}</h1>
<p class="lead">Кожна точка — місто, де є наші покупці. Чим більша точка, тим нас там більше.</p>
<div class="stats"><div><b>${s.owners}</b><span>покупців</span></div><div><b>${s.cities}</b><span>міст і сіл</span></div></div>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Мапа міст покупців"><defs><radialGradient id="glow"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>${dots}</svg>
${rows ? `<ol>${rows}</ol>` : ''}
<p class="note">Показуємо лише міста, де щонайменше ${minCity} покупців${s.hidden ? `; ще ${s.hidden} ${s.hidden === 1 ? 'місто чи село' : 'міст і сіл'} поки не відображаються` : ''}. Жодних імен чи адрес.</p>
</main></body></html>`;
  }

  return { refresh, snapshot, html };
}
