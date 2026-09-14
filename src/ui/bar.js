/**
 * bar — the overarching strip: full-width, one line, as compact as possible.
 * Text is the task headline only; the remaining time appears on hover.
 * Dragging moves the window (hand cursor included).
 */
'use strict';

const barEl = document.getElementById('bar');
const dot = document.getElementById('dot');
const headline = document.getElementById('headline');
const timeEl = document.getElementById('time');

const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;

function remainingMinutes(s) {
  if (s.break) return Math.max(0, Math.ceil((s.break.plannedEnd - s.now) / 60000));
  if (s.active) {
    const elapsed = TimeUtil.taskElapsedMin(s.active, s.now);
    return Math.max(0, s.active.estimateMin - elapsed); // minutes left on the estimate
  }
  return Math.max(0, Math.ceil((s.bounds.end - s.now) / 60000)); // workday left
}

shapeday.onTick((s) => {
  // the whole strip honors the opacity setting, contents included
  barEl.style.opacity = String(Math.max(0.2, Math.min(1, (s.settings.overlayOpacity ?? 92) / 100)));

  if (s.active) {
    dot.className = 'dot s-yellow';
    headline.textContent = s.active.title;
  } else if (s.break) {
    dot.className = 'dot s-white';
    headline.textContent = 'on break';
  } else if (s.day.tasks.length) {
    dot.className = 'dot s-red';
    headline.textContent = 'no task on';
  } else {
    dot.className = 'dot';
    headline.textContent = 'ShapeDay';
  }
  timeEl.textContent = `${fmt(remainingMinutes(s))} left`;
});

headline.addEventListener('click', () => shapeday.focusMain());

// ---------- dragging: anchor on mousedown, stream moves, main repositions ----------
let drag = null;
barEl.addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) return;
  drag = { sx: e.screenX, sy: e.screenY, moved: false };
});
document.addEventListener('mousemove', (e) => {
  if (!drag) return;
  if (Math.abs(e.screenX - drag.sx) + Math.abs(e.screenY - drag.sy) > 4) drag.moved = true;
  if (drag.moved) shapeday.call('overlay:drag', { sx: e.screenX, sy: e.screenY });
});
document.addEventListener('mouseup', () => {
  if (drag?.moved) {
    headline.dataset.suppressClick = '1';
    shapeday.call('overlay:drag', { end: true });
  }
  drag = null;
});
headline.addEventListener(
  'click',
  (e) => {
    if (headline.dataset.suppressClick === '1') {
      delete headline.dataset.suppressClick;
      e.stopImmediatePropagation();
    }
  },
  true // capture, before the focus handler
);
