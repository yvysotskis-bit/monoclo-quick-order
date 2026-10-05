import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Shopify відхиляє весь реліз, якщо схема налаштувань порушує його правила.
// Ці перевірки повторюють найчастіші з них, щоб помилка ловилась до deploy.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../extensions/quick-order/blocks');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.liquid'));

function schemaOf(file) {
  const source = fs.readFileSync(path.join(dir, file), 'utf8');
  const match = source.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
  assert.ok(match, `${file}: немає {% schema %}`);
  return JSON.parse(match[1]);
}

for (const file of files) {
  test(`схема ${file}: налаштування відповідають правилам Shopify`, () => {
    const schema = schemaOf(file);
    assert.ok(schema.name && schema.name.length <= 25, 'name до 25 символів');
    assert.ok(['section', 'body', 'head', 'compliance_head'].includes(schema.target));

    const ids = new Set();
    for (const s of schema.settings) {
      const where = `${file} → ${s.id || s.content}`;
      assert.ok(s.type, `${where}: немає type`);
      if (s.type === 'header') { assert.ok(s.content, `${where}: header без content`); continue; }
      assert.ok(s.id && /^[a-z0-9_]+$/.test(s.id), `${where}: некоректний id`);
      assert.ok(!ids.has(s.id), `${where}: id повторюється`);
      ids.add(s.id);
      assert.ok(s.label, `${where}: немає label`);

      switch (s.type) {
        case 'url':
          // Для url дозволені лише внутрішні посилання за замовчуванням
          assert.ok(!('default' in s) || /^(\/|shopify:\/\/)/.test(s.default), `${where}: url не може мати зовнішній default`);
          break;
        case 'checkbox':
          assert.equal(typeof s.default, 'boolean', `${where}: default має бути true/false`);
          break;
        case 'select':
          assert.ok(s.options?.length >= 2, `${where}: потрібно щонайменше 2 варіанти`);
          assert.ok(s.options.every((o) => o.value && o.label), `${where}: кожен варіант має value і label`);
          assert.ok(s.options.some((o) => o.value === s.default), `${where}: default має бути серед варіантів`);
          break;
        case 'range': {
          assert.equal(typeof s.default, 'number', `${where}: default має бути числом`);
          assert.ok(s.default >= s.min && s.default <= s.max, `${where}: default поза min..max`);
          assert.equal((s.default - s.min) % s.step, 0, `${where}: default не кратний step`);
          assert.ok((s.max - s.min) / s.step <= 101, `${where}: у діапазоні понад 101 крок`);
          break;
        }
        case 'color':
          assert.ok(!('default' in s) || /^#[0-9a-fA-F]{6}$/.test(s.default), `${where}: color default має бути #rrggbb`);
          break;
        case 'text':
        case 'textarea':
          assert.ok(!('default' in s) || typeof s.default === 'string');
          break;
        default:
          assert.fail(`${where}: невідомий або неперевірений тип ${s.type}`);
      }
    }
  });
}
