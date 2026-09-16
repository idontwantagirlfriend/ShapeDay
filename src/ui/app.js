/**
 * app — main window controller. Renders the 1 Hz snapshot; all mutations go
 * through `window.shapeday.call(kind, payload)` (see preload.cjs / README).
 */
'use strict';
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let snap = null;
let locale = 'en-us';
const T = (k) => I18N.t(locale, k);
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
  red: () => T('click → make current'),
  yellow: () => T('current · click → finish'),
  paused: () => T('on break · click → resume'),
  green: () => T('click → reopen'),
  white: () => T('click → revive (unfinished)'),
};
const HINT_MANUAL = {
  red: () => T('click → start'),
  yellow: () => T('click → finish'),
  paused: () => T('on break · click → resume'),
  green: () => T('click → reopen'),
  white: () => T('click → revive (unfinished)'),
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
    li.innerHTML = `<span class="title" style="color:var(--text-dim)">${escapeHtml(T("List what's due. Everything starts red — click as you go."))}</span>`;
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
    else if (t.status === 'paused') stamp.textContent = `⏸ ${T('on break')} · ${fmtMin(elapsed)} ${T('so far')}`;
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

const KIND_TEXT = { added: () => T('added'), deleted: () => T('deleted'), status: () => T('status') };

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
        `<span class="w-${e.from}">${escapeHtml(T(e.from))}</span>` +
        ' → ' +
        `<span class="w-${e.to}">${escapeHtml(T(e.to))}</span>`;
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
$('#timeline').addEventListener('mousemove', (e) => {
  const canvas = $('#timeline');
  if (vizScope === 'day') {
    Timeline.hover(canvas, e.clientX, e.clientY);
  } else if (vizScope === 'month') {
    const hit = Timeline.hitTest(canvas, e.clientX, e.clientY);
    if (hit?.kind === 'day' && (hit.tasks.length || hit.summary)) {
      showMonthBubble(hit, e);
    } else {
      hideVizBubble();
    }
  } else if (vizScope === 'week') {
    // hover-to-preview on any task block; no click needed
    const hit = Timeline.hitTest(canvas, e.clientX, e.clientY);
    if (hit?.kind === 'task') {
      showWeekPreview(hit, e);
    } else {
      hideVizBubble();
    }
  }
});
$('#timeline').addEventListener('mouseleave', () => {
  Timeline.hoverEnd();
  if (vizScope !== 'day') hideVizBubble();
});

// week: click a task block for its details; click a column to open that day
// month: click a day cell to open that day
$('#timeline').addEventListener('click', (e) => {
  if (vizScope !== 'week' && vizScope !== 'month') return;
  const hit = Timeline.hitTest($('#timeline'), e.clientX, e.clientY);
  if (hit?.kind === 'task') showWeekTaskBubble(hit, e);
  else if (hit?.kind === 'day' && hit.date) selectDay(hit.date);
  else hideVizBubble();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideVizBubble();
});

// ---------- viz bubbles ----------
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => () => T(d));

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
  $('#viz-bubble').hidden = true;
}

function taskSubHtml(t) {
  const start = t.startedAt ? fmtClock(t.startedAt) : '—';
  const end = t.finishedAt ? fmtClock(t.finishedAt) : '—';
  return `<span class="dot s-${t.status}"></span>${escapeHtml(t.title)}` +
    `<span class="sub"><b>${escapeHtml(t.title)}</b><br>${start} → ${end}<br>est ${fmtMin(t.estimateMin)} · worked ${fmtMin(t.elapsedMin)}<br>status: ${t.status}</span>`;
}

/** Hover preview for a block whose wrapped text was ellipsized. */
function showWeekPreview(hit, e) {
  const bubble = $('#viz-bubble');
  const start = hit.startedAt ? fmtClock(hit.startedAt) : '—';
  const end = hit.finishedAt ? fmtClock(hit.finishedAt) : 'running';
  bubble.innerHTML =
    `<h5>${escapeHtml(hit.title)}</h5>` +
    `<div class="meta">${hit.date} · ${start} → ${end}</div>`;
  bubble.hidden = false;
  placeBubble(bubble, e);
}

