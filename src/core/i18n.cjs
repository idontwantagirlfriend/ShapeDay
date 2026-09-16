/**
 * i18n — thin loader over per-locale YAML catalogs (locales/<locale>.yaml).
 * Keys are enums, values are {placeholder} templates. The catalogs live in
 * data, not code: the main process reads the YAML files once and hands the
 * parsed dictionaries to every renderer via IPC; t() is pure lookup with
 * en-us fallback, then the raw key (a visible sentinel, never a crash).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('node:fs'), require('node:path'), require('js-yaml'));
  } else {
    root.I18N = factory(null, null, null);
  }
})(typeof self !== 'undefined' ? self : this, function (fs, path, yaml) {
  'use strict';

  const LOCALES = { 'en-us': null, 'zh-hans': null, 'zh-hant': null }; // catalogs registry

  /** Map any platform tag onto the three supported locales. */
  function resolve(pref, platformLang) {
    const raw = String(pref === 'auto' || !pref ? platformLang || '' : pref).toLowerCase();
    if (/(hant|tw|hk|mo)/.test(raw) && raw.startsWith('zh')) return 'zh-hant';
    if (raw.startsWith('zh')) return 'zh-hans';
    return 'en-us';
  }

  /** Register catalogs (main reads YAML; renderers receive them via IPC). */
  function setCatalogs(catalogs) {
    for (const [loc, dict] of Object.entries(catalogs || {})) LOCALES[loc] = dict;
  }

  /** Read one YAML catalog from disk (main process). */
  function loadCatalog(dir, locale) {
    return yaml.load(fs.readFileSync(path.join(dir, locale + '.yaml'), 'utf8'));
  }

  /** t(locale, key, params?) — template lookup with {placeholder} substitution. */
  function t(locale, key, params) {
    const dict = LOCALES[locale] || {};
    const en = LOCALES['en-us'] || {};
    const tpl = dict[key] ?? en[key] ?? key;
    if (tpl == null || !params) return tpl ?? key;
    return String(tpl).replace(/\{(\w+)\}/g, (m, name) =>
      params[name] != null ? String(params[name]) : m
    );
  }

  return { t, resolve, setCatalogs, loadCatalog, LOCALES };
});
