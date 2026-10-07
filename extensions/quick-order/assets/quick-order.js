/* Quick Order popup для Monoclo. Без залежностей.
   Кнопки [data-qo-open] читають JSON товару з <script id=data-qo-product>,
   відкривають <dialog data-qo-dialog> і відправляють замовлення на App Proxy. */
(function () {
  'use strict';
  if (window.QuickOrder) return;

  var T = {
    chooseOption: function (name) { return 'Оберіть ' + name.toLowerCase(); },
    enterName: 'Вкажіть імʼя',
    enterPhone: 'Вкажіть номер телефону',
    inStock: 'В наявності',
    low: function (n) { return 'Залишилось ' + n + ' шт.'; },
    soldOut: 'Немає в наявності',
    thanks: function (n) { return 'Дякуємо! Замовлення №' + n + ' прийнято'; },
    network: 'Не вдалося зʼєднатися з сервером. Перевірте інтернет і натисніть «Замовити» ще раз.',
    generic: 'Щось пішло не так. Натисніть «Замовити» ще раз.',
    soldOutNow: 'На жаль, цей варіант щойно закінчився. Оберіть інший.',
    product: 'Товар', qty: 'Кількість', total: 'Сума', phone: 'Телефон',
    chooseCity: 'Оберіть місто зі списку', enterCity: 'Вкажіть місто',
    chooseBranch: 'Оберіть відділення', choosePostomat: 'Оберіть поштомат',
    chooseStreet: 'Оберіть вулицю', enterHouse: 'Вкажіть номер будинку',
    branch: 'Відділення', postomat: 'Поштомат',
    branchHint: 'Номер або адреса відділення', postomatHint: 'Номер або адреса поштомата',
    npLoading: 'Шукаємо…', npEmpty: 'Нічого не знайдено', npError: 'Список недоступний, введіть вручну'
  };

  var COLOR_OPTION = /^(colou?r|колір|кольор|цвет)/i;
  var SIZE_OPTION = /^(size|розмір|размер)/i;
  var DEFAULT_COLORS = {
    'чорний': '#111111', 'білий': '#ffffff', 'графітовий': '#3b3b3d', 'сірий': '#8d8d8d',
    'світло-сірий': '#d4d4d4', 'темно-сірий': '#555555', 'червоний': '#c0262d', 'бордовий': '#6d1a24',
    'синій': '#1f3a8a', 'темно-синій': '#14213d', 'блакитний': '#7ec8e3', 'зелений': '#2e7d32',
    'хакі': '#6b6b3a', 'оливковий': '#6b7036', 'бежевий': '#d8c7a5', 'пісочний': '#d6c3a0',
    'коричневий': '#6b4423', 'молочний': '#f3ede0', 'жовтий': '#f2c230', 'помаранчевий': '#ec7a1c',
    'рожевий': '#f4b6c2', 'фіолетовий': '#6a3fa0',
    'black': '#111111', 'white': '#ffffff', 'gray': '#8d8d8d', 'grey': '#8d8d8d', 'graphite': '#3b3b3d',
    'navy': '#14213d', 'khaki': '#6b6b3a', 'beige': '#d8c7a5', 'brown': '#6b4423', 'olive': '#6b7036'
  };

  var STORE_KEY = 'qo:contact';

  /* ---------- Чисті функції ---------- */

  // Цифри національної частини номера (до 9), без 380 / 0 попереду
  function nationalDigits(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.indexOf('380') === 0) d = d.slice(3);
    else if (d.charAt(0) === '0') d = d.slice(1);
    return d.slice(0, 9);
  }

  // 671234567 → (67) 123 45 67
  function formatNational(d) {
    if (!d) return '';
    var s = '(' + d.slice(0, 2);
    if (d.length === 2) s += ')';
    if (d.length > 2) s += ') ' + d.slice(2, 5);
    if (d.length > 5) s += ' ' + d.slice(5, 7);
    if (d.length > 7) s += ' ' + d.slice(7, 9);
    return s;
  }

  function money(cents, currency) {
    var code = currency || 'UAH';
    try {
      var n = new Intl.NumberFormat('uk-UA', {
        minimumFractionDigits: 0, maximumFractionDigits: 2
      }).format(cents / 100);
      return code === 'UAH' ? n + '\u00a0₴' : n + '\u00a0' + code;
    } catch (e) {
      return (cents / 100) + ' ' + code;
    }
  }

  function parseColorMap(text) {
    var map = {};
    Object.keys(DEFAULT_COLORS).forEach(function (k) { map[k] = DEFAULT_COLORS[k]; });
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var i = line.lastIndexOf(':');
      if (i < 1) return;
      var name = line.slice(0, i).trim().toLowerCase();
      var value = line.slice(i + 1).trim();
      if (name && value) map[name] = value;
    });
    return map;
  }

  function resolveColor(name, map) {
    var key = String(name).trim().toLowerCase();
    if (map[key]) return map[key];
    if (window.CSS && CSS.supports && CSS.supports('color', key)) return key;
    return null;
  }

  function hourIn(tz, date) {
    try {
      return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(date));
    } catch (e) {
      return date.getHours();
    }
  }

  function pad(n) { return (n < 10 ? '0' : '') + n + ':00'; }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'qo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* ---------- Джерело трафіку (UTM) ---------- */

  var ATTR_KEY = 'qo:attribution';
  var ATTR_TTL = 30 * 24 * 3600 * 1000;

  function readAttribution() {
    try {
      var a = JSON.parse(localStorage.getItem(ATTR_KEY));
      if (a && Date.now() - a.at < ATTR_TTL) return a;
    } catch (e) { /* приватний режим */ }
    return null;
  }

  function writeAttribution(value) {
    try { localStorage.setItem(ATTR_KEY, JSON.stringify(value)); } catch (e) { /* приватний режим */ }
  }

  // Запамʼятовуємо, з якої реклами прийшов відвідувач, щоб пізніше показати це в замовленні (30 днів)
  function captureAttribution() {
    var q = new URLSearchParams(window.location.search);
    var utm = {};
    ['source', 'medium', 'campaign', 'content', 'term'].forEach(function (k) {
      var v = q.get('utm_' + k);
      if (v) utm[k] = v.slice(0, 100);
    });
    var click = ['fbclid', 'gclid', 'ttclid'].filter(function (k) { return q.has(k); })[0] || '';
    var referrer = '';
    try {
      if (document.referrer) {
        var host = new URL(document.referrer).hostname.replace(/^www\./, '');
        if (host && host !== window.location.hostname.replace(/^www\./, '')) referrer = host;
      }
    } catch (e) { /* некоректний referrer */ }

    var stored = readAttribution();
    if (Object.keys(utm).length || click) {
      writeAttribution({ utm: utm, click: click, referrer: referrer || (stored && stored.referrer) || '', at: Date.now() });
    } else if (!stored && referrer) {
      writeAttribution({ utm: {}, click: '', referrer: referrer, at: Date.now() });
    }
  }

  // Темна тема: за часом доби, як у пристрої або завжди світла/темна
  function pickTheme(mode, hour, darkFrom, lightFrom) {
    if (mode === 'dark' || mode === 'light') return mode;
    if (mode === 'auto') {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    var dark = darkFrom > lightFrom
      ? (hour >= darkFrom || hour < lightFrom)
      : (hour >= darkFrom && hour < lightFrom);
    return dark ? 'dark' : 'light';
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }
  function writeStore(value) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(value)); } catch (e) { /* приватний режим */ }
  }

  /* ---------- Стан і DOM ---------- */

  var dialog, sheet, refs, cfg;
  var state = null;
  var productCache = {};

  function $(selector) { return dialog.querySelector(selector); }

  function init() {
    dialog = document.querySelector('[data-qo-dialog]');
    if (!dialog || dialog.__qoReady) return;
    dialog.__qoReady = true;
    sheet = $('[data-qo-sheet]');
    cfg = {
      endpoint: dialog.dataset.endpoint,
      tz: dialog.dataset.timezone || 'Europe/Kyiv',
      workStart: Number(dialog.dataset.workStart),
      workEnd: Number(dialog.dataset.workEnd),
      colorMap: parseColorMap(dialog.dataset.colorMap),
      sizeGuide: dialog.dataset.sizeGuideUrl || '',
      sizeHelper: dialog.dataset.sizeHelper === 'true',
      sizeMapTee: dialog.dataset.sizeMapTee || '',
      sizeMapHoodie: dialog.dataset.sizeMapHoodie || '',
      instagram: dialog.dataset.instagramUrl || '',
      afterHoursText: dialog.dataset.afterHoursText || '',
      maxQty: Number(dialog.dataset.maxQty) || 10,
      themeMode: dialog.dataset.themeMode || 'time',
      darkFrom: isNaN(Number(dialog.dataset.darkFrom)) ? 17 : Number(dialog.dataset.darkFrom),
      lightFrom: isNaN(Number(dialog.dataset.lightFrom)) ? 6 : Number(dialog.dataset.lightFrom),
      np: !!dialog.querySelector('[data-qo-delivery][data-np="true"]'),
      npRequire: !!dialog.querySelector('[data-qo-delivery][data-np-require="true"]'),
      trackGa: dialog.dataset.trackGa === 'true',
      trackMeta: dialog.dataset.trackMeta === 'true'
    };
    refs = {
      form: $('[data-qo-form]'),
      options: $('[data-qo-options]'),
      image: $('[data-qo-image]'),
      title: $('[data-qo-title]'),
      price: $('[data-qo-price]'),
      compare: $('[data-qo-compare]'),
      badge: $('[data-qo-badge]'),
      qtyInput: $('[data-qo-qty-input]'),
      stock: $('[data-qo-stock]'),
      name: $('[data-qo-name]'),
      surname: $('[data-qo-surname]'),
      phone: $('[data-qo-phone]'),
      comment: $('[data-qo-comment]'),
      city: $('[data-qo-city]'),
      cityHint: $('[data-qo-field-hint="city"]'),
      deliveryRoot: $('[data-qo-delivery]'),
      npBlock: $('[data-qo-np]'),
      pointField: $('[data-qo-point-field]'),
      pointLabel: $('[data-qo-point-label]'),
      point: $('[data-qo-point]'),
      courier: $('[data-qo-courier]'),
      street: $('[data-qo-street]'),
      house: $('[data-qo-house]'),
      apartment: $('[data-qo-apartment]'),
      honeypot: $('[data-qo-honeypot]'),
      total: $('[data-qo-total]'),
      submit: $('[data-qo-submit]'),
      ctaHint: $('[data-qo-cta-hint]'),
      error: $('[data-qo-error]'),
      hoursNote: $('[data-qo-hours-note]'),
      formView: $('[data-qo-form-view]'),
      successView: $('[data-qo-success-view]'),
      successTitle: $('[data-qo-success-title]'),
      successSummary: $('[data-qo-success-summary]'),
      successNote: $('[data-qo-success-note]'),
      successHours: $('[data-qo-success-hours]'),
      body: $('[data-qo-body]'),
      head: $('[data-qo-head]'),
      stepLabel: $('[data-qo-step-label]'),
      bar: $('[data-qo-bar]'),
      back: $('[data-qo-back]'),
      recap: $('[data-qo-recap]'),
      recapLine: $('[data-qo-recap-line]'),
      editData: $('[data-qo-edit-data]'),
      submitLabel: $('[data-qo-submit-label]'),
      sumLabel: $('[data-qo-sum-label]'),
      sumTotal: $('[data-qo-sum-total]'),
      sumDelivery: $('[data-qo-sum-delivery]'),
      step1: $('[data-qo-step="1"]'),
      step2: $('[data-qo-step="2"]')
    };

    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) close();
    });
    dialog.addEventListener('cancel', function (e) {
      e.preventDefault();
      // Esc спершу закриває відкритий список, а не весь попап
      var closedList = false;
      combos.forEach(function (c) { if (c.close()) closedList = true; });
      if (!closedList) close();
    });
    dialog.addEventListener('click', function (e) {
      if (e.target.closest('[data-qo-close]')) close();
    });

    dialog.querySelectorAll('[data-qo-qty]').forEach(function (btn) {
      btn.addEventListener('click', function () { setQty(state.qty + Number(btn.dataset.qoQty)); });
    });

    refs.name.addEventListener('input', function () { onFieldInput('name'); });
    refs.name.addEventListener('blur', function () { state.touched.name = refs.name.value.trim() !== ''; refresh(); });
    refs.phone.addEventListener('input', onPhoneInput);
    refs.phone.addEventListener('blur', function () { state.touched.phone = refs.phone.value !== ''; refresh(); });

    // Enter у полі або дотик по головній кнопці: «Далі» на кроці 1, замовлення на кроці 2
    refs.form.addEventListener('submit', function (e) { e.preventDefault(); primaryAction(); });
    refs.submit.addEventListener('click', function (e) {
      if (refs.submit.getAttribute('aria-disabled') === 'true') {
        e.preventDefault();
        highlightMissing();
      }
    });
    refs.back.addEventListener('click', function () { goBack(); });
    // Підказка «Оберіть колір» клікабельна: веде до поля, якого бракує
    refs.ctaHint.addEventListener('click', function () { if (refs.ctaHint.textContent) highlightMissing(); });
    // Ctrl/⌘+Enter відправляє замовлення з будь-якого поля
    dialog.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && state && state.step === 2) {
        e.preventDefault();
        primaryAction();
      }
    });
    // Зміна розміру вікна між телефоном і комп'ютером
    window.matchMedia('(min-width: 641px)').addEventListener('change', function () {
      if (dialog.open && state) showStep(state.step, false);
    });
    refs.editData.addEventListener('click', function () { showStep(2, true); });
    // Поле у фокусі завжди прокручується в видиму зону над клавіатурою
    refs.form.addEventListener('focusin', function (e) {
      if (!window.matchMedia('(max-width: 640px)').matches) return;
      var field = e.target.closest && e.target.closest('.qo-field');
      if (!field) return;
      setTimeout(function () {
        if (dialog.open && document.activeElement === e.target) field.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 320);
    });

    initSwipe();
    initDelivery();
  }

  /* ---------- Відкриття / закриття ---------- */

  function loadProduct(id) {
    if (productCache[id]) return productCache[id];
    var node = document.getElementById(id);
    if (!node) return null;
    try {
      productCache[id] = JSON.parse(node.textContent);
      return productCache[id];
    } catch (e) {
      return null;
    }
  }

  function open(product, trigger) {
    init();
    if (!dialog || !product) return;

    var saved = readStore();
    state = {
      product: product,
      selected: product.options.map(function () { return null; }),
      qty: 1,
      submitting: false,
      clientId: uuid(),
      trigger: trigger || null,
      touched: { name: false, phone: false },
      step: 1,
      delivery: { method: 'warehouse', city: null, point: null, street: null },
      prevDigits: ''
    };

    preselect(product);

    refs.title.textContent = product.title;
    refs.image.alt = product.title;
    refs.image.removeAttribute('src');
    refs.name.value = saved.name || '';
    state.body = saved.body && saved.body.height && saved.body.weight ? saved.body : null;
    if (refs.surname) refs.surname.value = saved.surname || '';
    refs.phone.value = formatNational(nationalDigits(saved.phone || ''));
    state.prevDigits = nationalDigits(refs.phone.value);
    if (refs.comment) refs.comment.value = '';
    restoreDelivery(saved);
    dialog.dataset.theme = pickTheme(cfg.themeMode, hourIn(cfg.tz, new Date()), cfg.darkFrom, cfg.lightFrom);
    refs.honeypot.value = '';

    clearFieldStates();
    hideError();
    setView('form');
    renderOptions();
    showStep(1, false);

    var afterHours = isAfterHours();
    refs.hoursNote.hidden = !afterHours;
    if (afterHours) refs.hoursNote.textContent = hoursText();

    dialog.classList.remove('is-success', 'is-open');
    dialog.showModal();
    watchViewport(true);
    pushHistory(1);
    document.documentElement.classList.add('qo-lock');
    refs.body.scrollTop = 0;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { dialog.classList.add('is-open'); });
    });
    sheet.focus({ preventScroll: true });
    if (isDesktop()) {
      // Курсор одразу в першому порожньому полі: можна одразу писати
      setTimeout(function () {
        if (!dialog.open) return;
        var target = optionMissing() ? refs.options.querySelector('.qo-choice[tabindex="0"], .qo-choice') : (refs.name.value.trim() ? (digits().length === 9 ? null : refs.phone) : refs.name);
        if (target) target.focus({ preventScroll: true });
      }, 320);
    }
  }

  // На телефоні піднімаємо панель над клавіатурою й обмежуємо її висоту видимою частиною екрана
  function syncViewport() {
    var vv = window.visualViewport;
    if (!vv || !sheet || !window.matchMedia('(max-width: 640px)').matches) return;
    var covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    sheet.style.bottom = covered ? covered + 'px' : '';
    // З клавіатурою висота рівна видимій частині екрана: нічого не вилазить за межі
    sheet.style.height = covered ? Math.round(vv.height * 0.98) + 'px' : '';
    dialog.classList.toggle('qo-kb', covered > 120);
  }

  function watchViewport(on) {
    var vv = window.visualViewport;
    if (!vv) return;
    var method = on ? 'addEventListener' : 'removeEventListener';
    vv[method]('resize', syncViewport);
    vv[method]('scroll', syncViewport);
    if (!on && sheet) {
      sheet.style.bottom = '';
      sheet.style.height = '';
      dialog.classList.remove('qo-kb');
    }
  }

  function close() {
    if (!dialog || !dialog.open || (state && state.submitting)) return;
    popHistory();
    dialog.classList.remove('is-open');
    var finish = function () {
      watchViewport(false);
      if (dialog.open) dialog.close();
      document.documentElement.classList.remove('qo-lock');
      sheet.style.transform = '';
      var trigger = state && state.trigger;
      if (trigger && document.contains(trigger)) trigger.focus({ preventScroll: true });
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else setTimeout(finish, 280);
  }

  function setView(name) {
    var success = name === 'success';
    refs.formView.hidden = success;
    refs.successView.hidden = !success;
    dialog.classList.toggle('is-success', success);
  }

  function preselect(product) {
    var params = new URLSearchParams(window.location.search);
    var variantId = Number(params.get('variant')) || 0;
    var variant = product.variants.filter(function (v) { return v.id === variantId; })[0];
    if (variant && variant.available) {
      state.selected = variant.options.slice();
      return;
    }
    product.options.forEach(function (option, i) {
      if (option.values.length === 1) state.selected[i] = option.values[0];
    });
  }

  /* ---------- Варіанти ---------- */

  function currentVariant() {
    if (state.selected.some(function (s) { return s == null; })) return null;
    var found = state.product.variants.filter(function (v) {
      return v.options.every(function (o, i) { return o === state.selected[i]; });
    })[0];
    return found || null;
  }

  function valueAvailable(i, value) {
    return state.product.variants.some(function (v) {
      return v.options[i] === value && v.available && state.selected.every(function (s, j) {
        return j === i || s == null || v.options[j] === s;
      });
    });
  }

  function selectValue(i, value) {
    state.selected[i] = value;
    // Якщо після зміни обраний раніше варіант став недоступним, скидаємо його
    state.selected.forEach(function (s, j) {
      if (j !== i && s != null && !valueAvailable(j, s)) state.selected[j] = null;
    });
    hideError();
    refresh();
  }


  /* ---------- Підбір розміру за зростом і вагою ---------- */

  var HOODIE_RE = /худі|hoodie|світшот|sweatshirt|кофта|зіп/i;

  // «XS:55, S:65, M:75, XXL» -> [{size:'XS', max:55}, ..., {size:'XXL', max:null}]
  function parseSizeMap(raw) {
    return String(raw || '').split(',').map(function (part) {
      var bits = part.split(':');
      var size = bits[0].trim().toUpperCase();
      var max = bits.length > 1 ? Number(bits[1]) : null;
      return size ? { size: size, max: isFinite(max) ? max : null } : null;
    }).filter(Boolean);
  }

  // Вага, скоригована на зріст (базовий зріст 175 см). Повертає розмір з таблиці або null
  function recommendSize(height, weight, values, title) {
    var map = parseSizeMap(HOODIE_RE.test(title) ? cfg.sizeMapHoodie : cfg.sizeMapTee);
    if (!map.length) return null;
    var score = weight + (height - 175) * 0.5;
    var index = map.length - 1;
    for (var k = 0; k < map.length; k += 1) {
      if (map[k].max == null || score < map[k].max) { index = k; break; }
    }
    // Найближчий розмір, який існує в цього товару
    var have = {};
    values.forEach(function (v) { have[String(v).toUpperCase()] = v; });
    for (var d = 0; d < map.length; d += 1) {
      var up = map[index + d];
      var down = map[index - d];
      if (up && have[up.size]) return have[up.size];
      if (down && have[down.size]) return have[down.size];
    }
    return null;
  }

  function buildSizeHelper(optionIndex, option) {
    var wrap = el('div', 'qo-sizehelper');
    var toggle = el('button', 'qo-sizehelper__toggle', 'Не знаєте розмір? Підібрати за зростом і вагою');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    var panel = el('div', 'qo-sizehelper__panel');
    panel.hidden = true;

    function numberField(label, placeholder, min, max) {
      var box = el('label', 'qo-sizehelper__field');
      box.appendChild(el('span', '', label));
      var input = el('input', 'qo-input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.maxLength = 3;
      input.placeholder = placeholder;
      input.autocomplete = 'off';
      input.addEventListener('input', function () { input.value = input.value.replace(/\D/g, ''); });
      input.dataset.min = min;
      input.dataset.max = max;
      box.appendChild(input);
      return { box: box, input: input };
    }
    var h = numberField('Зріст, см', '180', 120, 220);
    var w = numberField('Вага, кг', '75', 30, 200);
    var row = el('div', 'qo-sizehelper__row');
    row.appendChild(h.box);
    row.appendChild(w.box);
    var go = el('button', 'qo-sizehelper__go', 'Підібрати');
    go.type = 'button';
    row.appendChild(go);
    var result = el('p', 'qo-sizehelper__result');
    result.setAttribute('aria-live', 'polite');
    panel.appendChild(row);
    panel.appendChild(result);
    wrap.appendChild(toggle);
    wrap.appendChild(panel);

    if (state.body) { h.input.value = state.body.height; w.input.value = state.body.weight; }

    toggle.addEventListener('click', function () {
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) h.input.focus();
    });

    function inRange(input) {
      var n = Number(input.value);
      return n >= Number(input.dataset.min) && n <= Number(input.dataset.max) ? n : null;
    }
    go.addEventListener('click', function () {
      var height = inRange(h.input);
      var weight = inRange(w.input);
      if (!height || !weight) {
        result.textContent = 'Вкажіть зріст (120–220 см) і вагу (30–200 кг).';
        return;
      }
      state.body = { height: height, weight: weight };
      var size = recommendSize(height, weight, option.values, state.product.title);
      if (!size) { result.textContent = 'Не вдалося підібрати розмір. Скористайтеся таблицею розмірів.'; return; }
      if (valueAvailable(optionIndex, size)) {
        selectValue(optionIndex, size);
        result.textContent = 'Рекомендуємо ' + size + ' і вже обрали його. Усі наші речі оверсайз: якщо хочете щільніше, візьміть на розмір менше.';
      } else {
        result.textContent = 'Рекомендуємо ' + size + ', але в обраному кольорі його зараз немає. Спробуйте інший колір.';
      }
    });
    return wrap;
  }

  function renderOptions() {
    refs.options.textContent = '';
    state.product.options.forEach(function (option, i) {
      var isDefault = option.values.length === 1 && option.values[0] === 'Default Title';
      if (isDefault) return;

      var isColor = COLOR_OPTION.test(option.name);
      var field = el('div', 'qo-field');
      field.dataset.qoField = 'option-' + i;

      var label = el('span', 'qo-label');
      label.id = 'qo-opt-' + i;
      label.appendChild(el('span', '', option.name));
      var chosen = el('strong');
      chosen.dataset.qoChosen = i;
      label.appendChild(chosen);
      if (cfg.sizeGuide && SIZE_OPTION.test(option.name)) {
        var guide = el('a', 'qo-size-guide', 'Таблиця розмірів');
        guide.href = cfg.sizeGuide;
        guide.target = '_blank';
        guide.rel = 'noopener';
        label.appendChild(guide);
      }
      field.appendChild(label);

      var group = el('div', 'qo-choices');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-labelledby', label.id);

      option.values.forEach(function (value) {
        var btn = el('button', 'qo-choice');
        btn.type = 'button';
        btn.setAttribute('role', 'radio');
        btn.dataset.qoOption = i;
        btn.dataset.qoValue = value;
        var color = isColor ? resolveColor(value, cfg.colorMap) : null;
        if (color) {
          btn.classList.add('qo-choice--color');
          var dot = el('span', 'qo-dot');
          dot.style.backgroundColor = color;
          btn.appendChild(dot);
          btn.setAttribute('aria-label', value);
          btn.title = value;
        } else {
          btn.textContent = value;
        }
        btn.addEventListener('click', function () {
          if (btn.getAttribute('aria-disabled') === 'true') return;
          selectValue(i, value);
        });
        btn.addEventListener('keydown', onChoiceKey);
        group.appendChild(btn);
      });

      field.appendChild(group);
      if (cfg.sizeHelper && SIZE_OPTION.test(option.name)) field.appendChild(buildSizeHelper(i, option));
      refs.options.appendChild(field);
    });
  }

  function onChoiceKey(e) {
    var keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!keys[e.key]) return;
    var buttons = Array.prototype.filter.call(
      e.currentTarget.parentNode.children,
      function (b) { return b.getAttribute('aria-disabled') !== 'true'; }
    );
    var next = buttons[(buttons.indexOf(e.currentTarget) + keys[e.key] + buttons.length) % buttons.length];
    if (next) { e.preventDefault(); next.focus(); next.click(); }
  }

  function updateChoices() {
    dialog.querySelectorAll('.qo-choice').forEach(function (btn) {
      var i = Number(btn.dataset.qoOption);
      var value = btn.dataset.qoValue;
      var available = valueAvailable(i, value);
      var checked = state.selected[i] === value;
      btn.setAttribute('aria-checked', checked ? 'true' : 'false');
      btn.setAttribute('aria-disabled', available ? 'false' : 'true');
      btn.tabIndex = checked ? 0 : -1;
      if (!available) btn.title = T.soldOut;
      else if (btn.classList.contains('qo-choice--color')) btn.title = value;
      else btn.removeAttribute('title');
    });
    // Якщо нічого не обрано, у групі фокусується перша доступна кнопка
    dialog.querySelectorAll('.qo-choices').forEach(function (group) {
      if (group.querySelector('[aria-checked="true"]')) return;
      var first = group.querySelector('.qo-choice[aria-disabled="false"]');
      if (first) first.tabIndex = 0;
    });
    dialog.querySelectorAll('[data-qo-chosen]').forEach(function (node) {
      var v = state.selected[Number(node.dataset.qoChosen)];
      node.textContent = v || '';
    });
  }

  /* ---------- Кількість, ціна, наявність ---------- */

  function maxQty(variant) {
    var max = cfg.maxQty;
    if (variant && variant.stock != null) max = Math.min(max, Math.max(variant.stock, 1));
    return max;
  }

  function setQty(value) {
    state.qty = Math.max(1, Math.min(value, maxQty(currentVariant())));
    refresh();
  }

  // Яке фото показати: фото варіанта → фото першого варіанта з обраним кольором →
  // фото товару, в описі (alt) якого згадано колір → головне фото товару.
  function imageForSelection() {
    var product = state.product;
    var variant = currentVariant();
    if (variant && variant.image) return variant.image;

    var colors = [];
    product.options.forEach(function (option, i) {
      if (COLOR_OPTION.test(option.name) && state.selected[i] != null) {
        colors.push({ index: i, value: state.selected[i] });
      }
    });
    if (!colors.length) return null;

    var matching = product.variants.filter(function (v) {
      return v.image && colors.every(function (c) { return v.options[c.index] === c.value; });
    });
    var preferred = matching.filter(function (v) { return v.available; })[0] || matching[0];
    if (preferred) return preferred.image;

    var names = colors.map(function (c) { return c.value.toLowerCase(); });
    var byAlt = (product.images || []).filter(function (img) {
      var alt = (img.alt || '').toLowerCase();
      return alt && names.every(function (n) { return alt.indexOf(n) !== -1; });
    })[0];
    return byAlt ? byAlt.src : null;
  }

  function setImage(src) {
    var next = src || state.product.image || '';
    if (!next || refs.image.getAttribute('src') === next) return;
    if (!refs.image.getAttribute('src')) { refs.image.src = next; return; }
    refs.image.classList.add('is-swapping');
    var loader = new Image();
    loader.onload = loader.onerror = function () {
      refs.image.src = next;
      refs.image.classList.remove('is-swapping');
    };
    loader.src = next;
  }

  function digits() { return nationalDigits(refs.phone.value); }
  function nameValid() { return refs.name.value.trim().length >= 2; }
  function phoneValid() { return digits().length === 9; }

  function optionMissing() {
    for (var i = 0; i < state.selected.length; i++) {
      var option = state.product.options[i];
      var isDefault = option.values.length === 1 && option.values[0] === 'Default Title';
      if (state.selected[i] == null && !isDefault) return { key: 'option-' + i, text: T.chooseOption(option.name) };
    }
    return null;
  }

  function contactMissing() {
    if (!nameValid()) return { key: 'name', text: T.enterName };
    if (!phoneValid()) return { key: 'phone', text: T.enterPhone };
    return deliveryMissing();
  }

  function firstMissing() { return optionMissing() || contactMissing(); }

  /* ---------- Кроки ---------- */

  // Контакти вже заповнені (повторний клієнт): головна кнопка на кроці 1 одразу замовляє
  function quickReady() { return !contactMissing(); }

  function recapText() {
    var parts = [[refs.name.value.trim(), refs.surname ? refs.surname.value.trim() : ''].filter(Boolean).join(' ')];
    parts.push('+380 ' + formatNational(digits()));
    var place = state.delivery.city ? (state.delivery.city.present || state.delivery.city.name) : cityText();
    if (place) parts.push(place);
    var d = state.delivery;
    if (d.method === 'courier') {
      if (d.street) parts.push(d.street.name);
    } else if (d.point) {
      parts.push(d.point.name.split(':')[0]);
    }
    return parts.filter(Boolean).join(' · ');
  }

  // На комп'ютері обидва кроки видно одразу: місця достатньо, зайві дотики не потрібні
  function isDesktop() { return window.matchMedia('(min-width: 641px)').matches; }

  function deliverySummary() {
    var d = state.delivery;
    var place = d.city ? (d.city.present || d.city.name) : cityText();
    if (!place) return '';
    var how = '';
    if (d.method === 'courier') how = d.street ? d.street.name + (refs.house.value ? ', ' + refs.house.value.trim() : '') : 'адресна доставка';
    else if (d.point) how = d.point.name.split(':')[0];
    return 'Нова пошта · ' + [how, place].filter(Boolean).join(', ');
  }

  function showStep(n, focus) {
    var both = isDesktop();
    if (both) n = 2;
    state.step = n;
    refs.step1.hidden = !both && n !== 1;
    refs.step2.hidden = !both && n !== 2;
    refs.back.hidden = both || n !== 2;
    refs.stepLabel.textContent = n === 1 ? 'Крок 1 з 2 · Товар' : 'Крок 2 з 2 · Контакти та доставка';
    refs.bar.style.width = n === 1 ? '50%' : '100%';
    refs.body.scrollTop = 0;
    hideError();
    refresh();
    if (n === 2 && !both) {
      pushHistory(2);
      if (focus !== false && !(refs.name.value.trim())) refs.name.focus({ preventScroll: true });
    }
  }

  // Назад: з кроку 2 на крок 1 (кнопка «Назад» телефона працює так само)
  function goBack() {
    if (state.step === 2) {
      if (historyDepth >= 2) history.back();
      else showStep(1, false);
    } else {
      close();
    }
  }

  function primaryAction() {
    if (state.step === 1 && !quickReady()) {
      var missing = optionMissing();
      if (missing) { highlightMissing(); return; }
      showStep(2, true);
      return;
    }
    submit();
  }

  /* ---------- Історія браузера: «Назад» закриває шторку, а не сторінку ---------- */

  var historyDepth = 0;
  var ignorePop = false;

  function pushHistory(level) {
    try {
      if (historyDepth >= level) return;
      history.pushState({ qo: level }, '');
      historyDepth = level;
    } catch (e) { /* історія недоступна */ }
  }

  function popHistory() {
    if (!historyDepth) return;
    var steps = historyDepth;
    historyDepth = 0;
    try {
      ignorePop = true;
      history.go(-steps);
    } catch (e) { ignorePop = false; }
  }

  window.addEventListener('popstate', function () {
    if (ignorePop) { ignorePop = false; return; }
    if (!dialog || !dialog.open) { historyDepth = 0; return; }
    if (state && state.step === 2 && historyDepth >= 2) {
      historyDepth = 1;
      showStep(1, false);
    } else {
      historyDepth = 0;
      close();
    }
  });

  function refresh() {
    var product = state.product;
    var variant = currentVariant();
    var source = variant || product;

    refs.price.textContent = money(source.price, product.currency);
    var onSale = source.compare_at_price > source.price;
    refs.compare.hidden = !onSale;
    refs.badge.hidden = !onSale;
    if (onSale) {
      refs.compare.textContent = money(source.compare_at_price, product.currency);
      refs.badge.textContent = '−' + Math.round((1 - source.price / source.compare_at_price) * 100) + '%';
    }
    setImage(imageForSelection());

    if (state.qty > maxQty(variant)) state.qty = maxQty(variant);
    refs.qtyInput.value = state.qty;
    dialog.querySelector('[data-qo-qty="-1"]').disabled = state.qty <= 1;
    dialog.querySelector('[data-qo-qty="1"]').disabled = state.qty >= maxQty(variant);

    if (variant) {
      refs.stock.hidden = false;
      var low = variant.stock != null && variant.stock <= 5;
      refs.stock.textContent = low ? T.low(variant.stock) : T.inStock;
      refs.stock.classList.toggle('is-low', low);
    } else {
      refs.stock.hidden = true;
    }
    refs.total.textContent = money(source.price * state.qty, product.currency);

    updateChoices();

    // Підказки під полями
    setFieldInvalid('name', state.touched.name && !nameValid());
    setFieldInvalid('phone', state.touched.phone && !phoneValid());

    var missing = state.step === 1 ? optionMissing() : firstMissing();
    // Підсвітка «зверни увагу» гасне, щойно поле виправлено
    dialog.querySelectorAll('.is-attention').forEach(function (field) {
      if (!missing || field.dataset.qoField !== missing.key) field.classList.remove('is-attention');
    });
    refs.ctaHint.textContent = missing ? missing.text : '';
    var totalText = money(source.price * state.qty, product.currency);
    if (state.step === 2) refs.submitLabel.textContent = 'Замовити · ' + totalText;
    else if (quickReady()) refs.submitLabel.textContent = 'Замовити як ' + (refs.name.value.trim().split(' ')[0] || 'раніше') + ' · ' + totalText;
    else refs.submitLabel.textContent = 'Далі';
    refs.sumLabel.textContent = state.qty > 1 ? state.qty + ' × ' + money(source.price, product.currency) : 'Разом';
    refs.sumTotal.textContent = totalText;
    refs.sumDelivery.textContent = deliverySummary();
    refs.sumDelivery.hidden = !refs.sumDelivery.textContent;
    refs.recap.hidden = !(state.step === 1 && quickReady());
    if (!refs.recap.hidden) refs.recapLine.textContent = recapText();
    refs.submit.setAttribute('aria-disabled', missing || state.submitting ? 'true' : 'false');
    refs.submit.classList.toggle('is-loading', state.submitting);
    refs.submit.setAttribute('aria-busy', state.submitting ? 'true' : 'false');
  }

  function setFieldInvalid(key, invalid) {
    var field = dialog.querySelector('[data-qo-field="' + key + '"]');
    if (field) field.classList.toggle('is-invalid', invalid);
  }

  function clearFieldStates() {
    dialog.querySelectorAll('.is-invalid, .is-attention').forEach(function (n) {
      n.classList.remove('is-invalid', 'is-attention');
    });
  }

  function highlightMissing() {
    var missing = firstMissing();
    if (!missing) return;
    var needStep = missing.key.indexOf('option-') === 0 ? 1 : 2;
    if (!isDesktop() && state.step !== needStep) showStep(needStep, false);
    if (missing.key === 'name') state.touched.name = true;
    if (missing.key === 'phone') state.touched.phone = true;
    refresh();
    var field = dialog.querySelector('[data-qo-field="' + missing.key + '"]');
    if (!field) return;
    field.scrollIntoView({
      block: 'center',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    });
    field.classList.remove('is-attention');
    void field.offsetWidth; // перезапуск анімації
    field.classList.add('is-attention');
    var focusable = field.querySelector('input, [aria-disabled="false"][tabindex="0"], .qo-choice[aria-disabled="false"]');
    var focusKeys = ['name', 'phone', 'city', 'point', 'street', 'house'];
    if (focusable && focusKeys.indexOf(missing.key) !== -1) focusable.focus({ preventScroll: true });
  }

  /* ---------- Поля ---------- */

  function onFieldInput() {
    state.touched.name = state.touched.name || nameValid();
    hideError();
    refresh();
  }

  function onPhoneInput(e) {
    var d = nationalDigits(refs.phone.value);
    // Backspace по символу маски (дужка, пробіл) не має «застрягати»
    if (e.inputType && e.inputType.indexOf('deleteContent') === 0 && d === state.prevDigits && d.length) {
      d = d.slice(0, -1);
    }
    state.prevDigits = d;
    refs.phone.value = formatNational(d);
    if (d.length === 9) state.touched.phone = true;
    hideError();
    refresh();
  }

  /* ---------- Доставка: місто й відділення Нової пошти ---------- */

  var combos = [];
  var npState = { available: true };

  function apiBase() { return cfg.endpoint.replace(/\/submit$/, ''); }

  // Запит до нашого сервера (він сам звертається до API Нової пошти з прихованим ключем)
  function npFetch(path, params, signal) {
    var query = new URLSearchParams(params).toString();
    return fetch(apiBase() + '/np/' + path + '?' + query, { signal: signal, headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok || !data || !data.ok) {
            var err = new Error('np');
            err.code = (data && data.code) || ('http_' + res.status);
            throw err;
          }
          return data.items || [];
        });
      });
  }

  // Випадаючий список з пошуком (WAI-ARIA combobox): стрілки, Enter, Esc, дотики
  function createCombobox(root, o) {
    var input = root.querySelector('input');
    var list = root.querySelector('[role="listbox"]');
    var items = [];
    var active = -1;
    var timer = null;
    var controller = null;
    var seq = 0;
    var api = {};

    function setOpen(open) {
      list.hidden = !open;
      root.classList.toggle('is-open', open);
      if (open) {
        // Якщо знизу замало місця (клавіатура), список відкривається вгору
        root.classList.remove('is-up');
        var host = refs.body.getBoundingClientRect();
        var box = input.getBoundingClientRect();
        var below = host.bottom - box.bottom;
        var above = box.top - host.top;
        if (list.offsetHeight > below - 8 && above > below) root.classList.add('is-up');
      }
      input.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) {
        active = -1;
        input.removeAttribute('aria-activedescendant');
      }
    }

    function note(text) {
      list.textContent = '';
      var row = el('li', 'qo-combo__note', text);
      row.setAttribute('role', 'presentation');
      list.appendChild(row);
      setOpen(true);
      list.scrollIntoView({ block: 'nearest' });
    }

    function renderItems() {
      list.textContent = '';
      items.forEach(function (item, i) {
        var row = el('li', 'qo-combo__opt');
        row.id = list.id + '-' + i;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');
        row.dataset.i = String(i);
        row.appendChild(el('span', 'qo-combo__main', o.main(item)));
        var sub = o.sub ? o.sub(item) : '';
        if (sub) row.appendChild(el('span', 'qo-combo__sub', sub));
        list.appendChild(row);
      });
      active = -1;
      setOpen(true);
      list.scrollIntoView({ block: 'nearest' });
    }

    function highlight(index) {
      var rows = list.querySelectorAll('[role="option"]');
      if (!rows.length) return;
      if (index < 0) index = rows.length - 1;
      if (index >= rows.length) index = 0;
      Array.prototype.forEach.call(rows, function (row, k) {
        row.setAttribute('aria-selected', k === index ? 'true' : 'false');
      });
      active = index;
      input.setAttribute('aria-activedescendant', rows[index].id);
      rows[index].scrollIntoView({ block: 'nearest' });
    }

    var focused = function () { return document.activeElement === input; };

    function run(query) {
      // Пошук спрацював після того, як клієнт пішов з поля: список не відкриваємо
      if (!focused()) { setOpen(false); return; }
      if (controller) controller.abort();
      controller = typeof AbortController === 'function' ? new AbortController() : null;
      var mine = ++seq;
      note(T.npLoading);
      o.fetch(query, controller && controller.signal).then(function (result) {
        if (mine !== seq) return;
        items = result;
        if (!focused()) { setOpen(false); return; }
        if (items.length) renderItems(); else note(T.npEmpty);
      }, function (err) {
        if (mine !== seq || (err && err.name === 'AbortError')) return;
        items = [];
        if (focused()) note(T.npError); else setOpen(false);
        if (o.onError) o.onError(err);
      });
    }

    function schedule(immediate) {
      clearTimeout(timer);
      var query = input.value.trim();
      if (!o.enabled()) { setOpen(false); return; }
      if (query.length < (o.minChars || 0)) { seq++; setOpen(false); return; }
      timer = setTimeout(function () { run(query); }, immediate ? 0 : 250);
    }

    function pick(index) {
      var item = items[index];
      if (!item) return;
      clearTimeout(timer);
      seq++;
      input.value = o.label(item);
      setOpen(false);
      o.onPick(item);
    }

    input.addEventListener('input', function () { o.onType(input.value); schedule(false); });
    input.addEventListener('focus', function () {
      if (input.value && o.hasValue()) input.select();
      if (o.loadOnFocus && !o.hasValue()) schedule(true);
      // На телефоні піднімаємо поле, щоб список не ховався під клавіатурою
      if (window.matchMedia('(max-width: 640px)').matches) {
        setTimeout(function () { root.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 300);
      }
    });
    input.addEventListener('keydown', function (e) {
      var open = !list.hidden;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!open) schedule(true); else highlight(active + 1);
      } else if (e.key === 'ArrowUp' && open) {
        e.preventDefault();
        highlight(active - 1);
      } else if (e.key === 'Enter' && open && active >= 0) {
        e.preventDefault();
        pick(active);
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    });
    input.addEventListener('blur', function () { setTimeout(function () { setOpen(false); }, 150); });
    list.addEventListener('mousedown', function (e) { e.preventDefault(); }); // не втрачати фокус поля
    list.addEventListener('click', function (e) {
      var row = e.target.closest('[role="option"]');
      if (row) pick(Number(row.dataset.i));
    });

    api.close = function () { var was = !list.hidden; setOpen(false); return was; };
    api.reset = function () { clearTimeout(timer); seq++; items = []; setOpen(false); };
    combos.push(api);
    return api;
  }

  // Місто для повідомлення: обране зі списку (коротка назва) або введене вручну
  function cityText() {
    if (!refs.city) return '';
    return state.delivery && state.delivery.city ? state.delivery.city.name : refs.city.value.trim();
  }

  function deliveryActive() {
    return !!(refs.deliveryRoot && cfg.np && npState.available && state.delivery.city);
  }

  var CITY_HINT = 'Оберіть місто зі списку, і ми запропонуємо відділення Нової пошти';

  function showNp() {
    if (refs.npBlock) refs.npBlock.hidden = !deliveryActive();
    if (refs.cityHint) {
      refs.cityHint.hidden = deliveryActive();
      refs.cityHint.textContent = npState.available && cfg.np ? CITY_HINT : 'Введіть місто, менеджер уточнить відділення';
    }
  }

  function clearPoint() {
    state.delivery.point = null;
    if (refs.point) refs.point.value = '';
    if (refs.pointCombo) refs.pointCombo.reset();
  }

  function clearStreet() {
    state.delivery.street = null;
    if (refs.street) refs.street.value = '';
    if (refs.house) refs.house.value = '';
    if (refs.apartment) refs.apartment.value = '';
    if (refs.streetCombo) refs.streetCombo.reset();
  }

  function setMethod(method) {
    state.delivery.method = method;
    refs.deliveryRoot.querySelectorAll('[data-qo-method]').forEach(function (btn) {
      var on = btn.dataset.qoMethod === method;
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
    });
    var courier = method === 'courier';
    refs.pointField.hidden = courier;
    refs.courier.hidden = !courier;
    refs.pointLabel.textContent = method === 'postomat' ? T.postomat : T.branch;
    refs.point.placeholder = method === 'postomat' ? T.postomatHint : T.branchHint;
    clearPoint();
    clearStreet();
  }

  function initDelivery() {
    if (!refs.deliveryRoot || refs.cityCombo) return;
    var box = function (name) { return refs.deliveryRoot.querySelector('[data-qo-combo="' + name + '"]'); };

    refs.cityCombo = createCombobox(box('city'), {
      minChars: 2,
      enabled: function () { return cfg.np && npState.available; },
      hasValue: function () { return !!state.delivery.city; },
      fetch: function (query, signal) { return npFetch('cities', { q: query }, signal); },
      main: function (c) { return c.present || c.name; },
      sub: function (c) { return c.warehouses ? c.warehouses + ' відділень Нової пошти' : ''; },
      label: function (c) { return c.present || c.name; },
      onType: function () {
        // Місто, змінене вручну, більше не привʼязане до списку: відділення обирається заново
        state.delivery.city = null;
        clearPoint();
        clearStreet();
        showNp();
        refresh();
      },
      onPick: function (c) {
        state.delivery.city = c;
        clearPoint();
        clearStreet();
        showNp();
        refresh();
      },
      // Нова пошта недоступна: лишається звичайне текстове поле, замовлення не блокується
      onError: function () { npState.available = false; showNp(); refresh(); }
    });

    refs.pointCombo = createCombobox(box('point'), {
      minChars: 0,
      loadOnFocus: true,
      enabled: function () { return deliveryActive() && state.delivery.method !== 'courier'; },
      hasValue: function () { return !!state.delivery.point; },
      fetch: function (query, signal) {
        return npFetch('points', {
          settlement: state.delivery.city.ref,
          kind: state.delivery.method === 'postomat' ? 'postomat' : 'warehouse',
          q: query
        }, signal);
      },
      main: function (p) { return p.name.split(':')[0]; },
      sub: function (p) { return [p.address, p.hours].filter(Boolean).join(' · '); },
      label: function (p) { return p.name; },
      onType: function () { state.delivery.point = null; refresh(); },
      onPick: function (p) { state.delivery.point = p; refresh(); }
    });

    refs.streetCombo = createCombobox(box('street'), {
      minChars: 2,
      enabled: function () { return deliveryActive() && state.delivery.method === 'courier'; },
      hasValue: function () { return !!state.delivery.street; },
      fetch: function (query, signal) { return npFetch('streets', { settlement: state.delivery.city.ref, q: query }, signal); },
      main: function (st) { return st.name; },
      label: function (st) { return st.name; },
      onType: function () { state.delivery.street = null; refresh(); },
      onPick: function (st) { state.delivery.street = st; refresh(); }
    });

    refs.deliveryRoot.querySelectorAll('[data-qo-method]').forEach(function (btn) {
      btn.addEventListener('click', function () { setMethod(btn.dataset.qoMethod); refresh(); });
      btn.addEventListener('keydown', function (e) {
        var order = ['warehouse', 'postomat', 'courier'];
        var step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!step) return;
        e.preventDefault();
        var next = order[(order.indexOf(btn.dataset.qoMethod) + step + order.length) % order.length];
        setMethod(next);
        refs.deliveryRoot.querySelector('[data-qo-method="' + next + '"]').focus();
        refresh();
      });
    });
    refs.house.addEventListener('input', refresh);
  }

  // Повертаємо те, що клієнт вводив минулого разу (місто, відділення), щоб не вводити знову
  function restoreDelivery(saved) {
    if (!refs.city) return;
    refs.city.value = saved.city || '';
    if (!refs.deliveryRoot) return;
    setMethod('warehouse');
    var d = saved.delivery;
    if (d && d.city && d.city.ref) {
      state.delivery.city = { ref: d.city.ref, name: d.city.name, present: d.city.present, area: d.city.area };
      refs.city.value = d.city.present || d.city.name;
      if (d.method) setMethod(d.method);
      if (d.method === 'courier') {
        if (d.street && d.street.name) {
          state.delivery.street = d.street;
          refs.street.value = d.street.name;
        }
        refs.house.value = d.house || '';
        refs.apartment.value = d.apartment || '';
      } else if (d.point && d.point.name) {
        state.delivery.point = d.point;
        refs.point.value = d.point.name;
      }
    }
    showNp();
  }

  function deliveryMissing() {
    if (!cfg.npRequire || !refs.deliveryRoot) return null;
    var d = state.delivery;
    if (!npState.available || !cfg.np) {
      return cityText() ? null : { key: 'city', text: T.enterCity };
    }
    if (!d.city) return { key: 'city', text: T.chooseCity };
    if (d.method === 'courier') {
      if (!d.street) return { key: 'street', text: T.chooseStreet };
      if (!refs.house.value.trim()) return { key: 'house', text: T.enterHouse };
      return null;
    }
    if (!d.point) return { key: 'point', text: d.method === 'postomat' ? T.choosePostomat : T.chooseBranch };
    return null;
  }

  function deliveryPayload() {
    if (!refs.deliveryRoot) return null;
    var d = state.delivery;
    var out = {
      city: d.city
        ? { ref: d.city.ref, name: d.city.name, present: d.city.present, area: d.city.area }
        : { name: cityText() }
    };
    if (deliveryActive()) {
      out.method = d.method;
      if (d.method === 'courier') {
        if (d.street) out.street = { ref: d.street.ref, name: d.street.name };
        out.house = refs.house.value.trim();
        out.apartment = refs.apartment.value.trim();
      } else if (d.point) {
        out.point = { ref: d.point.ref, number: d.point.number, name: d.point.name };
      }
    }
    return out;
  }

  /* ---------- Робочі години ---------- */

  function isAfterHours() {
    var h = hourIn(cfg.tz, new Date());
    return h < cfg.workStart || h >= cfg.workEnd;
  }

  function hoursText() {
    return cfg.afterHoursText
      .replace('{start}', pad(cfg.workStart))
      .replace('{end}', pad(cfg.workEnd));
  }

  /* ---------- Відправка ---------- */

  function showError(message) {
    refs.error.textContent = message;
    refs.error.hidden = false;
  }
  function hideError() {
    if (refs.error) refs.error.hidden = true;
  }

  function submit() {
    if (state.submitting) return;
    if (firstMissing()) { highlightMissing(); return; }
    var variant = currentVariant();
    if (!variant) { highlightMissing(); return; }

    state.submitting = true;
    hideError();
    refresh();

    var payload = {
      product_handle: state.product.handle,
      variant_id: variant.id,
      quantity: state.qty,
      name: refs.name.value.trim(),
      surname: refs.surname ? refs.surname.value.trim() : '',
      body: state.body || undefined,
      phone: '+380' + digits(),
      comment: refs.comment ? refs.comment.value.trim() : '',
      city: cityText(),
      delivery: deliveryPayload(),
      utm: (readAttribution() || {}).utm || {},
      referrer: (readAttribution() || {}).referrer || '',
      click: (readAttribution() || {}).click || '',
      page_url: window.location.origin + state.product.url,
      client_id: state.clientId,
      website: refs.honeypot.value
    };

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);

    fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function (result) {
        clearTimeout(timer);
        state.submitting = false;
        if (result.ok && result.data && result.data.ok) {
          onSuccess(result.data, variant, payload);
        } else {
          onFailure(result.data);
        }
      })
      .catch(function () {
        clearTimeout(timer);
        state.submitting = false;
        showError(T.network);
        refresh();
      });
  }

  function onFailure(data) {
    if (data && data.code === 'sold_out') {
      var variant = currentVariant();
      if (variant) variant.available = false;
      state.selected = state.selected.map(function (s, i) {
        return valueAvailable(i, s) ? s : null;
      });
      showError(T.soldOutNow);
    } else {
      showError((data && data.message) || T.generic);
      if (data && (data.field === 'name' || data.field === 'phone')) {
        state.touched[data.field] = true;
      }
    }
    refresh();
  }

  function onSuccess(data, variant, payload) {
    writeStore({ body: payload.body, name: payload.name, surname: payload.surname, phone: digits(), city: payload.city, delivery: payload.delivery });

    refs.successTitle.textContent = T.thanks(data.order_number);
    refs.successSummary.textContent = '';
    var rows = [[T.product, state.product.title]];
    state.product.options.forEach(function (option, i) {
      if (state.selected[i] && state.selected[i] !== 'Default Title') rows.push([option.name, state.selected[i]]);
    });
    rows.push([T.qty, String(state.qty)]);
    rows.push([T.total, money(variant.price * state.qty, state.product.currency)]);
    rows.push([T.phone, '+380 ' + formatNational(digits())]);
    rows.forEach(function (row) {
      var line = el('div');
      line.appendChild(el('dt', '', row[0]));
      line.appendChild(el('dd', '', row[1]));
      refs.successSummary.appendChild(line);
    });

    refs.successNote.textContent = $('[data-qo-note]').textContent;
    var after = data.after_hours != null ? data.after_hours : isAfterHours();
    refs.successHours.hidden = !after;
    if (after) refs.successHours.textContent = hoursText();

    setView('success');
    refs.body.scrollTop = 0;
    refs.successTitle.focus({ preventScroll: true });

    track(data, variant);
  }

  // Події для аналітики: customEvent, dataLayer (GTM), Google Analytics 4 і Meta Pixel
  function track(data, variant) {
    var product = state.product;
    var total = (variant.price * state.qty) / 100;
    var detail = {
      order_number: data.order_number, value: total, currency: product.currency,
      variant_id: variant.id, sku: variant.sku || '', item_name: product.title, quantity: state.qty
    };
    try {
      document.dispatchEvent(new CustomEvent('quickorder:submitted', { detail: detail }));
      if (Array.isArray(window.dataLayer)) {
        window.dataLayer.push({ event: 'quick_order', quick_order: detail });
      }
      if (cfg.trackGa && typeof window.gtag === 'function') {
        window.gtag('event', 'generate_lead', {
          currency: product.currency, value: total, transaction_id: data.order_number,
          items: [{ item_id: variant.sku || String(variant.id), item_name: product.title, quantity: state.qty, price: variant.price / 100 }]
        });
      }
      if (cfg.trackMeta && typeof window.fbq === 'function') {
        window.fbq('track', 'Lead', {
          value: total, currency: product.currency, content_name: product.title,
          content_ids: [String(variant.id)], content_type: 'product'
        }, { eventID: data.order_number });
      }
    } catch (e) { /* аналітика ніколи не ламає замовлення */ }
  }

  /* ---------- Свайп вниз (мобільний) ---------- */

  function initSwipe() {
    var startY = null;
    var dy = 0;
    var handles = dialog.querySelectorAll('[data-qo-grabber], [data-qo-swipe]');
    handles.forEach(function (handle) {
      handle.addEventListener('touchstart', function (e) {
        if (!window.matchMedia('(max-width: 640px)').matches) return;
        startY = e.touches[0].clientY;
        dy = 0;
        sheet.classList.add('is-dragging');
      }, { passive: true });
      handle.addEventListener('touchmove', function (e) {
        if (startY == null) return;
        dy = Math.max(0, e.touches[0].clientY - startY);
        sheet.style.transform = 'translateY(' + dy + 'px)';
      }, { passive: true });
      var end = function () {
        if (startY == null) return;
        startY = null;
        sheet.classList.remove('is-dragging');
        if (dy > 90) close();
        else sheet.style.transform = '';
      };
      handle.addEventListener('touchend', end);
      handle.addEventListener('touchcancel', end);
    });
  }

  /* ---------- Кнопки на сторінці ---------- */

  // Готуємо попап до відкриття, щойно палець торкнувся кнопки: відкривається миттєво
  var warmed = {};
  function warm(e) {
    var trigger = e.target.closest && e.target.closest('[data-qo-open]');
    if (!trigger || warmed[trigger.dataset.qoProduct]) return;
    warmed[trigger.dataset.qoProduct] = true;
    try {
      init();
      var product = loadProduct(trigger.dataset.qoProduct);
      if (product && product.image) new Image().src = product.image;
    } catch (err) { /* підготовка не критична */ }
  }
  ['touchstart', 'pointerover', 'focusin'].forEach(function (name) {
    document.addEventListener(name, warm, { passive: true, capture: true });
  });

  document.addEventListener('click', function (e) {
    var trigger = e.target.closest && e.target.closest('[data-qo-open]');
    if (!trigger) return;
    e.preventDefault();
    e.stopPropagation();
    open(loadProduct(trigger.dataset.qoProduct), trigger);
  });

  /* ---------- Підгонка під тему ---------- */

  // Копіюємо вигляд кнопки «Додати до кошика»: форму, рамку, шрифт, висоту.
  // Так кнопка швидкого замовлення виглядає рідною в будь-якій темі.
  var REF_SELECTORS = [
    'form[action*="/cart/add"] button[type="submit"]',
    'form[action*="/cart/add"] [name="add"]',
    '.product-form__submit',
    'button[name="add"]'
  ];

  function parseRgb(value) {
    var m = String(value).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    var p = m[1].split(/[ ,\/]+/).filter(Boolean).map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  function isOpaque(c) { return c && c.a > 0.05; }

  function onAccent(c) {
    if (!c) return '#fff';
    var lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
    return lum > 0.6 ? '#000' : '#fff';
  }

  function findReference(blocks) {
    var triggerTop = blocks[0].querySelector('.qo-trigger').getBoundingClientRect().top;
    var best = null;
    var fallback = null;
    REF_SELECTORS.forEach(function (selector) {
      document.querySelectorAll(selector).forEach(function (node) {
        if (node.closest('.qo-root, .qo-block')) return;
        var rect = node.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 20) return;
        fallback = fallback || node;
        // Найближча основна кнопка над нашою
        if (rect.bottom <= triggerTop + 1 && (!best || rect.bottom > best.getBoundingClientRect().bottom)) best = node;
      });
    });
    return { style: best || fallback, above: best };
  }

  function matchTheme() {
    var blocks = document.querySelectorAll('[data-qo-block]');
    if (!blocks.length) return;
    var ref = findReference(blocks);
    if (!ref.style) return;

    var cs = getComputedStyle(ref.style);
    var rect = ref.style.getBoundingClientRect();
    var bg = parseRgb(cs.backgroundColor);
    var border = parseRgb(cs.borderTopColor);
    var borderWidth = parseFloat(cs.borderTopWidth) || 0;
    var text = parseRgb(cs.color);
    var accent = isOpaque(bg) ? bg : (isOpaque(border) && borderWidth > 0 ? border : text);
    var accentCss = accent
      ? 'rgb(' + accent.r + ',' + accent.g + ',' + accent.b + ')'
      : '#000';
    var radius = parseFloat(cs.borderTopLeftRadius) || 0;
    if (radius >= rect.height / 2) radius = 999;

    var set = document.documentElement.style;
    set.setProperty('--qo-btn-radius', radius + 'px');
    set.setProperty('--qo-btn-border', Math.max(borderWidth, 1) + 'px');
    set.setProperty('--qo-btn-font', cs.fontFamily);
    set.setProperty('--qo-btn-weight', cs.fontWeight);
    set.setProperty('--qo-btn-size', cs.fontSize);
    set.setProperty('--qo-btn-spacing', cs.letterSpacing);
    set.setProperty('--qo-btn-transform', cs.textTransform);
    set.setProperty('--qo-btn-height', Math.round(Math.min(Math.max(rect.height, 40), 72)) + 'px');
    set.setProperty('--qo-btn-accent', accentCss);
    set.setProperty('--qo-btn-on-accent', onAccent(accent));
    set.setProperty('--qo-input-radius', Math.min(radius, 12) + 'px');

    fitSpacing(blocks, ref.above);
  }

  // Темам властивий великий відступ між блоками. Підтягуємо нашу кнопку до основної
  // і вирівнюємо відступ із нижнім сусідом.
  function fitSpacing(blocks, above) {
    blocks.forEach(function (block) {
      block.style.marginTop = '';
      block.style.marginBottom = '';
      if (block.dataset.qoAutofit !== 'true' || !above) return;
      var trigger = block.querySelector('.qo-trigger');
      var target = Number(block.dataset.qoGap);
      if (isNaN(target)) target = 12;
      var gap = trigger.getBoundingClientRect().top - above.getBoundingClientRect().bottom;
      if (gap > target + 2 && gap < 220) {
        var delta = Math.round(gap - target);
        block.style.marginTop = -delta + 'px';
        block.style.marginBottom = -delta + 'px';
      }
    });
  }

  var themeTimer;
  function scheduleTheme() {
    clearTimeout(themeTimer);
    themeTimer = setTimeout(matchTheme, 120);
  }
  matchTheme();
  setTimeout(matchTheme, 800);
  window.addEventListener('load', matchTheme);
  window.addEventListener('resize', scheduleTheme);
  document.addEventListener('shopify:section:load', scheduleTheme);
  document.addEventListener('shopify:block:select', scheduleTheme);

  // Sticky-кнопка внизу екрана, коли основна вийшла з поля зору
  function initSticky() {
    if (!('IntersectionObserver' in window)) return;
    document.querySelectorAll('[data-qo-block]').forEach(function (block) {
      var sticky = block.querySelector('[data-qo-sticky]');
      var main = block.querySelector('.qo-trigger');
      if (!sticky || !main || block.__qoSticky) return;
      block.__qoSticky = true;
      new IntersectionObserver(function (entries) {
        var visible = entries[0].isIntersecting;
        sticky.classList.toggle('is-visible', !visible);
        sticky.setAttribute('aria-hidden', visible ? 'true' : 'false');
        sticky.querySelector('button').tabIndex = visible ? -1 : 0;
      }).observe(main);
    });
  }

  // М'яке підсвічування кнопки, якщо відвідувач довго не натискає (не більше 3 разів, не при reduce motion)
  function initNudge() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.querySelectorAll('[data-qo-block]').forEach(function (block) {
      var btn = block.querySelector('.qo-trigger');
      if (block.dataset.qoNudge !== 'true' || !btn || block.__qoNudge) return;
      block.__qoNudge = true;

      var visible = false;
      var shown = 0;
      var loops = 0;
      var done = false;
      var timer;
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; }, { threshold: 0.6 }).observe(btn);
      } else {
        visible = true;
      }
      var stop = function () {
        done = true;
        clearTimeout(timer);
        btn.classList.remove('is-nudging');
      };
      ['pointerenter', 'focus', 'click', 'touchstart'].forEach(function (name) {
        btn.addEventListener(name, stop, { passive: true });
      });
      btn.addEventListener('animationend', function () { btn.classList.remove('is-nudging'); });

      var schedule = function (delay) {
        timer = setTimeout(function () {
          if (done || shown >= 3 || loops++ > 30) return;
          var modalOpen = dialog && dialog.open;
          if (visible && !modalOpen && !document.hidden) {
            shown += 1;
            btn.classList.remove('is-nudging');
            void btn.offsetWidth;
            btn.classList.add('is-nudging');
          }
          schedule(12000);
        }, delay);
      };
      schedule(8000);
    });
  }

  captureAttribution();
  initSticky();
  initNudge();
  document.addEventListener('shopify:section:load', function () { initSticky(); initNudge(); });

  window.QuickOrder = {
    open: function (product) { open(product, null); },
    _test: { nationalDigits: nationalDigits, formatNational: formatNational, money: money, parseColorMap: parseColorMap, pickTheme: pickTheme }
  };
})();
