/**
 * bar — two overlay styles, one file.
 *
 * top (default): full-width strip. Click-through everywhere except the
 * center grip (⋯), which is the only draggable spot — the strip no longer
 * steals clicks from other apps' bars. The strip's whole background doubles
 * as the day-progress bar.
 *
 * floater: the corner widget. Headline, clock, progress track, overwork
 * line; drag anywhere.
 */
'use strict';

const $id = (id) => document.getElementById(id);
const els = {
  top: { bar: $id('topbar'), dot: $id('top-dot'), headline: $id('top-headline'), time: $id('top-time'), grip: $id('strip-grip'), fill: $id('strip-fill') },
  fl: { bar: $id('floater'), dot: $id('fl-dot'), headline: $id('fl-headline'), clock: $id('fl-clock'), fill: $id('fl-fill'), ow: $id('fl-ow') },
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

function headlineText(s) {
  if (s.active) return s.active.title;
  if (s.break) return 'on break';
  return s.day.tasks.length ? 'no task on' : 'ShapeDay';
}

let currentStyle = null;

shapeday.onTick((s) => {
  const style = s.settings.overlayStyle === 'floater' ? 'fl' : 'top';
  if (style !== currentStyle) {
    currentStyle = style;
    els.top.bar.hidden = style !== 'top';
    els.fl.bar.hidden = style !== 'fl';
  }
  const opacity = Math.max(0.2, Math.min(1, (s.settings.overlayOpacity ?? 92) / 100));
  const pct = Math.round(s.progress.ratio * 100);

  if (style === 'top') {
    els.top.bar.style.opacity = String(opacity);
    els.top.dot.className = `dot s-${s.break ? 'white' : s.active ? 'yellow' : 'red'}`;
    els.top.headline.textContent = headlineText(s);
    els.top.time.textContent = `${fmt(remainingMinutes(s))} left`;
    // the entire strip IS the progress bar
    els.top.fill.style.width = `${pct}%`;
    return;
  }

  els.fl.bar.style.opacity = String(opacity);
  els.fl.dot.className = `dot s-${s.break ? 'white' : s.active ? 'yellow' : 'red'}`;
  els.fl.headline.textContent = headlineText(s);
  els.fl.fill.style.width = `${pct}%`;
  if (s.break) {
    const ms = Math.max(0, s.break.plannedEnd - s.now);
    els.fl.clock.textContent = `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
    els.fl.ow.textContent = '';
  } else if (s.active) {
    els.fl.clock.textContent = fmt((s.now - (s.active.startedAt ?? s.now)) / 60000);
    els.fl.ow.textContent = s.overworkMin > 0 ? `overwork ${fmt(s.overworkMin)}` : '';
  } else {
    els.fl.clock.textContent = '';
    els.fl.ow.textContent = s.overworkMin > 0 ? `overwork ${fmt(s.overworkMin)}` : '';
  }
});

// ---------- top strip: click-through except the grip ----------
// The window ignores the mouse (forwarding moves); hovering the grip turns
// interactivity on, leaving it turns it off. The grip is the drag anchor.
let interactive = false;
function setInteractive(on) {
  if (on === interactive) return;
  interactive = on;
  shapeday.call('overlay:setInteractive', { on });
}
document.addEventListener('mousemove', (e) => {
  if (currentStyle !== 'top') return;
  const r = els.top.grip.getBoundingClientRect();
  const inside = e.clientX >= r.left - 6 && e.clientX <= r.right + 6 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4;
  setInteractive(inside);
});

// ---------- dragging (both styles; top only from the grip) ----------
let drag = null;
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) return;
  if (currentStyle === 'top' && !e.target.closest('.strip-grip')) return; // strip: grip only
  drag = { sx: e.screenX, sy: e.screenY };
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
