/**
 * estimator — the ETA "AI" (PROJECT.md: "AI estimates ETA at the beginning,
 * human reviews it"). Deliberately a pluggable pure function: swap in an LLM
 * later by implementing the same signature — (taskTitle, history) => minutes.
 *
 * Heuristic: keyword buckets refined by the personal bias factor learned from
 * this user's completed tasks (median of actual/estimate), so the estimate
 * drifts honest over time. Output is a suggestion, never a verdict — the
 * human always reviews it in Plan view.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Estimator = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Keyword buckets: [minutes, ...keywords]. First matching bucket wins.
  const BUCKETS = [
    [10, 'email', 'reply', 'message', 'ping', 'slack', 'dm', 'log', 'jot'],
    [20, 'review', 'read', 'check', 'triage', 'inbox', 'skim', 'sign'],
    [30, 'call', 'meeting', 'sync', 'standup', 'demo', 'plan', 'list'],
    [45, 'fix', 'bug', 'patch', 'test', 'verify', 'draft', 'outline'],
    [60, 'write', 'design', 'spec', 'sketch', 'wireframe', 'record'],
    [90, 'build', 'implement', 'refactor', 'migrate', 'deck', 'proposal'],
    [120, 'deep', 'architect', 'research', 'prototype', 'rewrite', 'launch'],
  ];
  const DEFAULT_MIN = 30;
  const MIN_EST = 10;
  const MAX_EST = 180;

  function titleWords(title) {
    return String(title || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }

  /** Base bucket estimate from keywords; longer titles nudge upward. */
  function baseEstimate(title) {
    const words = titleWords(title);
    for (const [minutes, ...keys] of BUCKETS) {
      if (words.some((w) => keys.some((k) => w.includes(k)))) return minutes;
    }
    // No keyword hit: scale gently with list length ("3 things" > "1 thing").
    const items = words.filter((w) => /^\d+$/.test(w)).map(Number);
    const n = items.length ? Math.min(items[0], 8) : 1;
    return Math.min(MAX_EST, DEFAULT_MIN * Math.max(1, Math.ceil(n / 2) + 0.5));
  }

  /**
   * Personal planning-fallacy factor from history: median actual/estimate
   * ratio over completed tasks with both stamps. 1.0 = well calibrated.
   */
  function biasFactor(historyTasks) {
    const ratios = (historyTasks || [])
      .filter((t) => t.status === 'green' && t.estimateMin > 0)
      .map((t) => {
        const actual = (t.worked || []).reduce((s, seg) => s + ((seg.end ?? 0) - seg.start), 0);
        return actual > 0 ? actual / 60000 / t.estimateMin : null;
      })
      .filter((r) => r != null);
    if (ratios.length < 3) return 1;
    ratios.sort((a, b) => a - b);
    return Math.min(2, Math.max(0.75, ratios[Math.floor(ratios.length / 2)]));
  }

  /** estimate("Draft launch email", pastTasks) → {minutes, bucket, bias} */
  function estimate(title, historyTasks) {
    const base = baseEstimate(title);
    const bias = biasFactor(historyTasks);
    const minutes = Math.max(MIN_EST, Math.min(MAX_EST, Math.round((base * bias) / 5) * 5));
    return { minutes, bucket: base, bias: +bias.toFixed(2) };
  }

  return { estimate, baseEstimate, biasFactor, BUCKETS, DEFAULT_MIN };
});
