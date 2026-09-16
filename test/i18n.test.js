'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const yaml = require('js-yaml');
const I18N = require('../src/core/i18n.cjs');

const load = (loc) => yaml.load(fs.readFileSync(`locales/${loc}.yaml`, 'utf8'));
I18N.setCatalogs({ 'en-us': load('en-us'), 'zh-hans': load('zh-hans'), 'zh-hant': load('zh-hant') });

test('resolve maps platform tags onto the three locales', () => {
  assert.strictEqual(I18N.resolve('auto', 'zh-CN'), 'zh-hans');
  assert.strictEqual(I18N.resolve('auto', 'zh-TW'), 'zh-hant');
  assert.strictEqual(I18N.resolve('auto', 'zh-Hant-HK'), 'zh-hant');
  assert.strictEqual(I18N.resolve('zh-hant', 'en-US'), 'zh-hant'); // explicit wins
  assert.strictEqual(I18N.resolve('auto', 'en-GB'), 'en-us');
  assert.strictEqual(I18N.resolve('auto', 'fr-FR'), 'en-us'); // unknown → English
});

test('t translates enum keys; unknown keys surface as themselves', () => {
  assert.strictEqual(I18N.t('zh-hans', 'tabs.plan'), '计划');
  assert.strictEqual(I18N.t('zh-hant', 'viz.week_summary'), '週總結');
  assert.strictEqual(I18N.t('en-us', 'tabs.plan'), 'Plan');
  assert.strictEqual(I18N.t('zh-hans', 'no.such.key'), 'no.such.key');
});

test('templates interpolate placeholders with per-language word order', () => {
  assert.strictEqual(I18N.t('zh-hans', 'eta.ai_adjusted', { n: 3 }), 'AI 调整了 3 项预计，请再核对');
  assert.strictEqual(I18N.t('en-us', 'eta.ai_adjusted', { n: 3 }), 'AI adjusted 3 estimate(s) — review again');
  assert.ok(I18N.t('en-us', 'eta.ai_adjusted').includes('{n}')); // missing param stays visible
});

test('YAML catalogs: full key parity across locales', () => {
  const en = load('en-us');
  const enKeys = Object.keys(en).sort();
  for (const loc of ['zh-hans', 'zh-hant']) {
    const d = load(loc);
    const missing = enKeys.filter((k) => !(k in d) || d[k] == null);
    const extra = Object.keys(d).filter((k) => !(k in en));
    assert.deepStrictEqual(missing, [], `${loc} missing: ${missing.join(', ')}`);
    assert.deepStrictEqual(extra, [], `${loc} extra: ${extra.join(', ')}`);
  }
});

test('YAML catalogs: no duplicate keys per file (last-wins is silent in YAML)', () => {
  for (const loc of ['en-us', 'zh-hans', 'zh-hant']) {
    const raw = fs.readFileSync(`locales/${loc}.yaml`, 'utf8');
    const keys = [...raw.matchAll(/^(?!\#)([\w.]+):/gm)].map((m) => m[1]);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepStrictEqual(dupes, [], `${loc} duplicate keys: ${dupes.join(', ')}`);
  }
});
