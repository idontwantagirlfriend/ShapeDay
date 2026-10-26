/**
 * app — main window controller. Renders the 1 Hz snapshot; all mutations go
 * through `window.shapeday.call(kind, payload)` (see preload.cjs / README).
 */
'use strict';
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let snap = null;
let locale = 'en-us';
const T = (k, p) => I18N.t(locale, k, p);
const INTL_TAG = { 'en-us': 'en-US', 'zh-hans': 'zh-CN', 'zh-hant': 'zh-TW' };
function applyLocale() {
  document.documentElement.lang = locale;
  for (const el of $$('[data-i18n]')) el.textContent = T(el.dataset.i18n);
  for (const el of $$('[data-i18n-ph]')) el.placeholder = T(el.dataset.i18nPh);
  for (const el of $$('[data-i18n-title]')) el.title = T(el.dataset.i18nTitle);
}
let currentView = 'plan';
let sumScope = 'day';
const aiCache = {}; // scope → last AI summary (survives local re-renders)
let sumError = null; // last summarize backend error, surfaced in the Summarize view

const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m` : `${Math.round(m)}m`);
const fmtClock = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// ---------- views ----------
function setView(v) {
  currentView = v;
  $$('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${v}`));
  if (v === 'viz') renderViz(true);
  if (v === 'sum') loadReport();
}

$$('nav.tabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === '1') setView('plan');
  if (e.key === '2') setView('viz');
  if (e.key === '3') setView('sum');
});

// ---------- plan ----------
$('#add-btn').addEventListener('click', addTask);
$('#add-input').addEventListener('keydown', (e) => e.key === 'Enter' && addTask());
function addTask() {
  const input = $('#add-input');
  const title = input.value.trim();
  if (!title) return;
  shapeday.call('task:add', { title });
  input.value = '';
  input.focus();
}

$('#btn-reset').addEventListener('click', () => shapeday.call('day:resetStatuses'));
$('#btn-clear').addEventListener('click', () => {
  if (confirm('Remove every task from today?')) shapeday.call('day:clear');
});
$('#eta-ok').addEventListener('click', () => shapeday.call('day:reviewEtas'));
$('#eta-ai').addEventListener('click', () => {
  $('#eta-llm-status').textContent = 'asking…';
  $('#eta-llm-status').className = 'llm-status';
  shapeday.call('llm:refineEtas');
});

const HINT_AUTO = {
  red: () => T('plan.hint.red'),
  yellow: () => T('plan.hint.yellow_auto'),
  paused: () => T('plan.hint.paused'),
  green: () => T('plan.hint.green'),
  white: () => T('plan.hint.white'),
};
const HINT_MANUAL = {
  red: () => T('plan.hint.red'),
  yellow: () => T('plan.hint.yellow'),
  paused: () => T('plan.hint.paused'),
  green: () => T('plan.hint.green'),
  white: () => T('plan.hint.white'),
};

// Rebuild the list only when it actually changed — a 1 Hz DOM rebuild would
// cancel in-flight drag-and-drops and an open estimate editor mid-typing.
let lastPlanSig = null;
let dragId = null;
let editingEstimate = false;
let editingTitle = false;

/** Inline write-in for the headline: a textarea in place of the title. */
function openTitleEditor(task, span) {
  if (editingTitle) return;
  editingTitle = true;
  const box = document.createElement('textarea');
  box.className = 'title-edit';
  box.rows = 1;
  box.value = task.title;
  const fit = () => {
    box.style.height = 'auto';
    box.style.height = `${Math.min(120, box.scrollHeight)}px`;
  };
  const close = (commit) => {
    editingTitle = false;
    const v = box.value.replace(/\s+/g, ' ').trim();
    if (commit && v && v !== task.title) {
      shapeday.call('task:rename', { id: task.id, title: v });
      span.textContent = v;
      return; // the tick re-renders with the persisted title
    }
    span.textContent = task.title;
  };
  box.addEventListener('input', fit);
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) close(true);
    if (e.key === 'Escape') close(false);
  });
  box.addEventListener('blur', () => close(true));
  box.addEventListener('click', (e) => e.stopPropagation());
  span.textContent = '';
  span.appendChild(box);
  box.focus();
  box.select();
  fit();
}

