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

test('t translates, falls back to English, then to the key', () => {
  assert.strictEqual(I18N.t('zh-hans', 'Plan'), '计划');
  assert.strictEqual(I18N.t('zh-hant', 'Week summary'), '週總結');
  assert.strictEqual(I18N.t('en-us', 'Plan'), 'Plan');
  assert.strictEqual(I18N.t('zh-hans', 'no such key'), 'no such key');
});

test('status vocabulary words localize for the reflog', () => {
  assert.strictEqual(I18N.t('zh-hans', 'red'), '红');
  assert.strictEqual(I18N.t('zh-hans', 'green'), '绿');
  assert.strictEqual(I18N.t('zh-hant', 'green'), '綠');
});
