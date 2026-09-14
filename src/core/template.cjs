/**
 * template — mustache-subset renderer for templated-text summaries.
 * Supports {{variable}} tags only (no sections/partials — deliberately:
 * one line of output, terse by house style). Unknown variables render
 * empty, per mustache semantics. Values are inserted as plain text by
 * the renderer side (textContent), so no escaping is performed here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Template = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TAG = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

  function render(tpl, args) {
    return String(tpl ?? '').replace(TAG, (_m, key) =>
      args && key in args && args[key] != null ? String(args[key]) : ''
    );
  }

  return { render };
});