/** Inline write-in for an ETA: replaces the minutes label with an input. */
function openEstimateEditor(task, span) {
  if (editingEstimate) return;
  editingEstimate = true;
  const input = document.createElement('input');
  input.className = 'mins-edit';
  input.type = 'text';
  input.value = String(task.estimateMin);
  input.pattern = '\\d+';
  const close = (commit) => {
    editingEstimate = false;
    const v = parseInt(input.value, 10);
    if (commit && Number.isFinite(v) && v > 0) {
      shapeday.call('task:setEstimate', { id: task.id, minutes: v });
      span.textContent = `~${fmtMin(v)}`; // optimistic; the tick confirms
      return; // input is replaced by the re-render
    }
    span.textContent = `~${fmtMin(task.estimateMin)}`;
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') close(true);
    if (e.key === 'Escape') close(false);
  });
  input.addEventListener('blur', () => close(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  span.textContent = '';
  span.appendChild(input);
  input.focus();
  input.select();
}

function planSignature(day) {
  return JSON.stringify([
    day.tasks.map((t) => [
      t.id, t.status, t.title, t.estimateMin, t.estEdited ? 1 : 0,
      t.startedAt, t.finishedAt, TimeUtil.taskElapsedMin(t, snap.now),
    ]),
    snap.settings.autoAdvance,
    day.etaReviewed ? 1 : 0,
    (day.reflog || []).length,
    (day.reflog || []).slice(-1)[0]?.at ?? 0,
  ]);
}

function clearDropMarkers() {
  $$('#task-list .insert-above, #task-list .insert-below').forEach((el) =>
    el.classList.remove('insert-above', 'insert-below')
  );
}

function renderPlan() {
  const day = snap.day;
  const sig = planSignature(day);
  if ((sig === lastPlanSig && !dragId) || editingEstimate || editingTitle) return;
  lastPlanSig = sig;

  const list = $('#task-list');
  list.innerHTML = '';

  if (!day.tasks.length) {
    const li = document.createElement('li');
    li.className = 'task';
    li.style.cursor = 'default';
    li.innerHTML = `<span class="title" style="color:var(--text-dim)">${escapeHtml(T('plan.empty'))}</span>`;
    list.appendChild(li);
  }

  const HINT = snap.settings.autoAdvance !== false ? HINT_AUTO : HINT_MANUAL;

  for (const t of day.tasks) {
    const li = document.createElement('li');
    li.className = `task ${t.status}`;
    li.title = `${t.title} — ${HINT[t.status]()}`;

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.title = 'Drag to reorder';
    // draggable only from the grip, so text clicks stay clicks
    grip.addEventListener('mousedown', () => { li.draggable = true; });
    li.addEventListener('dragstart', (e) => {
      dragId = t.id;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', t.id);
    });
    li.addEventListener('dragend', () => {
      li.draggable = false;
      li.classList.remove('dragging');
      dragId = null;
      clearDropMarkers();
    });
    li.addEventListener('dragover', (e) => {
      if (!dragId || dragId === t.id) return;
      e.preventDefault();
      clearDropMarkers();
      const rect = li.getBoundingClientRect();
      li.classList.add(e.clientY > rect.top + rect.height / 2 ? 'insert-below' : 'insert-above');
    });
    li.addEventListener('drop', (e) => {
      if (!dragId) return;
      e.preventDefault();
      const rect = li.getBoundingClientRect();
      const below = e.clientY > rect.top + rect.height / 2;
      const idx = day.tasks.findIndex((x) => x.id === t.id) + (below ? 1 : 0);
      if (dragId !== t.id) shapeday.call('task:move', { id: dragId, toIndex: idx });
      dragId = null;
      clearDropMarkers();
    });

    const dot = document.createElement('span');
    dot.className = `dot s-${t.status}`;

    const title = document.createElement('span');
    title.className = 'title title-editable';
    title.textContent = t.title;
    title.onclick = (e) => {
      e.stopPropagation();
      openTitleEditor(t, title);
    };

    const stamp = document.createElement('span');
    stamp.className = 'stamp';
    const elapsed = TimeUtil.taskElapsedMin(t, snap.now);
    if (t.status === 'yellow') stamp.textContent = `▶ ${fmtMin(elapsed)}`;
    else if (t.status === 'green') stamp.textContent = `${fmtClock(t.startedAt ?? snap.now)} → ${fmtClock(t.finishedAt ?? snap.now)} · ${fmtMin(elapsed)}`;
    else if (t.status === 'paused') stamp.textContent = `${T('plan.paused_stamp', { dur: fmtMin(elapsed) })}`;
    else if (t.status === 'white') stamp.textContent = 'hung';
    else stamp.textContent = '';

    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.title = 'ETA — the guess, yours to correct';
    if (t.status === 'green') {
      // finished: the estimate is history, no steppers
      chip.textContent = `~${fmtMin(t.estimateMin)}`;
    } else {
      const minus = document.createElement('button');
      minus.textContent = '−';
      minus.onclick = (e) => { e.stopPropagation(); shapeday.call('task:setEstimate', { id: t.id, minutes: t.estimateMin - 5 }); };
      const plus = document.createElement('button');
      plus.textContent = '+';
      plus.onclick = (e) => { e.stopPropagation(); shapeday.call('task:setEstimate', { id: t.id, minutes: t.estimateMin + 5 }); };
      // write-in: click the minutes and type a value
      const mins = document.createElement('span');
      mins.className = 'mins';
      mins.textContent = `~${fmtMin(t.estimateMin)}`;
      mins.onclick = (e) => {
        e.stopPropagation();
        openEstimateEditor(t, mins);
      };
      chip.append(minus, mins, plus);
    }

    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = HINT[t.status]();

    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'Delete — recorded in the reflog';
    del.textContent = '✕';
    del.onclick = (e) => { e.stopPropagation(); shapeday.call('task:delete', { id: t.id }); };

    li.append(grip, dot, title, stamp, chip, hint, del);

    li.addEventListener('click', () => shapeday.call('task:click', { id: t.id }));
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      shapeday.call(t.status === 'green' ? 'task:reopen' : 'task:skip', { id: t.id });
    });

    list.appendChild(li);
  }

  // dropping past the last row appends at the end
  list.addEventListener('dragover', (e) => { if (dragId) e.preventDefault(); });
  list.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    shapeday.call('task:move', { id: dragId, toIndex: day.tasks.length });
    dragId = null;
    clearDropMarkers();
  });

  $('#eta-banner').hidden = !(day.tasks.length > 0 && !day.etaReviewed);
  $('#plan-auto').checked = snap.settings.autoAdvance !== false;
  renderReflog(day);
}