function showWeekTaskBubble(hit, e) {
  const bubble = $('#viz-bubble');
  const start = hit.startedAt ? fmtClock(hit.startedAt) : '—';
  const end = hit.finishedAt ? fmtClock(hit.finishedAt) : 'running';
  bubble.innerHTML =
    `<h5>${escapeHtml(hit.title)}</h5>` +
    `<div class="meta">${hit.date}</div>` +
    `<div>${start} → ${end}</div>` +
    `<div class="meta">est ${fmtMin(hit.estimateMin)} · worked ${fmtMin(hit.elapsedMin)} · ${hit.status}</div>`;
  bubble.hidden = false;
  placeBubble(bubble, e);
}

/** Tiny burn-up of the hovered day: same reading as the Day chart. */
function miniDayCanvas(hit) {
  const tasks = (hit.tasks || [])
    .filter((t) => (t.worked || []).length)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  if (!tasks.length) return null;
  const cv = document.createElement('canvas');
  cv.className = 'mini-day';
  cv.width = 560; cv.height = 110; // 2x for crispness, styled down via CSS
  const ctx = cv.getContext('2d');
  const ws = hit.workStart ?? tasks[0].worked[0].start;
  const we = hit.workEnd ?? ws + 8 * 3600000;
  let lastEnd = we;
  for (const t of tasks) for (const seg of t.worked) lastEnd = Math.max(lastEnd, seg.end ?? seg.start);
  const total = tasks.reduce((acc, t) => acc + t.estimateMin, 0) || 30;
  const X = (t) => 6 + ((t - ws) / Math.max(1, lastEnd - ws)) * (cv.width - 12);
  const Y = (v) => cv.height - 8 - (v / (total * 1.1)) * (cv.height - 16);
  // overwork region
  if (lastEnd > we) {
    ctx.fillStyle = 'rgba(128, 61, 58, 0.4)';
    ctx.fillRect(X(we), 6, X(lastEnd) - X(we), cv.height - 12);
  }
  ctx.strokeStyle = 'rgba(224, 101, 90, 0.6)';
  ctx.beginPath(); ctx.moveTo(X(we), 6); ctx.lineTo(X(we), cv.height - 6); ctx.stroke();
  // the earned line
  ctx.beginPath();
  ctx.moveTo(X(ws), Y(0));
  let y = 0;
  for (const t of tasks) {
    const tw = t.worked.reduce((acc, x) => acc + (x.end - x.start), 0) / 60000;
    if (tw <= 0) continue;
    const rise = t.status === 'green' ? t.estimateMin : Math.min(tw, t.estimateMin);
    for (const seg of t.worked) {
      const share = ((seg.end - seg.start) / 60000 / tw) * rise;
      ctx.lineTo(X(seg.start), Y(y));
      ctx.lineTo(X(seg.end), Y(y + share));
      y += share;
    }
  }
  ctx.strokeStyle = '#aed8fc';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineTo(X(lastEnd), Y(0));
  ctx.closePath();
  ctx.fillStyle = 'rgba(174, 216, 252, 0.12)';
  ctx.fill();
  return cv;
}

