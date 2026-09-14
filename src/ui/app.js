/**
 * app — main window controller. Renders the 1 Hz snapshot; all mutations go
 * through `window.shapeday.call(kind, payload)` (see preload.cjs / README).
 */
'use strict';
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let snap = null;
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
  red: 'click → make current',
  yellow: 'current · click → finish',
  paused: 'on break · click → resume',
  green: 'right-click → reopen',
  white: 'click → revive (unfinished)',
};
const HINT_MANUAL = {
  red: 'click → start',
  yellow: 'click → finish',
  paused: 'on break · click → resume',
  green: 'right-click → reopen',
  white: 'click → revive (unfinished)',
};

// Rebuild the list only when it actually changed — a 1 Hz DOM rebuild would
// cancel in-flight drag-and-drops and steal focus from the steppers.
let lastPlanSig = null;
let dragId = null;

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
  if (sig === lastPlanSig && !dragId) return;
  lastPlanSig = sig;

  const list = $('#task-list');
  list.innerHTML = '';

  if (!day.tasks.length) {
    const li = document.createElement('li');
    li.className = 'task';
    li.style.cursor = 'default';
    li.innerHTML = `<span class="title" style="color:var(--text-dim)">List what's due. Everything starts red — click as you go.</span>`;
    list.appendChild(li);
  }

  const HINT = snap.settings.autoAdvance !== false ? HINT_AUTO : HINT_MANUAL;

  for (const t of day.tasks) {
    const li = document.createElement('li');
    li.className = `task ${t.status}`;
    li.title = `${t.title} — ${HINT[t.status]}`;

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
    title.className = 'title';
    title.textContent = t.title;

    const stamp = document.createElement('span');
    stamp.className = 'stamp';
    const elapsed = TimeUtil.taskElapsedMin(t, snap.now);
    if (t.status === 'yellow') stamp.textContent = `▶ ${fmtMin(elapsed)}`;
    else if (t.status === 'green') stamp.textContent = `${fmtClock(t.startedAt ?? snap.now)} → ${fmtClock(t.finishedAt ?? snap.now)} · ${fmtMin(elapsed)}`;
    else if (t.status === 'paused') stamp.textContent = `⏸ on break · ${fmtMin(elapsed)} so far`;
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
      chip.append(minus, document.createTextNode(`~${fmtMin(t.estimateMin)}`), plus);
    }

    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = HINT[t.status];

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

const KIND_TEXT = { added: 'added', deleted: 'deleted', status: 'status' };

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
    kind.textContent =
      e.kind === 'status' ? `${e.from} → ${e.to}` : KIND_TEXT[e.kind] || e.kind;
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
let vizData = null; // last fetched {scope, days, ...} for week/month
let vizFetchedAt = 0;
const VIZ_TTL = 15000; // refetch week/month data at most every 15s

async function renderViz(force) {
  if (!snap) return;
  const canvas = $('#timeline');
  const dayOnly = document.querySelectorAll('.viz-stats, .legend');
  if (vizScope === 'day') {
    dayOnly.forEach((el) => (el.style.display = ''));
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
  if (force || !vizData || vizData.scope !== vizScope || Date.now() - vizFetchedAt > VIZ_TTL) {
    vizData = await shapeday.call('viz:days', { scope: vizScope });
    vizFetchedAt = Date.now();
    if (!vizData || vizData.scope !== vizScope) return; // scope switched mid-fetch
  }
  if (vizScope === 'week') Timeline.renderWeek(canvas, vizData);
  else Timeline.renderMonth(canvas, vizData);
}

$$('.viz-scopes button').forEach((b) =>
  b.addEventListener('click', () => {
    vizScope = b.dataset.viz;
    $$('.viz-scopes button').forEach((x) => x.classList.toggle('active', x === b));
    renderViz(true);
  })
);
$('#timeline').addEventListener('mousemove', (e) => Timeline.hover($('#timeline'), e.clientX, e.clientY));
$('#timeline').addEventListener('mouseleave', () => Timeline.hoverEnd());

// ---------- summarize ----------
$$('.sum-scopes button').forEach((b) =>
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

  const metrics = $('#sum-metrics');
  metrics.innerHTML = '';
  for (const [k, label] of Object.entries(METRIC_LABELS)) {
    let v = r.metrics[k];
    if (v == null) continue;
    if (k.endsWith('Min')) v = fmtMin(v);
    if (k === 'estBias') v = `×${v}`;
    const d = document.createElement('div');
    d.className = 'stat';
    d.innerHTML = `<div class="v"></div><div class="l"></div>`;
    d.querySelector('.v').textContent = v;
    d.querySelector('.l').textContent = label;
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
    ? `AI error: ${sumError}`
    : ai
      ? `AI · ${snap.settings.llm.model}`
      : aiMode
        ? 'AI thinking…' // fired async; the llm:report event re-renders
        : 'templated text · findings from local rules';
  issues.appendChild(source);
  const list = ai ? ai.issues : r.issues;
  for (const i of list) {
    const el = document.createElement('div');
    el.className = 'issue';
    el.innerHTML = `<span class="sev ${i.sev}"></span><div class="body"><div class="text"></div><div class="fix"></div></div>`;
    el.querySelector('.text').textContent = i.text;
    el.querySelector('.fix').textContent = i.fix;
    issues.appendChild(el);
  }

  const detail = $('#sum-detail');
  detail.innerHTML = '';
  if (sumScope === 'day' && snap.day.tasks.length) {
    const tbl = document.createElement('table');
    tbl.className = 'day-table';
    tbl.innerHTML = '<tr><th>task</th><th>status</th><th>est</th><th>actual</th><th>finished</th></tr>';
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
bindSetting('#set-break', 'breakMinutes', (v) => Math.max(5, Math.min(30, +v || 10)));
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
    st.textContent = `AI adjusted ${ev.data.applied} estimate(s) — review again`;
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
  if (s.estimatorMode === 'ai' && llmConfigured(s)) return `AI estimation · ${s.llm.model}`;
  if (s.estimatorMode === 'ai') return 'AI estimation (no endpoint — smart reading)';
  return 'smart reading';
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
  put('#set-ow-opacity', s.overlayOpacity ?? 92);
  if (document.activeElement !== $('#set-ow-opacity')) {
    $('#ow-op-val').textContent = `${s.overlayOpacity ?? 92}%`;
  }
  $('#set-auto').checked = s.autoAdvance !== false;
  $('#set-overlay').checked = s.overlayEnabled !== false;
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

// ---------- self-evaluation (towards 50%) ----------
shapeday.onEvent((ev) => {
  if (ev.type === 'eval-prompt') $('#eval-modal').classList.add('open');
});
$$('#eval-modal [data-resp]').forEach((b) =>
  b.addEventListener('click', () => {
    shapeday.call('eval:respond', { response: b.dataset.resp });
    $('#eval-modal').classList.remove('open');
  })
);

// ---------- the tick ----------
function onTick(s) {
  snap = s;
  const d = new Date(s.now);
  $('#hd-day').textContent = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  $('#hd-fill').style.width = `${Math.round(s.progress.ratio * 100)}%`;
  $('#hd-pct').textContent = `${Math.round(s.progress.ratio * 100)}%`;
  renderPlan();
  renderSettings();
  if (currentView === 'viz') renderViz();
}
shapeday.onTick(onTick);
shapeday.call('day:get').then(onTick);
