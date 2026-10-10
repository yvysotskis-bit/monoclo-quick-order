// Локальне прев'ю: рендерить справжні Liquid-блоки розширення (liquidjs + заглушки Shopify-фільтрів)
// у preview/out/index.html. Відкрийте файл у браузері: бекенд не потрібен, відправка замовлення
// імітується (?mode=ok|network|soldout|invalid, ?hours=off — імітація неробочого часу).
import { Liquid, Tag, TokenKind } from 'liquidjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const blocksDir = path.join(root, 'extensions/quick-order/blocks');
const outDir = path.join(root, 'preview/out');

// {% schema %}…{% endschema %}: читаємо JSON і нічого не рендеримо
class SchemaTag extends Tag {
  constructor(token, remainTokens, liquid) {
    super(token, remainTokens, liquid);
    const parts = [];
    for (;;) {
      const t = remainTokens.shift();
      if (!t) throw new Error('{% schema %} без {% endschema %}');
      if (t.kind === TokenKind.Tag && t.name === 'endschema') break;
      parts.push(t.getText ? t.getText() : t.input.slice(t.begin, t.end));
    }
    this.json = parts.join('');
  }
  render() { return ''; }
}

const engine = new Liquid({ strictVariables: false, strictFilters: true });
engine.registerTag('schema', SchemaTag);
engine.registerFilter('asset_url', (name) => `../../extensions/quick-order/assets/${name}`);
engine.registerFilter('stylesheet_tag', (url) => `<link rel="stylesheet" href="${url}">`);
engine.registerFilter('image_url', (src) => (src && typeof src === 'object' ? src.src : src));

function schemaOf(source) {
  const m = source.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
  return JSON.parse(m[1]);
}

function defaults(schema) {
  const out = {};
  for (const s of schema.settings) if (s.id && 'default' in s) out[s.id] = s.default;
  return out;
}

