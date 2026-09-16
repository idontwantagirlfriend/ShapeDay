'use strict';
const test = require('node:test');
const assert = require('node:assert');
const I18N = require('../src/core/i18n.cjs');

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
  assert.strictEqual(
    I18N.t('zh-hans', 'eta.ai_adjusted', { n: 3 }),
    'AI 调整了 3 项预计，请再核对'
  );
  assert.strictEqual(
    I18N.t('en-us', 'eta.ai_adjusted', { n: 3 }),
    'AI adjusted 3 estimate(s) — review again'
  );
  assert.strictEqual(I18N.t('zh-hans', 'toast.next_up', { title: '写文档' }), '接下来：写文档。');
  // missing param leaves the placeholder visible rather than dropping it
  assert.ok(I18N.t('en-us', 'eta.ai_adjusted').includes('{n}'));
});

test('every locale covers the full en key set — catalogs cannot drift', () => {
  const enKeys = Object.keys(I18N.LOCALES['en-us']).sort();
  for (const loc of ['zh-hans', 'zh-hant']) {
    const keys = Object.keys(I18N.LOCALES[loc]).sort();
    const missing = enKeys.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !enKeys.includes(k));
    assert.deepStrictEqual(missing, [], `${loc} missing: ${missing.join(', ')}`);
    assert.deepStrictEqual(extra, [], `${loc} extra: ${extra.join(', ')}`);
  }
});

test('no duplicate keys within a locale (parsed from source)', () => {
  const fs = require('fs');
  const src = fs.readFileSync('src/core/i18n.cjs', 'utf8');
  for (const loc of ['en', 'zhHans', 'zhHant']) {
    const block = src.match(new RegExp(`const ${loc} = \\{(.*?)\\n  };`, 's'))[1];
    const keys = [...block.matchAll(/'([^']+)':/g)].map((m) => m[1]);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepStrictEqual(dupes, [], `${loc} duplicate keys: ${dupes.join(', ')}`);
  }
});