const KIND_TEXT = { added: () => T('reflog.added'), deleted: () => T('reflog.deleted') };

function renderReflog(day) {
  const log = day.reflog || [];
  const box = $('#reflog');
  box.hidden = log.length === 0;
  if (reflogPref !== !!snap.settings.reflogOpen) {
    reflogPref = !!snap.settings.reflogOpen; // default applied once, then only on setting change
    box.open = reflogPref;
  }
  reflogOpenInput.checked = reflogPref;
  $('#reflog-count').textContent = log.length ? `· ${log.length}` : '';
  const ul = $('#reflog-list');
  ul.innerHTML = '';
  const SHOW = 15;
  for (const e of log.slice(-SHOW).reverse()) {
    const li = document.createElement('li');
    const at = document.createElement('span');
    at.className = 'at';
    at.textContent = fmtClock(e.at);
    const kind = document.createElement('span');
    kind.className = `kind ${e.kind}`;
    if (e.kind === 'status') {
      kind.innerHTML =
        `<span class="w-${e.from}">${escapeHtml(T('status.' + e.from))}</span>` +
        ' → ' +
        `<span class="w-${e.to}">${escapeHtml(T('status.' + e.to))}</span>`;
    } else {
      kind.textContent = KIND_TEXT[e.kind] ? KIND_TEXT[e.kind]() : e.kind;
    }
    const title = document.createElement('span');
    title.textContent = e.title;
    li.append(at, kind, title);
    ul.appendChild(li);
  }
}

$('#plan-auto').addEventListener('change', (e) => {
  shapeday.call('settings:set', { autoAdvance: e.target.checked });
});

// ---------- visualize ----------
let vizScope = 'day';
let vizDate = null; // selected day for the Day chart; null = today
let vizAnchor = null; // week/month navigation center; null = current period
let vizData = null; // last fetched {scope, days, ...} for week/month
let vizFetchedAt = 0;
const VIZ_TTL = 15000; // refetch week/month data at most every 15s

/** Switch the Day chart to an arbitrary date (from a week/month cell). */
async function selectDay(date) {
  vizDate = date && date !== snap.date ? date : null;
  hideVizBubble();
  vizScope = 'day';
  $$('.viz-scopes button').forEach((x) => x.classList.toggle('active', x.dataset.viz === 'day'));
  await renderViz(true);
}

async function renderViz(force) {
  if (!snap) return;
  const canvas = $('#timeline');
  const dayOnly = document.querySelectorAll('.viz-stats, .legend');
  if (vizScope === 'day') {
    if (vizDate) {
      // another day's workload: fetch it; the header stats stay today's, so hide them
      dayOnly.forEach((el) => (el.style.display = 'none'));
      const sel = await shapeday.call('viz:day', { date: vizDate });
      if (sel && !sel.error) {
        // a past day ends at its own midnight: open segments clamp there and
        // the overwork region stops at the day's last activity, never at now
        const endOfDay = new Date(vizDate + 'T23:59:59').getTime();
        Timeline.render(canvas, sel.day, sel.bounds, Math.min(snap.now, endOfDay));
        updateDayPick();
        return;
      }
      vizDate = null; // bad date: fall through to today
    }
    dayOnly.forEach((el) => (el.style.display = ''));
    updateDayPick();
    Timeline.render(canvas, snap.day, snap.bounds, snap.now);
    const done = snap.day.tasks.filter((t) => t.status === 'green').length;
    $('#st-done').textContent = `${done}/${snap.day.tasks.length}`;
    $('#st-est').textContent = `${fmtMin(snap.progress.done)} / ${fmtMin(snap.progress.total)}`;
    $('#st-breaks').textContent = String((snap.day.breaks || []).length);
    const ow = $('#st-ow');
    ow.textContent = snap.overworkMin > 0 ? fmtMin(snap.overworkMin) : '—';
    ow.style.color = snap.overworkMin > 0 ? Overwork.stageColor(snap.overworkMin) : '';
    return;
  }

  dayOnly.forEach((el) => (el.style.display = 'none'));
  // anchorKey defaults to today server-side; compare against the same default
  const wantAnchorKey = vizAnchor || snap.date;
  const anchorChanged = vizData?.anchorKey !== wantAnchorKey;
  if (force || anchorChanged || !vizData || vizData.scope !== vizScope || Date.now() - vizFetchedAt > VIZ_TTL) {
    vizData = await shapeday.call('viz:days', { scope: vizScope, anchor: vizAnchor || undefined });
    vizFetchedAt = Date.now();
    if (!vizData || vizData.scope !== vizScope) return; // scope switched mid-fetch
  }
  if (vizScope === 'week') {
    Timeline.renderWeek(canvas, vizData);
    renderWeekSummaries(vizData);
  } else {
    Timeline.renderMonth(canvas, vizData);
    renderWeekSummaries(null);
  }
}

