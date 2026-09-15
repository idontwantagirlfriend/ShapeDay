'use strict';

shapeday.onEvent((ev) => {
  if (ev.type !== 'eval-prompt') return;
  const t = ev.data?.title;
  document.getElementById('eval-title').textContent = t
    ? `Half of “${t.length > 24 ? t.slice(0, 23) + '…' : t}”`
    : 'Halfway';
  const worked = Math.round(ev.data?.workedMin ?? 0);
  const est = Math.round(ev.data?.estimateMin ?? 0);
  document.getElementById('eval-text').textContent = `${worked}m in on a ${est}m task — how's the pace?`;
});

/** Size the window to its content, bottom edge pinned (never scrolls). */
function fitWindow() {
  const inner = document.querySelector('.evalwin-inner');
  const h = inner ? Math.ceil(inner.getBoundingClientRect().height) + 4 : 240;
  if (h !== fitWindow._last) {
    fitWindow._last = h;
    shapeday.call('overlay:evalHeight', { h });
  }
}

for (const b of document.querySelectorAll('.evalwin [data-resp]')) {
  b.addEventListener('click', () => shapeday.call('eval:respond', { response: b.dataset.resp }));
}

document.addEventListener('DOMContentLoaded', fitWindow);
shapeday.onEvent((ev) => {
  if (ev.type === 'eval-prompt') {
    // title/text set by the other listener; size after the DOM settles
    setTimeout(fitWindow, 20);
  }
});
