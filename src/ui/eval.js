'use strict';

let locale = 'en-us';
const T = (k) => I18N.t(locale, k);
const COMPANION = { ahead: 'Hooray.', 'on-track': 'Keep it up.', behind: 'Extend the ETA.' };

shapeday.call('day:get').then((s) => {
  locale = I18N.resolve(s.settings.locale || 'auto', navigator.language);
});

shapeday.onEvent((ev) => {
  if (ev.type !== 'eval-prompt') return;
  const t = ev.data?.title;
  document.getElementById('eval-title').textContent = t
    ? T('eval.title', { title: t.length > 24 ? t.slice(0, 23) + '…' : t })
    : T('eval.half');
  const worked = Math.round(ev.data?.workedMin ?? 0);
  const est = Math.round(ev.data?.estimateMin ?? 0);
  document.getElementById('eval-text').textContent = T('eval.text', { worked, est });
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