/** The "showing Sep 14 · ✕" chip when the Day chart is on another date. */
function updateDayPick() {
  const chip = $('#day-pick');
  if (!chip) return;
  if (vizScope === 'day' && vizDate) {
    chip.textContent = `${new Date(vizDate + 'T00:00:00').toLocaleDateString(INTL_TAG[locale] ?? 'en-US', { month: 'short', day: 'numeric' })} ✕`;
    chip.hidden = false;
  } else {
    chip.hidden = true;
  }
}

$('#day-pick').addEventListener('click', () => selectDay(null));

// period navigation: ‹ › step day/week/month
const shiftDate = (dateKey, days) => {
  const d = new Date(dateKey + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
function stepPeriod(dir) {
  if (vizScope === 'day') {
    selectDay(shiftDate(vizDate || snap.date, dir));
    return;
  }
  const days = vizScope === 'week' ? 7 * dir : 0;
  if (vizScope === 'month') {
    const base = new Date((vizAnchor || snap.date) + 'T00:00:00');
    base.setDate(1);
    base.setMonth(base.getMonth() + dir);
    const p = (x) => String(x).padStart(2, '0');
    vizAnchor = `${base.getFullYear()}-${p(base.getMonth() + 1)}-${p(base.getDate())}`;
  } else {
    vizAnchor = shiftDate(vizAnchor || snap.date, days);
  }
  hideVizBubble();
  renderViz(true);
}
$('#viz-prev').addEventListener('click', () => stepPeriod(-1));
$('#viz-next').addEventListener('click', () => stepPeriod(1));

$$('.viz-scopes button[data-viz]').forEach((b) =>
  b.addEventListener('click', () => {
    vizScope = b.dataset.viz;
    vizAnchor = null; // a fresh scope starts at the current period
    $$('.viz-scopes button[data-viz]').forEach((x) => x.classList.toggle('active', x === b));
    hideVizBubble();
    renderViz(true);
  })
);

// day: crosshair hover. month: day-cell hover bubble. week: task-block preview.
// Day: crosshair hover. Week/month: previews are click-only — hovering the
// grids never pops a bubble over the cells being aimed at.
$('#timeline').addEventListener('mousemove', (e) => {
  if (vizScope === 'day') {
    Timeline.hover($('#timeline'), e.clientX, e.clientY);
    return;
  }
  clearBubbleHide(); // back on the chart: cancel a pending dismiss
});
$('#timeline').addEventListener('mouseleave', (e) => {
  Timeline.hoverEnd();
  if (vizScope === 'day') return;
  // crossing the canvas edge on the way to the bubble must not dismiss it
  if (e.relatedTarget && $('#viz-bubble').contains(e.relatedTarget)) return;
  scheduleBubbleHide();
});

// week: click a task block for its details; click a column to open that day
// month: click a day cell for its preview; the hint on its day title opens the chart
$('#timeline').addEventListener('click', (e) => {
  if (vizScope !== 'week' && vizScope !== 'month') return;
  const hit = Timeline.hitTest($('#timeline'), e.clientX, e.clientY);
  if (hit?.kind === 'task') showWeekTaskBubble(hit, e);
  else if (hit?.kind === 'day' && hit.date) {
    if (vizScope === 'month') showMonthBubble(hit, e);
    else selectDay(hit.date);
  } else hideVizBubble();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideVizBubble();
});

// ---------- viz bubbles ----------
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => () => T('dow.' + [1, 2, 3, 4, 5, 6, 0][i]));

// Preview bubbles are copyable, so they never follow the cursor. Leaving the
// chart only arms a short grace timer — entering the bubble itself cancels it,
// which lets the cursor cross the gap between the trigger and the bubble.
let bubbleHideTimer = null;
function clearBubbleHide() {
  if (bubbleHideTimer) {
    clearTimeout(bubbleHideTimer);
    bubbleHideTimer = null;
  }
}
function scheduleBubbleHide() {
  clearBubbleHide();
  bubbleHideTimer = setTimeout(hideVizBubble, 140);
}

function placeBubble(bubble, e) {
  const wrap = document.querySelector('.viz-wrap');
  const r = wrap.getBoundingClientRect();
  let x = e.clientX - r.left + 14;
  let y = e.clientY - r.top + 14;
  if (x + 340 > r.width) x = Math.max(0, r.width - 350);
  if (y + 180 > r.height) y = Math.max(0, y - 190);
  bubble.style.left = `${x}px`;
  bubble.style.top = `${y}px`;
}

function hideVizBubble() {
  clearBubbleHide();
  $('#viz-bubble').hidden = true;
}

// the bubble is a hover target in its own right: enter to keep it (and copy),
// leave and it goes away
$('#viz-bubble').addEventListener('mouseenter', clearBubbleHide);
$('#viz-bubble').addEventListener('mouseleave', hideVizBubble);

const COPY_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 4h-1.18A3 3 0 0 0 12 2a3 3 0 0 0-2.82 2H8a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm-4-1a1 1 0 0 1 1 1h-2a1 1 0 0 1 1-1Zm5 16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h1v1a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V5h1a1 1 0 0 1 1 1v13Z"/></svg>`;
const CHECK_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
const CHART_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 20h16v2H4v-2Zm1-2V9h3v9H5Zm5 0V4h3v14h-3Zm5 0v-6h3v6h-3Z"/></svg>`;

/** Clipboard write with a legacy fallback (file:// renderers may not expose the async API). */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed; left:-9999px; top:0; opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } finally {
      ta.remove();
    }
    return ok;
  }
}

