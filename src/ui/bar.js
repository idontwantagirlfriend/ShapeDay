/**
 * bar — two overlay styles, one file.
 *
 * top (default): full-width strip. Click-through everywhere except the
 * center grip (⋯), which is the only draggable spot — the strip no longer
 * steals clicks from other apps' bars. The strip's whole background doubles
 * as the day-progress bar.
 *
 * floater: the rounded capsule only — dot, headline, clock. Draggable
 * anywhere on the capsule.
 */
'use strict';

const $id = (id) => document.getElementById(id);
const els = {
  top: { bar: $id('topbar'), dot: $id('top-dot'), headline: $id('top-headline'), time: $id('top-time'), grip: $id('strip-grip'), fill: $id('strip-fill') },
  fl: { bar: $id('floater'), dot: $id('fl-dot'), headline: $id('fl-headline'), clock: $id('fl-clock') },
};

const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;

function remainingMinutes(s) {
  if (s.break) return Math.max(0, Math.ceil((s.break.plannedEnd - s.now) / 60000));
  if (s.active) {
    const elapsed = TimeUtil.taskElapsedMin(s.active, s.now);
    return Math.max(0, s.active.estimateMin - elapsed);
  }
  return Math.max(0, Math.ceil((s.bounds.end - s.now) / 60000));
}

/** The overlay's progress tracks the CURRENT task (worked ÷ its estimate),
 *  ticking in real time; a break shows its own countdown share; only an
 *  idle overlay falls back to the day's workload. */
function progressFraction(s) {
  if (s.active) {
    let ms = 0;
    for (const seg of s.active.worked || []) ms += Math.max(0, (seg.end ?? s.now) - seg.start);
    const est = Math.max(1, s.active.estimateMin) * 60000;
    return Math.min(1, ms / est);
  }
  if (s.break) {
    const total = s.break.plannedEnd - s.break.startedAt;
    return total > 0 ? Math.min(1, Math.max(0, (s.now - s.break.startedAt) / total) ) : 0;
  }
  return s.progress.ratio;
}

function headlineText(s) {
  if (s.active) return s.active.title;
  if (s.break) return 'on break';
  return s.day.tasks.length ? 'no task on' : 'ShapeDay';
}

let currentStyle = null;
// top strip only: mirror of the window's mouse policy, so redundant
// toggles don't spam IPC. Main applies the base policy in applyBarStyle.
let interactive = false;

shapeday.onTick((s) => {
  const style = s.settings.overlayStyle === 'floater' ? 'fl' : 'top';
  if (style !== currentStyle) {
    currentStyle = style;
    interactive = false;
    els.top.bar.hidden = style !== 'top';
    els.fl.bar.hidden = style !== 'fl';
  }
  const opacity = Math.max(0.2, Math.min(1, (s.settings.overlayOpacity ?? 92) / 100));

  if (style === 'top') {
    els.top.bar.style.opacity = String(opacity);
    els.top.dot.className = `dot s-${s.break ? 'white' : s.active ? 'yellow' : 'red'}`;
    els.top.headline.textContent = headlineText(s);
    els.top.time.textContent = `${fmt(remainingMinutes(s))} left`;
    // the entire strip IS the progress bar
    els.top.fill.style.width = `${Math.round(progressFraction(s) * 100)}%`;
    return;
  }

  els.fl.bar.style.opacity = String(opacity);
  els.fl.dot.className = `dot s-${s.break ? 'white' : s.active ? 'yellow' : 'red'}`;
  els.fl.headline.textContent = headlineText(s);
  if (s.break) {
    const ms = Math.max(0, s.break.plannedEnd - s.now);
    els.fl.clock.textContent = `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
  } else if (s.active) {
    els.fl.clock.textContent = fmt((s.now - (s.active.startedAt ?? s.now)) / 60000);
  } else {
    els.fl.clock.textContent = '';
  }
});

// ---------- top strip: click-through except the grip ----------
// The window ignores the mouse (forwarding moves); hovering the grip turns
// interactivity on, leaving the window turns it off. The grip is the drag
// anchor. The floater stays interactive, so its capsule can be dragged.
function setInteractive(on) {
  if (on === interactive) return;
  interactive = on;
  shapeday.call('overlay:setInteractive', { on });
  if (!on && drag) {
    // click-through re-enabled mid-press swallows the mouseup; end the drag
    drag = null;
    shapeday.call('overlay:drag', { end: true });
  }
}
document.addEventListener('mousemove', (e) => {
  if (currentStyle !== 'top') return;
  const r = els.top.grip.getBoundingClientRect();
  const inside = e.clientX >= r.left - 6 && e.clientX <= r.right + 6 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4;
  setInteractive(inside);
});
// crossing the window edge sends no further mousemove, so restore
// click-through here or the strip would keep eating clicks
document.addEventListener('mouseout', (e) => {
  if (!e.relatedTarget) setInteractive(false);
});

// ---------- dragging (strip: grip only; floater: anywhere) ----------
let drag = null;
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) return;
  const fromFloater = !els.fl.bar.hidden && !!e.target.closest('.floater');
  const fromGrip = !!e.target.closest('.strip-grip');
  if (!fromFloater && !fromGrip) return;
  drag = { sx: e.screenX, sy: e.screenY };
  shapeday.call('overlay:drag', { begin: true, sx: e.screenX, sy: e.screenY });
});
document.addEventListener('mousemove', (e) => {
  if (drag && (e.screenX !== drag.sx || e.screenY !== drag.sy)) {
    shapeday.call('overlay:drag', { sx: e.screenX, sy: e.screenY });
  }
});
document.addEventListener('mouseup', () => {
  if (drag) shapeday.call('overlay:drag', { end: true });
  drag = null;
});
