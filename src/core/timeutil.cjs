/**
 * timeutil — day math, work hours, ranges. Pure functions, no Electron.
 * Shared between main process (require) and renderer (script tag).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TimeUtil = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 60 * 1000;

  /** Local ISO date key, e.g. "2026-09-14". */
  function dateKey(d) {
    const t = new Date(d);
    const p = (n) => String(n).padStart(2, '0');
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
  }

  /** Parse "HH:MM" into minutes-from-midnight. Returns null if malformed. */
  function parseHM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const h = +m[1], mm = +m[2];
    if (h > 23 || mm > 59) return null;
    return h * 60 + mm;
  }

  /**
   * Absolute work-hours boundaries for a given day, as epoch ms.
   * Work hours that cross midnight (e.g. 22:00-06:00) are not supported; clamped.
   */
  function workBounds(dayKey, workStartHM, workEndHM, nowMs) {
    const base = new Date(dayKey + 'T00:00:00');
    const startMin = parseHM(workStartHM) ?? 9 * 60;
    const endMin = parseHM(workEndHM) ?? 17 * 60;
    const end = Math.max(endMin, startMin + 1);
    return {
      start: base.getTime() + startMin * MIN,
      end: base.getTime() + end * MIN,
    };
  }

  /** Overwork minutes for a moment in time: active wall-clock past work end. */
  function overworkMinutes(nowMs, bounds) {
    return Math.max(0, Math.round((nowMs - bounds.end) / MIN));
  }

  /** Total elapsed minutes actually worked by a task (sum of worked segments). */
  function taskElapsedMin(task, nowMs) {
    const now = nowMs ?? Date.now();
    let ms = 0;
    for (const seg of task.worked || []) {
      ms += Math.max(0, (seg.end ?? now) - seg.start);
    }
    return Math.round(ms / MIN);
  }

  /** Break minutes within a day's breaks array. */
  function breaksElapsedMin(day, nowMs) {
    const now = nowMs ?? Date.now();
    let ms = 0;
    for (const b of day.breaks || []) {
      ms += Math.max(0, (b.end ?? Math.min(now, b.start + (b.plannedMin || 10) * MIN)) - b.start);
    }
    return Math.round(ms / MIN);
  }

  /** Today's key as seen by the machine clock. */
  function todayKey() {
    return dateKey(new Date());
  }

  return {
    MIN,
    dateKey,
    parseHM,
    workBounds,
    overworkMinutes,
    taskElapsedMin,
    breaksElapsedMin,
    todayKey,
  };
});