/** Attach a hover-only clipboard affordance to each copyable bubble row. */
function addCopyRows(bubble, rows) {
  for (const { el, text } of rows) {
    if (!el || !text) continue;
    el.classList.add('copy-row');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.title = 'Copy';
    btn.setAttribute('aria-label', 'Copy');
    btn.innerHTML = COPY_ICON;
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!(await copyText(text))) return;
      btn.innerHTML = CHECK_ICON;
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = COPY_ICON;
        btn.classList.remove('copied');
      }, 900);
    });
    el.appendChild(btn);
  }
}

function showWeekTaskBubble(hit, e) {
  const bubble = $('#viz-bubble');
  const start = hit.startedAt ? fmtClock(hit.startedAt) : '—';
  const end = hit.finishedAt ? fmtClock(hit.finishedAt) : 'running';
  const timeLine = `${start} → ${end}`;
  const statsLine = `est ${fmtMin(hit.estimateMin)} · worked ${fmtMin(hit.elapsedMin)} · ${hit.status}`;
  bubble.innerHTML =
    `<h5>${escapeHtml(hit.title)}</h5>` +
    `<div class="meta">${escapeHtml(hit.date)}</div>` +
    `<div>${timeLine}</div>` +
    `<div class="meta">${escapeHtml(statsLine)}</div>`;
  const [titleRow, dateRow, timeRow, statsRow] = bubble.children;
  addCopyRows(bubble, [
    { el: titleRow, text: hit.title },
    { el: dateRow, text: hit.date },
    { el: timeRow, text: timeLine },
    { el: statsRow, text: statsLine },
  ]);
  bubble.hidden = false;
  placeBubble(bubble, e);
}

function taskSubHtml(t) {
  const start = t.startedAt ? fmtClock(t.startedAt) : '—';
  const end = t.finishedAt ? fmtClock(t.finishedAt) : '—';
  return `<span class="dot s-${t.status}"></span>${escapeHtml(t.title)}` +
    `<span class="sub"><b>${escapeHtml(t.title)}</b><br>${start} → ${end}<br>est ${fmtMin(t.estimateMin)} · worked ${fmtMin(t.elapsedMin)}<br>status: ${t.status}</span>`;
}

function taskCopyText(t) {
  const start = t.startedAt ? fmtClock(t.startedAt) : '—';
  const end = t.finishedAt ? fmtClock(t.finishedAt) : '—';
  return `${t.title}\n${start} → ${end}\nest ${fmtMin(t.estimateMin)} · worked ${fmtMin(t.elapsedMin)}\nstatus: ${t.status}`;
}

/** Month cell preview (click). The day title carries the only chart hint —
 *  task titles never navigate; the hint drills into the workload chart. */
function showMonthBubble(hit, e) {
  const bubble = $('#viz-bubble');
  const day = new Date(hit.date + 'T00:00:00');
  const title = `${day.toLocaleDateString(INTL_TAG[locale] ?? 'en-US', { month: 'short', day: 'numeric' })} · ${hit.tasks.length} task(s)`;
  bubble.innerHTML =
    `<h5 class="has-hint">${escapeHtml(title)}` +
      `<button type="button" class="bb-open" title="Open workload chart" aria-label="Open workload chart">${CHART_ICON}</button></h5>` +
    hit.tasks.map((t) => `<div class="taskline">${taskSubHtml(t)}</div>`).join('') +
    (hit.summary ? `<div class="sumline">${escapeHtml(hit.summary)}</div>` : '');
  addCopyRows(bubble, [{ el: bubble.querySelector('h5'), text: title }]);
  bubble.querySelectorAll('.taskline').forEach((row, i) => {
    addCopyRows(bubble, [{ el: row, text: taskCopyText(hit.tasks[i]) }]);
  });
  const sumline = bubble.querySelector('.sumline');
  if (sumline) addCopyRows(bubble, [{ el: sumline, text: hit.summary }]);
  bubble.querySelector('.bb-open').addEventListener('click', (ev) => {
    ev.stopPropagation();
    selectDay(hit.date);
  });
  bubble.hidden = false;
  placeBubble(bubble, e);
}

