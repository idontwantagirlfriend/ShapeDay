/**
 * overwork — the tint curve. Exact spec from PROJECT.md:
 *   <30 min        : blue #aed8fc (immediately after work hours finish)
 *   30 – 60 min    : shifts towards red #db9696
 *   60 – 120 min   : more red
 *   120 min –      : stays in the darkest red #803d3a
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Overwork = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BLUE = [0xae, 0xd8, 0xfc]; // #aed8fc
  const RED_1 = [0xdb, 0x96, 0x96]; // #db9696
  const RED_2 = [0x80, 0x3d, 0x3a]; // #803d3a

  function lerp(a, b, k) {
    const c = [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k));
    return '#' + c.map((n) => n.toString(16).padStart(2, '0')).join('');
  }

  /** Hex color for a given overwork duration in minutes. */
  function stageColor(minutes) {
    const m = Math.max(0, minutes);
    if (m < 30) return '#aed8fc';
    if (m < 60) return lerp(BLUE, RED_1, (m - 30) / 30); // shift towards red
    if (m < 120) return lerp(RED_1, RED_2, (m - 60) / 60); // more red
    return '#803d3a'; // stays in the darkest red
  }

  function stageName(minutes) {
    const m = Math.max(0, minutes);
    if (m <= 0) return 'clear';
    if (m < 30) return 'blue';
    if (m < 60) return 'warming';
    if (m < 120) return 'red';
    return 'darkest-red';
  }

  /**
   * Screen-tint alpha. Gentle at first, insistent at the darkest stage —
   * the screen becomes more red the longer overwork runs, never opaque
   * enough to stop you from actually finishing.
   */
  function tintAlpha(minutes) {
    const m = Math.max(0, minutes);
    if (m <= 0) return 0;
    // 0.04 at minute 1 → 0.16 at minute 120+, clamped ramp.
    const k = Math.min(1, m / 120);
    return +(0.04 + 0.12 * k).toFixed(3);
  }

  /** Multi-stop gradient stops for chart fills across an overwork span. */
  function gradientStops() {
    return [0, 15, 30, 45, 60, 90, 120].map((m) => ({ at: m, color: stageColor(m) }));
  }

  return { stageColor, stageName, tintAlpha, gradientStops };
});
