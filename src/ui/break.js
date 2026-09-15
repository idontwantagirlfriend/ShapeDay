/**
 * break — the proposal / countdown toast.
 * States: proposal (accept / skip) → countdown → auto "break over".
 * "Taking breaks is productive." — PROJECT.md, Phase Two.
 */
'use strict';

const headline = document.getElementById('headline');
const sub = document.getElementById('sub');
const proposeBox = document.getElementById('propose');
const activeBox = document.getElementById('active');
const countdown = document.getElementById('countdown');

let mode = 'propose'; // propose | counting

function show(mode_) {
  mode = mode_;
  proposeBox.hidden = mode !== 'propose';
  activeBox.hidden = mode !== 'counting';
  if (mode === 'counting') {
    headline.textContent = 'On break';
    sub.textContent = 'Look away from the screen. Really.';
  }
  fitWindow();
}

/** Tell the main process the CONTENT height; it never scrolls, never loops:
 *  the measured element has no viewport-tied height, so re-measuring after
 *  a resize returns the same number and the cycle terminates. */
function fitWindow() {
  const inner = document.querySelector('.toast-inner');
  const h = inner ? Math.ceil(inner.getBoundingClientRect().height) + 2 : 170; // +2: shell border
  if (h !== fitWindow._last) {
    fitWindow._last = h;
    shapeday.call('overlay:toastHeight', { h });
  }
}

document.getElementById('accept').addEventListener('click', () => {
  shapeday.call('break:respond', { accept: true });
  show('counting');
});

// the toast is an overlay, not a notification: grab anywhere (buttons
// excluded) and drag it out of the way
let dragState = null;
document.querySelector('.toast').addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) return;
  dragState = { sx: e.screenX, sy: e.screenY };
  shapeday.call('overlay:drag', { begin: true, sx: e.screenX, sy: e.screenY });
});
document.addEventListener('mousemove', (e) => {
  if (dragState && (e.screenX !== dragState.sx || e.screenY !== dragState.sy)) {
    shapeday.call('overlay:drag', { sx: e.screenX, sy: e.screenY });
  }
});
document.addEventListener('mouseup', () => {
  if (dragState) shapeday.call('overlay:drag', { end: true });
  dragState = null;
});
document.getElementById('skip').addEventListener('click', () => {
  shapeday.call('break:respond', { accept: false });
});
document.getElementById('end').addEventListener('click', () => {
  shapeday.call('break:end');
});

shapeday.onEvent((ev) => {
  if (ev.type === 'break-propose') {
    show('propose');
    headline.textContent = 'Task done.';
    sub.textContent = ev.data?.nextTitle
      ? `Next up: ${ev.data.nextTitle}. Ten minutes off makes it faster.`
      : 'Nothing queued. Ten minutes off anyway?';
    fitWindow();
  }
  if (ev.type === 'break-started') show('counting');
  if (ev.type === 'break-over' || ev.type === 'break-skipped') mode = 'propose';
});

shapeday.onTick((s) => {
  // Adopt a break that's already running (restart mid-break, or accepted elsewhere).
  if (s.break && mode === 'propose') show('counting');
  if (mode !== 'counting') return;
  if (!s.break) return; // ended elsewhere (auto or main window)
  const ms = Math.max(0, s.break.plannedEnd - s.now);
  const m = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  countdown.textContent = `${m}:${String(sec).padStart(2, '0')}`;
  countdown.classList.toggle('late', ms === 0);
});
