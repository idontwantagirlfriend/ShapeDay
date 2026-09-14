/**
 * bar — the "currently-on" bar. Draws over the screen: active task, elapsed,
 * day progress, overwork clock. Draggable; clicking the title opens the app.
 */
'use strict';

const dot = document.getElementById('dot');
const title = document.getElementById('title');
const clock = document.getElementById('clock');
const fill = document.getElementById('fill');
const ow = document.getElementById('ow');

const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;

title.addEventListener('click', () => shapeday.focusMain());

// ---------- manual dragging (hand cursor included) ----------
// -webkit-app-region: drag made Chromium ignore the cursor, so the bar is
// dragged by hand: mousedown anchors, mousemove streams screen coords, the
// main process moves the window.
let drag = null;
document.querySelector('.bar').addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) return;
  drag = { sx: e.screenX, sy: e.screenY, moved: false };
});
document.addEventListener('mousemove', (e) => {
  if (!drag) return;
  if (Math.abs(e.screenX - drag.sx) + Math.abs(e.screenY - drag.sy) > 4) drag.moved = true;
  if (drag.moved) shapeday.call('bar:drag', { sx: e.screenX, sy: e.screenY });
});
document.addEventListener('mouseup', () => {
  if (drag?.moved) {
    title.dataset.suppressClick = '1';
    shapeday.call('bar:drag', { end: true });
  }
  drag = null;
});
title.addEventListener('click', (e) => {
  if (title.dataset.suppressClick === '1') {
    delete title.dataset.suppressClick;
    e.stopImmediatePropagation();
  }
}, true); // capture, before the focus handler

shapeday.onTick((s) => {
  // user-adjustable solidity of the overlay bar
  const op = Math.max(0.2, Math.min(1, (s.settings.overlayOpacity ?? 92) / 100));
  document.getElementById('bar').style.background = `rgba(22, 24, 29, ${op})`;

  if (s.active) {
    dot.className = 'status-dot s-yellow';
    title.textContent = s.active.title;
    const elapsed = (s.now - (s.active.startedAt ?? s.now)) / 60000;
    clock.textContent = fmt(elapsed);
    clock.classList.remove('ow');
  } else if (s.break) {
    dot.className = 'status-dot s-white';
    title.textContent = `on break — back ${new Date(s.break.plannedEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    // live m:ss countdown to the break's planned end
    const ms = Math.max(0, s.break.plannedEnd - s.now);
    clock.textContent = `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
    clock.classList.remove('ow');
  } else {
    dot.className = 'status-dot s-red';
    title.textContent = s.day.tasks.length ? 'next up: pick a task' : 'no task on';
    clock.textContent = '';
  }
  fill.style.width = `${Math.round(s.progress.ratio * 100)}%`;
  if (s.overworkMin > 0) {
    ow.textContent = `overwork ${fmt(s.overworkMin)}`;
    ow.style.color = Overwork.stageColor(s.overworkMin);
  } else {
    const left = Math.max(0, Math.round((s.bounds.end - s.now) / 60000));
    ow.textContent = left > 0 ? `${fmt(left)} of work hours left` : '';
    ow.style.color = '';
  }
});
