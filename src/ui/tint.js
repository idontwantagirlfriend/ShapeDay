/**
 * tint — the fullscreen overwork tint. Pure color, zero input (the window is
 * click-through). Color + alpha per the PROJECT.md escalation:
 * <30m blue → 30-60m shifting red → 60-120m redder → 120m+ darkest red.
 */
'use strict';

function apply(s) {
  const m = s.overworkMin;
  const el = document.body;
  if (m <= 0) {
    el.style.background = 'transparent';
    return;
  }
  const color = Overwork.stageColor(m);
  const strength = Math.max(0, Math.min(2, (s.settings.tintStrength ?? 100) / 100));
  const alpha = Math.min(1, Overwork.tintAlpha(m) * strength); // 0 hides, 200 doubles
  // hex → rgba
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  el.style.background = `rgba(${r},${g},${b},${alpha})`;
  el.style.transition = 'background 1.2s linear'; // glides between stages
}

shapeday.onTick(apply);
