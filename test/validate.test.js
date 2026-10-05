import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, normalizePhone, validateSubmission } from '../server/validate.js';

test('normalizePhone: українські формати', () => {
  for (const raw of ['0671234567', '+380671234567', '380671234567', '+380 (67) 123 45 67', '067 123-45-67']) {
    assert.equal(normalizePhone(raw), '+380671234567', raw);
  }
});

test('normalizePhone: міжнародні та сміття', () => {
  assert.equal(normalizePhone('+48 600 100 200'), '+48600100200');
  for (const raw of ['', '12345', '+380123', 'abc', null, undefined, 123]) {
    assert.equal(normalizePhone(raw), null, String(raw));
  }
});

test('normalizeName: чистить розмітку й пробіли', () => {
  assert.equal(normalizeName('  Іван   Петренко '), 'Іван Петренко');
  assert.equal(normalizeName('<b>Ян</b>'), 'b Ян /b');
  assert.equal(normalizeName('І'), null);
  assert.equal(normalizeName('а'.repeat(61)), null);
});

const good = { product_handle: 'tee', variant_id: '1', quantity: 1, name: 'Іван', phone: '0671234567' };

test('validateSubmission: успіх і нормалізація', () => {
  const r = validateSubmission({ ...good, page_url: 'https://x.test/p', client_id: 'abcdefgh1' }, { maxQty: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.value.phone, '+380671234567');
  assert.equal(r.value.honeypot, false);
});

test('validateSubmission: відхиляє погані поля', () => {
  const cases = [
    [{ ...good, product_handle: '../x' }, 'bad_request'],
    [{ ...good, variant_id: 'abc' }, 'variant'],
    [{ ...good, quantity: 0 }, 'quantity'],
    [{ ...good, quantity: 11 }, 'quantity'],
    [{ ...good, quantity: 1.5 }, 'quantity'],
    [{ ...good, name: '' }, 'name'],
    [{ ...good, phone: '123' }, 'phone'],
    [null, 'bad_request'],
  ];
  for (const [body, code] of cases) {
    const r = validateSubmission(body, { maxQty: 10 });
    assert.equal(r.ok, false);
    assert.equal(r.code, code);
  }
});

test('validateSubmission: honeypot і небезпечний page_url', () => {
  const r = validateSubmission({ ...good, website: 'http://spam', page_url: 'javascript:alert(1)' }, { maxQty: 10 });
  assert.equal(r.value.honeypot, true);
  assert.equal(r.value.pageUrl, '');
});