const tee = (fill) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320"><rect width="320" height="320" fill="#ececec"/>`
  + `<path d="M105 40l-65 40 25 55 30-14v159h130V121l30 14 25-55-65-40c-8 22-28 34-55 34s-47-12-55-34z" fill="${fill}" stroke="#00000022"/>`
  + `<text x="160" y="190" text-anchor="middle" font-family="Arial" font-weight="700" font-size="26" fill="${fill === '#ffffff' ? '#111' : '#fff'}">VOLVO</text></svg>`,
)}`;

const colors = { 'Чорний': '#151515', 'Білий': '#ffffff', 'Графітовий': '#3b3b3d' };
const sizes = ['S', 'M', 'L', 'XL'];
let id = 1000;
const variants = [];
for (const color of Object.keys(colors)) {
  for (const size of sizes) {
    const soldOut = (color === 'Білий' && size === 'XL') || (color === 'Графітовий' && ['S', 'M'].includes(size));
    variants.push({
      id: id++, sku: `TEE-${color.slice(0, 2)}-${size}`, title: `${color} / ${size}`, options: [color, size], available: !soldOut,
      price: 89000, compare_at_price: 110000, featured_image: color === 'Графітовий' ? null : tee(colors[color]),
      inventory_management: 'shopify', inventory_policy: 'deny',
      inventory_quantity: soldOut ? 0 : color === 'Чорний' && size === 'L' ? 2 : 12,
    });
  }
}
const product = {
  handle: 'futbolka-monoclo-volvo-fh16', title: 'Футболка Monoclo Volvo FH16 750',
  url: '/products/futbolka-monoclo-volvo-fh16', price: 89000, compare_at_price: 110000,
  featured_image: tee('#151515'),
  options_with_values: [
    { name: 'Колір', values: Object.keys(colors) },
    { name: 'Розмір', values: sizes },
  ],
  variants,
};
product.selected_or_first_available_variant = variants[0];
product.images = Object.keys(colors).map((c) => ({ src: tee(colors[c]), alt: `Худі ${c.toLowerCase()} спереду` }));

const read = (f) => fs.readFileSync(path.join(blocksDir, f), 'utf8');
async function render(file, overrides = {}) {
  const source = read(file);
  const schema = schemaOf(source);
  return engine.parseAndRender(source, {
    product,
    cart: { currency: { iso_code: 'UAH' } },
    request: { design_mode: false },
    block: { id: file.includes('button') ? 'btn1' : 'popup1', shopify_attributes: '', settings: { ...defaults(schema), ...overrides } },
  });
}

const button = await render('quick-order-button.liquid', {});
const popupSettings = { size_guide_url: '#sizes', instagram_url: 'https://instagram.com/monoclo' };
const popup = await render('quick-order-popup.liquid', popupSettings);
const popupRequired = await render('quick-order-popup.liquid', { ...popupSettings, np_require: true });

// Імітація відповіді App Proxy
const mock = `<script>
(function () {
  var q = new URLSearchParams(location.search);
  var mode = q.get('mode') || 'ok';
  window.__orders = [];
  // Імітація Нової пошти (?np=down: сервіс недоступний)
  var uid = function (n) { return '00000000-0000-4000-8000-' + String(n).padStart(12, '0'); };
  var CHERN = { ref: uid(1), name: 'Чернівці', present: 'м. Чернівці, Чернівецька обл.', area: 'Чернівецька', region: '', warehouses: 58 };
  var NPDATA = {
    cities: [
      CHERN,
      { ref: uid(2), name: 'Чернівці', present: 'с. Чернівці, Вінницька обл.', area: 'Вінницька', region: 'Могилів-Подільський', warehouses: 1 },
      { ref: uid(3), name: 'Київ', present: 'м. Київ, Київська обл.', area: 'Київська', region: '', warehouses: 700 },
      { ref: uid(4), name: 'Київ', present: 'с. Київ, Закарпатська обл.', area: 'Закарпатська', region: '', warehouses: 0 }
    ],
    branches: Array.apply(null, Array(40)).map(function (_, i) {
      return { ref: uid(100 + i), number: String(i + 1), name: 'Відділення №' + (i + 1) + ': вул. Тестова, ' + (i + 1), address: '', kind: 'branch' };
    }),
    postomats: [4101, 4102, 4103, 4104].map(function (n, i) {
      return { ref: uid(200 + i), number: String(n), name: 'Поштомат "Нова Пошта" №' + n + ': вул. Головна, ' + (i + 1), address: '', kind: 'postomat' };
    }),
    streets: ['вул. Головна', 'вул. Героїв Майдану', 'просп. Незалежності'].map(function (n, i) { return { ref: uid(300 + i), name: n }; })
  };
  window.__np = [];
  function np(url) {
    var u = new URL(url, location.href);
    var kind = u.pathname.split('/np/')[1];
    var query = (u.searchParams.get('q') || '').toLowerCase();
    window.__np.push({ kind: kind, q: u.searchParams.get('q'), settlement: u.searchParams.get('settlement'), pointKind: u.searchParams.get('kind') });
    return new Promise(function (resolve) {
      setTimeout(function () {
        if (q.get('np') === 'down') return resolve(new Response(JSON.stringify({ ok: false, code: 'np_disabled' }), { status: 503 }));
        var items = [];
        if (kind === 'cities') items = NPDATA.cities.filter(function (c) { return c.name.toLowerCase().indexOf(query) === 0; });
        if (kind === 'points') {
          var all = u.searchParams.get('kind') === 'postomat' ? NPDATA.postomats : NPDATA.branches;
          items = all.filter(function (p) { return !query || p.name.toLowerCase().indexOf(query) !== -1; }).slice(0, 40);
        }
        if (kind === 'streets') items = NPDATA.streets.filter(function (st) { return st.name.toLowerCase().indexOf(query) !== -1; });
        resolve(new Response(JSON.stringify({ ok: true, items: items }), { status: 200 }));
      }, 120);
    });
  }

  window.fetch = function (url, init) {
    if (String(url).indexOf('/np/') !== -1) return np(String(url));
    var body = JSON.parse(init.body);
    window.__orders.push(body);
    return new Promise(function (resolve) {
      setTimeout(function () {
        var respond = function (status, data) { resolve(new Response(JSON.stringify(data), { status: status })); };
        if (mode === 'network') return resolve(Promise.reject(new TypeError('Failed to fetch')));
        if (mode === 'soldout') return respond(409, { ok: false, code: 'sold_out', message: 'sold', field: 'variant' });
        if (mode === 'invalid') return respond(422, { ok: false, code: 'phone', message: 'Вкажіть правильний номер телефону', field: 'phone' });
        respond(200, { ok: true, order_number: '20251005-213405', after_hours: q.get('hours') === 'off' });
      }, 700);
    });
  };
  // ?hour=N: підміна поточної години (Київ) для перевірки теми й робочого часу; ?hours=off = 23:00
  var forced = q.get('hours') === 'off' ? 23 : (q.get('hour') !== null ? Number(q.get('hour')) : null);
  if (forced !== null) {
    var Real = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function (l, o) {
      var f = new Real(l, o);
      if (o && o.hour === '2-digit' && o.timeZone) return { format: function () { return String(forced); } };
      return f;
    };
  }
  // Заглушки аналітики
  window.__ga = []; window.__fb = []; window.dataLayer = [];
  window.gtag = function () { window.__ga.push(Array.prototype.slice.call(arguments)); };
  window.fbq = function () { window.__fb.push(Array.prototype.slice.call(arguments)); };
})();
</script>`;

const buildPage = (popupHtml) => `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quick Order: прев'ю</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#111;background:#fff}
  header{display:flex;gap:24px;align-items:center;padding:18px 32px;border-bottom:1px solid #eee;font-size:12px;letter-spacing:.06em;text-transform:uppercase}
  header b{font-size:20px;letter-spacing:.2em}
  .pdp{display:grid;grid-template-columns:1.3fr 1fr;gap:48px;padding:32px;max-width:1200px;margin:0 auto}
  .pdp img{width:100%;display:block}
  .info h1{font-size:20px;font-weight:600;margin:0 0 8px}
  .price{font-size:18px;margin:0 0 20px}.price s{color:#999;margin-left:8px}
  .info{display:flex;flex-direction:column;gap:34px}
  .info form{margin:0}
  /* Тема-«пігулка», як на сайті Monoclo */
  .btn{display:block;width:100%;box-sizing:border-box;min-height:56px;border:2px solid #000;border-radius:999px;background:transparent;color:#000;font:700 15px/1.2 -apple-system,Segoe UI,Arial,sans-serif;letter-spacing:.02em;text-transform:uppercase;cursor:pointer}
  body.theme-square .btn{border-radius:2px;background:#000;color:#fff;font-weight:500;letter-spacing:.06em;border-width:1px}
  .filler{height:900px}
  @media(max-width:749px){.pdp{grid-template-columns:1fr;padding:16px;gap:20px}header{padding:14px 16px}header span{display:none}}
</style></head>
<body>
<script>if (new URLSearchParams(location.search).get('theme') === 'square') document.body.classList.add('theme-square');</script>
<header><b>MONOCLO</b><span>Printed T-shirts</span><span>Hoodies</span><span>Sale</span></header>
<main class="pdp">
  <div><img src="${product.featured_image}" alt=""></div>
  <div class="info">
    <h1>${product.title}</h1>
    <p class="price">₴890,00 <s>₴1 100,00</s></p>
    <form action="/cart/add" method="post"><button type="submit" name="add" class="btn">Додати до кошика</button></form>
    ${button}
    <button class="btn" id="pay">Оплата частинами</button>
    <div class="filler"></div>
  </div>
</main>
${popupHtml}
${mock}
<script>
  // Лише для прев'ю: слухач події успіху
  document.addEventListener('quickorder:submitted', function (e) { window.__lastEvent = e.detail; });
</script>
</body></html>`;

// Скрипти додатка підключено в popup.liquid через <script defer>; у прев'ю вони ідуть після mock
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), buildPage(popup));
fs.writeFileSync(path.join(outDir, 'required.html'), buildPage(popupRequired));
console.log('preview/out/index.html і required.html готово');