function showMonthBubble(hit, e) {
  const bubble = $('#viz-bubble');
  const rows = hit.tasks
    .map((t) => `<div class="taskline">${taskSubHtml(t)}</div>`)
    .join('');
  const sum = hit.summary ? `<div class="sumline">${escapeHtml(hit.summary)}</div>` : '';
  bubble.innerHTML =
    `<h5>${Number(hit.date.slice(8))} · ${hit.tasks.length} task(s)</h5>` + rows;
  const mini = miniDayCanvas(hit);
  if (mini) bubble.appendChild(mini); // inside the bubble, always
  if (sum) bubble.insertAdjacentHTML('beforeend', sum);
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
  const dates = []; // rendered calendar dates, aligned with the cells
  const cur = new Date(data.fromKey + 'T00:00:00');
  let idx = 0;
  while (keyOf(cur) <= data.toKey) {
    const date = keyOf(cur);
    dates.push(date);
    const d = byKey.get(date);
    const text = d?.summary || '';
    cells.push(
      `<div class="cell ${text ? '' : 'empty'}" data-date="${date}">` +
        `<div class="day-label">${DOW[idx]()} ${date.slice(8)}</div>` +
        (text ? escapeHtml(text.slice(0, 120)) : escapeHtml(T('no summary'))) +
        `</div>`
    );
    cur.setDate(cur.getDate() + 1);
    idx++;
  }
  const week = data.periodSummary
    ? `<b>${T('Week summary')}</b><br>${escapeHtml(data.periodSummary.slice(0, 160))}`
    : T('no weekly summary yet');
  box.innerHTML = `<div class="cells">${cells.join('')}</div><div class="week-cell ${data.periodSummary ? '' : 'empty'}">${week}</div>`;
  box.hidden = false;

  // every cell opens its day's chart — same gesture as clicking the column
  box.querySelectorAll('.cell').forEach((cell) => {
    cell.addEventListener('click', () => selectDay(cell.dataset.date));
  });
  bindCellPreviews(box, dates, byKey, data);
}

/** Full-text previews for the summary cells via the shared bubble. The
 *  bubble prefers to extend UPWARD so it never grows the page (a downward
 *  popup pushes the scroll area, the cursor leaves the cell, and the popup
 *  closes — the loop she reported). */
function bindCellPreviews(box, dates, byKey, data) {
  const wrap = document.querySelector('.viz-wrap');
  const bubble = $('#viz-bubble');
  const show = (text, cell) => {
    if (!text || !cell.isConnected) return; // stale cell from a re-render
    bubble.textContent = text;
    bubble.hidden = false;
    const wrapR = wrap.getBoundingClientRect();
    const cellR = cell.getBoundingClientRect();
    const bw = Math.min(320, wrapR.width - 16);
    bubble.style.maxWidth = `${bw}px`;
    const bh = bubble.offsetHeight;
    let x = cellR.left - wrapR.left;
    x = Math.max(8, Math.min(x, wrapR.width - bw - 8));
    let y = cellR.top - wrapR.top - bh - 8; // extend upward first
    if (y < 0) y = cellR.bottom - wrapR.top + 8; // no room above: below, still inside
    bubble.style.left = `${x}px`;
    bubble.style.top = `${y}px`;
  };
  const hide = () => hideVizBubble();
  const cells = [...box.querySelectorAll('.cell, .week-cell')];
  // texts aligned to the RENDERED calendar cells (future days have no data),
  // then the weekly summary for the trailing wide cell
  const texts = [
    ...dates.map((date) => byKey.get(date)?.summary || ''),
    data.periodSummary || '',
  ];
  cells.forEach((cell, i) => {
    cell.onmouseenter = () => show(texts[i], cell);
    cell.onmouseleave = hide;
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
    const labelStr = T(label);
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
    ? `${T('AI error')}: ${sumError}`
    : ai
      ? `AI · ${snap.settings.llm.model}`
      : aiMode
        ? T('AI thinking…') // fired async; the llm:report event re-renders
        : T('templated text · findings from local rules');
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
    tbl.innerHTML = `<tr><th>${T('task')}</th><th>${T('status')}</th><th>${T('est')}</th><th>${T('actual')}</th><th>${T('finished')}</th></tr>`;
    for (const t of snap.day.tasks) {
      const tr = document.createElement('tr');
      const cells = [
        t.title,
        t.status,
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
    st.textContent = `${T('AI adjusted')} ${ev.data.applied} ${T('estimate(s) — review again')}`;
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
    st.textContent = `AI unreachable (${ev.data.where}): ${ev.data.error}`;
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
  if (s.estimatorMode === 'ai' && llmConfigured(s)) return `${T('AI estimation')} · ${s.llm.model}`;
  if (s.estimatorMode === 'ai') return T('AI estimation') + ' (' + T('smart reading') + ')';
  return T('smart reading');
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
shapeday.onTick(onTick);
shapeday.call('day:get').then(onTick);
