import crypto from 'node:crypto';

// A/B-тести форми. Кожен відвідувач (випадковий vid у браузері, без персональних даних) постійно отримує один варіант;
// конверсія — це замовлення, оформлене тим самим vid. Коли різниця статистично значуща, переможець автоматично
// стає єдиним варіантом для всіх, а менеджеру приходить повідомлення.
export const EXPERIMENTS = [
  { id: 'cta', title: 'Текст кнопки «Замовити»', variants: ['A', 'B'], labels: { A: 'Замовити', B: 'Підтвердити замовлення' } },
];

const VID = /^[\w-]{8,64}$/;

// Двостороння z-перевірка різниці двох часток; |z| ≥ 1,96 — це p < 0,05
export function zScore(conv1, n1, conv2, n2) {
  if (!n1 || !n2) return 0;
  const p1 = conv1 / n1;
  const p2 = conv2 / n2;
  const pooled = (conv1 + conv2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  return se === 0 ? 0 : (p2 - p1) / se;
}

export function cleanAb(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.vid !== 'string' || !VID.test(raw.vid)) return null;
  const variants = {};
  for (const e of EXPERIMENTS) if (typeof raw[e.id] === 'string' && e.variants.includes(raw[e.id])) variants[e.id] = raw[e.id];
  return { vid: raw.vid, variants };
}

export function createExperiments({ store, config, telegram, now, log }) {
  const enabled = config.abEnabled !== false;
  const minViews = config.abMinViews ?? 300;
  const maxViews = config.abMaxViews ?? 3000;
  const minConversions = config.abMinConversions ?? 20;

  const winnerOf = (id) => store.getMeta(`ab_winner:${id}`);
  const pick = (vid, e) => e.variants[crypto.createHash('sha256').update(`${e.id}:${vid}`).digest().readUInt32BE(0) % e.variants.length];

  // Варіанти для відвідувача (і фіксація показу). Після рішення всі отримують переможця
  function assign(vid) {
    const out = {};
    if (!enabled || !VID.test(vid || '')) return out;
    for (const e of EXPERIMENTS) {
      const winner = winnerOf(e.id);
      if (winner) { out[e.id] = winner; continue; }
      const variant = store.abExposure(e.id, vid) || pick(vid, e);
      store.abRecordExposure(e.id, vid, variant, now().getTime());
      out[e.id] = variant;
    }
    return out;
  }

  // Замовлення оформлено: зараховуємо конверсію варіанту, який бачив цей відвідувач
  function convert(ab) {
    if (!enabled || !ab) return;
    for (const e of EXPERIMENTS) {
      if (winnerOf(e.id) || !ab.variants[e.id]) continue;
      store.abMarkConverted(e.id, ab.vid, now().getTime());
    }
  }

  function stats(id) {
    const e = EXPERIMENTS.find((x) => x.id === id);
    const rows = store.abStats(id);
    const byVariant = Object.fromEntries(e.variants.map((v) => [v, { views: 0, conversions: 0 }]));
    for (const r of rows) if (byVariant[r.variant]) byVariant[r.variant] = { views: r.views, conversions: r.conversions };
    return byVariant;
  }

  const rate = (s) => (s.views ? Math.round((s.conversions / s.views) * 1000) / 10 : 0);

  function summary() {
    return EXPERIMENTS.map((e) => {
      const s = stats(e.id);
      return { id: e.id, title: e.title, winner: winnerOf(e.id) || null, variants: Object.fromEntries(e.variants.map((v) => [v, { ...s[v], rate: rate(s[v]) }])) };
    });
  }

  // Рішення про переможця; повертає текст сповіщення або null
  function decide(e) {
    if (winnerOf(e.id)) return null;
    const s = stats(e.id);
    const [a, b] = e.variants.map((v) => s[v]);
    const line = (v) => `${e.labels[v]}: ${rate(s[v])}% (${s[v].conversions} із ${s[v].views})`;
    const header = `🧪 A/B-тест «${e.title}»`;
    if (a.views >= minViews && b.views >= minViews && a.conversions + b.conversions >= minConversions) {
      const z = zScore(a.conversions, a.views, b.conversions, b.views);
      if (Math.abs(z) >= 1.96) {
        const winner = z > 0 ? e.variants[1] : e.variants[0];
        store.setMeta(`ab_winner:${e.id}`, winner);
        return `${header}: переміг варіант «${e.labels[winner]}».\n${line(e.variants[0])}\n${line(e.variants[1])}\nТепер його бачать усі відвідувачі.`;
      }
    }
    if (a.views >= maxViews && b.views >= maxViews) {
      const control = e.variants[0];
      store.setMeta(`ab_winner:${e.id}`, control);
      return `${header}: різниці немає, лишаємо «${e.labels[control]}».\n${line(e.variants[0])}\n${line(e.variants[1])}`;
    }
    return null;
  }

  async function tick() {
    if (!enabled) return;
    for (const e of EXPERIMENTS) {
      const text = decide(e);
      if (!text) continue;
      try { await telegram.sendText(text); } catch (err) { log.error('ab notice failed', err.message); }
    }
  }

  return { enabled, assign, convert, summary, tick };
}