function escapeHtml(x) {
  return String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- week summary cells (per day) + weekly summary ----------
function renderWeekSummaries(data) {
  const box = $('#week-summaries');
  if (!data || vizScope !== 'week') {
    box.hidden = true;
    return;
  }
  const byKey = new Map(data.days.map((d) => [d.date, d]));
  const cells = [];
  const cur = new Date(data.fromKey + 'T00:00:00');
  let idx = 0;
  while (keyOf(cur) <= data.toKey) {
    const date = keyOf(cur);
    const d = byKey.get(date);
    const text = d?.summary || '';
    cells.push(
      `<div class="cell ${text ? '' : 'empty'}" data-date="${date}">` +
        `<div class="day-label">${DOW[idx]()} ${date.slice(8)}</div>` +
        (text ? escapeHtml(text.slice(0, 120)) : escapeHtml(T('viz.no_summary'))) +
        `</div>`
    );
    cur.setDate(cur.getDate() + 1);
    idx++;
  }
  const week = data.periodSummary
    ? `<b>${T('viz.week_summary')}</b><br>${escapeHtml(data.periodSummary.slice(0, 160))}`
    : T('viz.no_week_summary');
  box.innerHTML = `<div class="cells">${cells.join('')}</div><div class="week-cell ${data.periodSummary ? '' : 'empty'}">${week}</div>`;
  box.hidden = false;

  // every cell opens its day's chart — same gesture as clicking the column
  box.querySelectorAll('.cell').forEach((cell) => {
    cell.addEventListener('click', () => selectDay(cell.dataset.date));
  });
}

function keyOf(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- summarize ----------
$('#btn-resummarize').addEventListener('click', async () => {
  const st = $('#btn-resummarize');
  st.disabled = true;
  await shapeday.call('report:regen', { scope: sumScope });
  st.disabled = false;
  loadReport();
});
$$('.sum-scopes button[data-scope]').forEach((b) =>
  b.addEventListener('click', () => {
    sumScope = b.dataset.scope;
    $$('.sum-scopes button').forEach((x) => x.classList.toggle('active', x === b));
    loadReport();
  })
);

const METRIC_LABELS = {
  daysTracked: 'days tracked',
  tasksDone: 'tasks done',
  tasksHung: 'hung',
  plannedMin: 'planned',
  actualMin: 'actual work',
  estBias: 'est. bias',
  overworkDays: 'overwork days',
  overworkMin: 'overwork',
  breaks: 'breaks',
  breakMin: 'break time',
  longestNoBreakMin: 'longest stretch',
};

async function loadReport() {
  const r = await shapeday.call('report:get', { scope: sumScope });
  if (!r || r.error) return;

  // the regen affordance exists only in AI mode with a configured endpoint
  const regenBtn = $('#btn-resummarize');
  if (regenBtn) {
    regenBtn.hidden = !(snap.settings.summaryMode === 'ai' && llmConfigured(snap.settings));
  }

  const metrics = $('#sum-metrics');
  metrics.innerHTML = '';
  for (const [k, label] of Object.entries(METRIC_LABELS)) {
    const labelStr = T('metric.' + k);
    let v = r.metrics[k];
    if (v == null) continue;
    if (k.endsWith('Min')) v = fmtMin(v);
    if (k === 'estBias') v = `×${v}`;
    const d = document.createElement('div');
    d.className = 'stat';
    d.innerHTML = `<div class="v"></div><div class="l"></div>`;
    d.querySelector('.v').textContent = v;
    d.querySelector('.l').textContent = labelStr;
    metrics.appendChild(d);
  }

  const issues = $('#sum-issues');
  issues.innerHTML = '';
  const aiMode = snap.settings.summaryMode === 'ai' && llmConfigured(snap.settings);
  const ai = aiMode ? r.llm || aiCache[sumScope] : null;
  if (ai) aiCache[sumScope] = ai;

  const headline = document.createElement('div');
  headline.className = 'sum-headline';
  if (ai) {
    headline.textContent = ai.headline || '';
  } else if (r.templated != null) {
    headline.textContent = r.templated; // templated-text mode (mustache)
  } else {
    headline.textContent = '…';
  }
  issues.appendChild(headline);

  const source = document.createElement('div');
  source.className = 'issue-source';
  source.textContent = sumError
    ? T('sum.src.error', { err: sumError })
    : ai
      ? T('sum.src.model', { model: snap.settings.llm.model })
      : aiMode
        ? T('sum.src.thinking')
        : T('sum.src.template');
  issues.appendChild(source);
  const list = ai ? ai.issues : r.issues;
  for (const i of list) {
    const el = document.createElement('div');
    el.className = 'issue';
    el.innerHTML = `<span class="sev ${i.sev}"></span><div class="body"><div class="text"></div><div class="fix"></div></div>`;
    el.querySelector('.text').textContent = i.about ? `${i.text}  ·  ${i.about}` : i.text;
    el.querySelector('.fix').textContent = i.fix || '';
    issues.appendChild(el);
  }

  const detail = $('#sum-detail');
  detail.innerHTML = '';
  if (sumScope === 'day' && snap.day.tasks.length) {
    const tbl = document.createElement('table');
    tbl.className = 'day-table';
    tbl.innerHTML = `<tr><th>${T('sum.col.task')}</th><th>${T('sum.col.status')}</th><th>${T('sum.col.est')}</th><th>${T('sum.col.actual')}</th><th>${T('sum.col.finished')}</th></tr>`;
    for (const t of snap.day.tasks) {
      const tr = document.createElement('tr');
      const cells = [
        t.title,
        T('status.' + t.status),
        fmtMin(t.estimateMin),
        fmtMin(TimeUtil.taskElapsedMin(t, snap.now)),
        t.finishedAt ? fmtClock(t.finishedAt) : '—',
      ];
      cells.forEach((c, idx) => {
        const td = document.createElement('td');
        td.textContent = c;
        if (idx >= 2) td.className = 'mini';
        tr.appendChild(td);
      });
      tbl.appendChild(tr);
    }
    detail.appendChild(tbl);
  }
}

// ---------- settings ----------
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/; // 24-hour, always — no locale surprises

function bindSetting(id, key, parse) {
  const el = $(id);
  el.addEventListener('change', () => {
    shapeday.call('settings:set', { [key]: parse(el.value) });
  });
}
for (const [id, key] of [['#set-start', 'workStart'], ['#set-end', 'workEnd']]) {
  const el = $(id);
  el.addEventListener('change', () => {
    const v = el.value.trim();
    if (!HHMM.test(v)) {
      el.value = snap.settings[key]; // revert invalid input
      el.title = '24-hour HH:MM, e.g. 09:00';
      return;
    }
    shapeday.call('settings:set', { [key]: v });
  });
}
bindSetting('#set-break', 'breakMinutes', (v) => Math.max(1, Math.min(120, +v || 10)));
$('#set-auto').addEventListener('change', (e) => shapeday.call('settings:set', { autoAdvance: e.target.checked }));
$('#set-overlay').addEventListener('change', (e) => shapeday.call('settings:set', { overlayEnabled: e.target.checked }));

// ---------- estimation / summary modes ----------
$('#set-est-mode').addEventListener('change', (e) => {
  shapeday.call('settings:set', { estimatorMode: e.target.value });
});
$('#set-sum-mode').addEventListener('change', (e) => {
  shapeday.call('settings:set', { summaryMode: e.target.value });
  loadReport();
});
$('#set-sum-template').addEventListener('change', (e) => {
  shapeday.call('settings:set', { summaryTemplate: e.target.value });
  loadReport();
});

// ---------- 24h time steppers (scroller + direct type-in) ----------
for (const btn of $$('.step[data-time]')) {
  btn.addEventListener('click', () => {
    const key = btn.dataset.time === 'set-start' ? 'workStart' : 'workEnd';
    const el = $('#' + btn.dataset.time);
    let m = TimeUtil.parseHM(el.value);
    if (m == null) m = TimeUtil.parseHM(snap.settings[key]) ?? 9 * 60;
    m = (((m + Number(btn.dataset.d)) % 1440) + 1440) % 1440;
    const v = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    el.value = v;
    shapeday.call('settings:set', { [key]: v });
  });
}

// ---------- overlay style ----------
$('#set-overlay-style').addEventListener('change', (e) => {
  shapeday.call('settings:set', { overlayStyle: e.target.value });
});

// ---------- language ----------
$('#set-locale').addEventListener('change', (e) => {
  shapeday.call('settings:set', { locale: e.target.value });
});

// ---------- tint strength ----------
$('#set-tint').addEventListener('input', (e) => {
  $('#tint-val').textContent = `${e.target.value}%`;
  shapeday.call('settings:set', { tintStrength: +e.target.value });
});

// ---------- background customization ----------
$('#bg-choose').addEventListener('click', () => shapeday.call('background:choose'));
$('#bg-clear').addEventListener('click', () => shapeday.call('settings:set', { backgroundImage: '' }));

// ---------- overlay opacity ----------
$('#set-ow-opacity').addEventListener('input', (e) => {
  $('#ow-op-val').textContent = `${e.target.value}%`;
  shapeday.call('settings:set', { overlayOpacity: +e.target.value });
});

// ---------- reflog: unfolded by default, toggleable ----------
let reflogPref = null; // applied on first render, then only when the setting changes
const reflogOpenInput = $('#reflog-open');
reflogOpenInput.addEventListener('click', (e) => e.stopPropagation()); // don't fold the details
reflogOpenInput.addEventListener('change', (e) => {
  shapeday.call('settings:set', { reflogOpen: e.target.checked });
  reflogPref = e.target.checked;
  $('#reflog').open = e.target.checked;
});

// ---------- LLM (OpenAI-compatible chat/completions; user-configured) ----------
const llmPatch = () => ({
  baseUrl: $('#set-llm-url').value.trim(),
  apiKey: $('#set-llm-key').value.trim(),
  model: $('#set-llm-model').value.trim(),
});
for (const id of ['#set-llm-url', '#set-llm-key', '#set-llm-model']) {
  $(id).addEventListener('change', () => {
    shapeday.call('settings:set', { llm: llmPatch() });
  });
}
$('#llm-test').addEventListener('click', async () => {
  const st = $('#llm-status');
  st.textContent = 'testing…';
  st.className = 'llm-status';
  // test what's in the fields right now, not what's saved
  await shapeday.call('settings:set', { llm: llmPatch() });
  const r = await shapeday.call('llm:test');
  st.textContent = r.ok ? `ok · ${r.ms}ms` : r.error || 'failed';
  st.className = 'llm-status ' + (r.ok ? 'ok' : 'err');
});

shapeday.onEvent((ev) => {
  if (ev.type === 'llm:etas') {
    // AI touched estimates: the review banner must be seen (state reopens it
    // via etaReviewed=false when it had been approved)
    if (snap && snap.day.tasks.length) $('#eta-banner').hidden = false;
    const st = $('#eta-llm-status');
    st.textContent = T('eta.ai_adjusted', { n: ev.data.applied });
    st.className = 'llm-status ok';
  }
  if (ev.type === 'llm:status' && !ev.data.ok) {
    if (ev.data.where === 'report') {
      sumError = ev.data.error; // shown where it happened: the Summarize view
      if (currentView === 'sum') loadReport();
      return;
    }
    if (snap && snap.day.tasks.length) $('#eta-banner').hidden = false;
    const st = $('#eta-llm-status');
    st.textContent = ev.data.nothingToRefine
      ? T('eta.nothing_to_refine')
      : T('eta.unreachable', { where: ev.data.where, error: ev.data.error });
    st.className = 'llm-status err';
  }
  if (ev.type === 'llm:report' && currentView === 'sum' && ev.data.scope === sumScope) {
    sumError = null;
    loadReport(); // merge the AI issues into the view
  }
});

function llmConfigured(s) {
  return !!(s.llm && s.llm.baseUrl && s.llm.model);
}

/** Which estimation reading is in play — named, not guessed. */
function etaModeLabel(s) {
  if (s.estimatorMode === 'ai' && llmConfigured(s)) return T('eta.mode_ai_model', { model: s.llm.model });
  if (s.estimatorMode === 'ai') return T('eta.mode_ai_fallback');
  return T('eta.mode_smart');
}

function renderSettings() {
  const s = snap.settings;
  // never overwrite a field the user is editing — the 1 Hz re-render used to
  // reset typed digits (the "settings reset themselves" bug)
  const put = (sel, v) => { const el = $(sel); if (document.activeElement !== el) el.value = v; };
  put('#set-start', s.workStart);
  put('#set-end', s.workEnd);
  put('#set-break', s.breakMinutes);
  put('#set-est-mode', s.estimatorMode === 'ai' ? 'ai' : 'smart');
  put('#set-sum-mode', s.summaryMode === 'ai' ? 'ai' : 'template');
  put('#set-sum-template', s.summaryTemplate || '');
  put('#set-llm-url', s.llm?.baseUrl || '');
  put('#set-llm-key', s.llm?.apiKey || '');
  put('#set-llm-model', s.llm?.model || '');
  put('#set-locale', ['auto', 'en-us', 'zh-hans', 'zh-hant'].includes(s.locale) ? s.locale : 'auto');
  put('#set-ow-opacity', s.overlayOpacity ?? 92);
  put('#set-overlay-style', s.overlayStyle === 'floater' ? 'floater' : 'top');
  put('#set-tint', s.tintStrength ?? 100);
  if (document.activeElement !== $('#set-tint')) {
    $('#tint-val').textContent = `${s.tintStrength ?? 100}%`;
  }
  if (document.activeElement !== $('#set-ow-opacity')) {
    $('#ow-op-val').textContent = `${s.overlayOpacity ?? 92}%`;
  }
  $('#set-auto').checked = s.autoAdvance !== false;
  $('#set-overlay').checked = s.overlayEnabled !== false;
  // background: cover-fit under the scrim; a missing file just falls back to plain
  const bgPath = s.backgroundImage || '';
  const bgLayer = $('#bg-layer');
  if (bgPath) {
    bgLayer.hidden = false;
    bgLayer.style.backgroundImage = `url("file://${bgPath.replace(/\\/g, '/').replace(/"/g, '%22')}")`;
  } else {
    bgLayer.hidden = true;
    bgLayer.style.backgroundImage = '';
  }
  const bgName = $('#bg-name');
  if (bgName) bgName.textContent = bgPath ? bgPath.split(/[\\/]/).pop() : 'none';
  $('#eta-ai').hidden = !(s.estimatorMode === 'ai' && llmConfigured(s));
  const tag = $('#eta-mode');
  if (tag) tag.textContent = etaModeLabel(s);
}

// ---------- settings dropdown: click outside (or Esc) to close ----------
const settingsEl = document.querySelector('details.settings');
document.addEventListener('click', (e) => {
  if (settingsEl.open && !settingsEl.contains(e.target)) settingsEl.open = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsEl.open) settingsEl.open = false;
});

// ---------- the tick ----------
function onTick(s) {
  snap = s;
  const wanted = I18N.resolve(s.settings.locale || 'auto', navigator.language);
  if (wanted !== locale) {
    locale = wanted;
    applyLocale();
    lastPlanSig = null; // hints are baked into rows; rebuild under the new language
  }
  const d = new Date(s.now);
  $('#hd-day').textContent = d.toLocaleDateString(INTL_TAG[locale] ?? 'en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
  $('#hd-fill').style.width = `${Math.round(s.progress.ratio * 100)}%`;
  $('#hd-pct').textContent = `${Math.round(s.progress.ratio * 100)}%`;
  renderPlan();
  renderSettings();
  if (currentView === 'viz') renderViz();
}
shapeday.call('i18n:get').then((r) => I18N.setCatalogs(r.catalogs)); // catalogs come from YAML via the main process
shapeday.onTick(onTick);
shapeday.call('day:get').then(onTick);
