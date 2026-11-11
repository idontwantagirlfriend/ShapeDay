/**
 * state — the orchestrator. Owns the store, the task state machine, breaks,
 * auto-advance, the 50% self-evaluation prompt, the overwork clock and the
 * advisor reports. Pure of Electron: everything arrives as actions and
 * leaves as snapshots/events, so it is unit-testable headlessly.
 */
'use strict';
const TimeUtil = require('../core/timeutil.cjs');
const Model = require('../core/model.cjs');
const Estimator = require('../core/estimator.cjs');
const Advisor = require('../core/advisor.cjs');
const LLM = require('../core/llm.cjs');
const { randomUUID } = require('node:crypto');
const Template = require('../core/template.cjs');
const Recurrence = require('../core/recurrence.cjs');

function createState(store, hooks = {}) {
  const pending = { events: [] }; // queued events drained each tick/action
  const onDirty = () => hooks.onDirty && hooks.onDirty();

  const etaDebounce = { timer: null, inFlight: false };
  const llmReport = { cache: {}, inFlight: {}, mut: 0 };
  let stopped = false;
  // Capture before the first tick writes this session's heartbeat.
  const startupDays = new Set(store.daysRange('0000-01-01', '9999-12-31'));
  const startupLastSeenAt = store.lastSeenAt;

  function emit(type, data) {
    pending.events.push({ type, data });
  }

  function today() {
    const key = TimeUtil.todayKey();
    store.updateDay(key, () => {});
    return store.day(key);
  }

  function boundsFor(day) {
    const s = store.settings;
    return TimeUtil.workBounds(day.date, s.workStart, s.workEnd);
  }

  /** The active (open) break, if any — spec: one break at a time. */
  function activeBreak(day) {
    return (day.breaks || []).find((b) => b.end == null) || null;
  }

  function snapshot(nowMs) {
    const now = nowMs ?? Date.now();
    const day = today();
    const bounds = boundsFor(day);
    const overworkMin = TimeUtil.overworkMinutes(now, bounds);
    const progress = Model.dayProgress(day);
    const active = Model.activeTask(day);
    const brk = activeBreak(day);
    return {
      now,
      date: day.date,
      day,
      bounds,
      overworkMin,
      progress,
      active,
      break: brk
        ? {
            startedAt: brk.start,
            plannedEnd: brk.start + brk.plannedMin * 60000,
            remainingMin: Math.max(0, Math.ceil((brk.start + brk.plannedMin * 60000 - now) / 60000)),
          }
        : null,
      settings: store.settings,
      recurring: store.recurring,
    };
  }

  /** Auto-advance mode flag (default on): frontier flagging + one-click finish. */
  function autoMode() {
    return store.settings.autoAdvance !== false;
  }

  /**
   * Keep the frontier rule true: one task in progress — the first red after
   * the last finished one, else the first in the list. While a break runs,
   * nothing is in progress (the current task is parked, so its worked-time
   * stamps never absorb the break).
   */
  function maintainIfAuto(day, now) {
    if (activeBreak(day)) {
      // On a break, the current task goes "on break" too (paused) — its
      // worked-time stamps never absorb the break, and it resumes after.
      for (const t of day.tasks || []) {
        if (t.status === 'yellow') {
          const segs = t.worked || (t.worked = []);
          if (segs.length && segs[segs.length - 1].end == null) segs[segs.length - 1].end = now;
          activeBreak(day).resumeTaskId = t.id;
          t.status = 'paused';
        }
      }
      return;
    }
    const ended = [...(day.breaks || [])].reverse().find((b) => b.end != null && b.resumeTaskId);
    if (ended) {
      const task = Model.findTask(day, ended.resumeTaskId);
      delete ended.resumeTaskId;
      if (!autoMode() && task?.status === 'paused' && !Model.activeTask(day)) Model.switchTo(day, task.id, now);
    }
    if (autoMode()) Model.maintainCurrent(day, now);
  }

  /**
   * tick — called ~1 Hz from the main process.
   * Closes finished breaks, fires the 50% self-evaluation prompt once.
   */
  // ---------- day rollover: white tasks revive on top of the new day ------

  let lastDayKey = null;

  /** Carry the most recent stored earlier day, not just calendar yesterday. */
  function reviveHungTasks(todayDay, now) {
    const prev = store.daysRange('0000-01-01', todayDay.date)
      .filter((d) => d.date < todayDay.date).at(-1);
    if (!prev || prev.tasksMigratedTo) return;
    const hung = (prev.tasks || []).filter((t) =>
      ['red', 'white', 'paused'].includes(t.status) && !(prev.whitesMigrated && t.status === 'white'));
    logged(todayDay, () => {
      const fresh = hung.filter((t) => !todayDay.tasks.some((x) =>
        x.carriedFrom?.date === prev.date && x.carriedFrom?.id === t.id)).map((t) => {
        const task = Model.newTask(t.title, t.estimateMin);
        task.createdAt = now;
        task.carriedFrom = { date: prev.date, id: t.id };
        if (t.recurringId != null) task.recurringId = t.recurringId;
        if (t.estEdited) task.estEdited = true;
        return task;
      });
      todayDay.tasks.unshift(...fresh);
    });
    prev.tasksMigratedTo = todayDay.date;
    prev.whitesMigrated = true; // compatibility with older installs
    touch();
  }

  function midnightAfter(date) {
    const d = new Date(date + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  /** No frontier maintenance here: closing a session must never start work. */
  function closeDay(day, at, recovering = false) {
    logged(day, () => {
      for (const task of day.tasks || []) {
        const end = Math.min(at, midnightAfter(day.date));
        const open = (task.worked || []).filter((seg) => seg.end == null);
        for (const seg of open) {
          // Legacy data without a heartbeat has no evidence of elapsed work.
          const cutoff = Number.isFinite(end) ? end : seg.start;
          seg.end = Math.max(seg.start, cutoff);
        }
        if (task.status === 'yellow') {
          task.status = 'green';
          task.finishedAt = Math.max(task.startedAt || 0, Number.isFinite(end) ? end : 0, ...open.map((s) => s.end));
          task.evalPrompted = true; // recovery/quit is not an interactive finish
        }
      }
      if (recovering || activeBreak(day)) {
        for (const brk of day.breaks || []) {
          if (brk.end == null) brk.end = Math.max(brk.start, Math.min(
            Number.isFinite(at) ? at : brk.start, brk.start + brk.plannedMin * TimeUtil.MIN));
          delete brk.resumeTaskId;
        }
      }
    });
    touch();
  }

  function shutdown(nowMs = Date.now()) {
    if (stopped) return;
    stopped = true;
    clearTimeout(etaDebounce.timer);
    for (const day of store.daysRange('0000-01-01', TimeUtil.todayKey())) {
      closeDay(day, startupDays.has(day) ? day.lastSeenAt ?? startupLastSeenAt : nowMs, true);
    }
    store.flush();
  }

  /** A day keeps the work hours it lived under: charts for past days never
   *  move when the global hours change later. Stamped at rollover (and
   *  lazily for days the app wasn't running to close out). */
  function freezeDayHours() {
    const s = store.settings;
    const todayKey = TimeUtil.todayKey();
    for (const d of Object.values(store.daysRange('0000-01-01', '9999-12-31'))) {
      if (d.date < todayKey && !d.hours) d.hours = { workStart: s.workStart, workEnd: s.workEnd };
    }
  }

  function setFrequency(task, frequency, now = Date.now()) {
    let rule = store.recurring.find((r) => r.id === task.recurringId);
    if (rule && rule.every === frequency.every && rule.unit === frequency.unit) return rule;
    store.updateRecurring((rules) => {
      if (!rule) {
        // Capture the current estimate once; the compact rule list owns later
        // duration edits, while task copies retain their individual estimates.
        rule = { id: randomUUID(), title: task.title, estimateMin: task.estimateMin, createdAt: now };
        rules.push(rule);
        task.recurringId = rule.id;
      }
      Object.assign(rule, frequency, Recurrence.schedule(frequency, now));
    });
    touch();
    return rule;
  }

  function removeRecurring(id) {
    store.updateRecurring((rules) => {
      const index = rules.findIndex((r) => r.id === id);
      if (index >= 0) rules.splice(index, 1);
    });
    for (const day of store.daysRange('0000-01-01', '9999-12-31')) {
      for (const task of day.tasks || []) {
        if (task.recurringId === id) delete task.recurringId;
      }
    }
    touch();
  }

  function triggerRecurring(day, now, dailyLaunch) {
    let changed = false;
    store.updateRecurring((rules) => {
      for (const rule of rules) {
        if (!Recurrence.consume(rule, now, dailyLaunch)) continue;
        changed = true;
        if (day.tasks.some((t) => t.recurringId === rule.id && ['red', 'yellow', 'paused'].includes(t.status))) continue;
        logged(day, () => {
          const task = Model.newTask(rule.title, rule.estimateMin);
          task.createdAt = now;
          task.recurringId = rule.id;
          day.tasks.push(task); // a triggered copy always lands red, without changing completed copies
        });
      }
    });
    if (changed) touch();
  }

  function tick(nowMs) {
    const now = nowMs ?? Date.now();
    const day = today();
    if (stopped) return { snapshot: snapshot(now), events: drain() };
    const firstTick = lastDayKey == null;
    const dailyLaunch = firstTick && store.lastDailyLaunch !== day.date;
    if (lastDayKey == null) {
      for (const old of startupDays) {
        closeDay(old, old.lastSeenAt ?? startupLastSeenAt, true);
      }
      startupDays.clear();
    }
    if (day.date !== lastDayKey) {
      if (lastDayKey) {
        const old = store.day(lastDayKey);
        if (old) closeDay(old, Math.min(now, midnightAfter(old.date)));
      }
      lastDayKey = day.date;
      freezeDayHours();
      reviveHungTasks(day, now);
      store.flush(); // closure + migration marker commit together
    }
    triggerRecurring(day, now, dailyLaunch);
    if (firstTick) store.markDailyLaunch(day.date);
    day.lastSeenAt = now; // persisted by today's updateDay heartbeat
    const brk = activeBreak(day);
    if (brk && now >= brk.start + brk.plannedMin * 60000) {
      brk.end = now;
      emit('break-over', {});
      logged(day, () => maintainIfAuto(day, now));
      store.flush();
    }
    // Halfway notice: the pacing of the CURRENT task, not half the day's
    // workload. Fires when the task under way crosses half its estimate
    // (or finishes, if it never lingered there) — once per task.
    if (!day.selfEval) day.selfEval = { promptedAt: null, response: null };
    const active = Model.activeTask(day);
    const evalTask = active || [...(day.tasks || [])].reverse().find((t) => t.status === 'green' && !t.evalPrompted);
    if (evalTask && !evalTask.evalPrompted) {
      const worked = TimeUtil.taskElapsedMin(evalTask, now);
      const halfway = evalTask.estimateMin > 0 && worked * 2 >= evalTask.estimateMin;
      if (halfway || evalTask.status === 'green') {
        evalTask.evalPrompted = true;
        day.selfEval.promptedAt = now;
        emit('eval-prompt', { taskId: evalTask.id, title: evalTask.title, workedMin: worked, estimateMin: evalTask.estimateMin });
      }
    }
    return { snapshot: snapshot(now), events: drain() };
  }

  function drain() {
    const out = pending.events;
    pending.events = [];
    return out;
  }

  // ---------- LLM (OpenAI-compatible chat/completions; user-configured) ----------

  function llmCfg() {
    const l = store.settings.llm || {};
    // key optional for local endpoints; prompt files resolve data-dir first,
    // then the bundled defaults (prompts/ inside the package)
    return l.baseUrl && l.model
      ? { ...l, promptsDir: hooks.promptsDir, bundledDir: hooks.bundledPromptsDir }
      : null;
  }

  /** AI estimation is opt-in: mode must say 'ai' AND an endpoint must exist. */
  function estimatorUsesAI() {
    return store.settings.estimatorMode === 'ai' && !!llmCfg();
  }

  const fmtMin = (m) => {
    const v = Math.round(Number(m) || 0);
    return v >= 60 ? `${Math.floor(v / 60)}h ${String(v % 60).padStart(2, '0')}m` : `${v}m`;
  };

  /** Arguments available to the mustache summary template. */
  function templateArgs(metrics, scope) {
    return {
      scope,
      daysTracked: metrics.daysTracked,
      tasksDone: metrics.tasksDone,
      tasksTotal: metrics.tasksTotal,
      tasksHung: metrics.tasksHung,
      plannedMin: fmtMin(metrics.plannedMin),
      actualMin: fmtMin(metrics.actualMin),
      estBias: metrics.estBias == null ? '—' : `×${metrics.estBias}`,
      overworkDays: metrics.overworkDays,
      overworkMin: fmtMin(metrics.overworkMin),
      breaks: metrics.breaks,
      breakMin: fmtMin(metrics.breakMin),
      longestNoBreakMin: fmtMin(metrics.longestNoBreakMin),
    };
  }

  function touch() {
    llmReport.mut++; // invalidate cached AI summaries on any day mutation
  }

  /**
   * Reflog: run fn, then diff tasks before/after and record additions,
   * deletions and status changes on day.reflog. Diffing (rather than
   * instrumenting the model) catches every path — manual clicks, frontier
   * auto-flagging, break parking, deletion.
   */
  function logged(day, fn) {
    const before = new Map((day.tasks || []).map((t) => [t.id, { s: t.status, t: t.title }]));
    const r = fn();
    const now = Date.now();
    const log = day.reflog || (day.reflog = []);
    for (const [id, info] of before) {
      if (!day.tasks.some((t) => t.id === id)) {
        log.push({ at: now, kind: 'deleted', title: info.t });
      }
    }
    for (const t of day.tasks || []) {
      const b = before.get(t.id);
      if (!b) log.push({ at: now, kind: 'added', title: t.title });
      else if (b.s !== t.status) log.push({ at: now, kind: 'status', title: t.title, from: b.s, to: t.status });
    }
    if (log.length > 300) day.reflog = log.slice(-300);
    return r;
  }

  /**
   * Batch-refine ETAs for listed-but-unstarted tasks the user hasn't hand-set.
   * Debounced after task:add; also callable directly ("Refine with AI").
   */
  function scheduleEtaRefinement(delayMs = 2500, onlyId = null) {
    if (!estimatorUsesAI()) return;
    clearTimeout(etaDebounce.timer);
    etaDebounce.onlyId = onlyId;
    etaDebounce.timer = setTimeout(() => runEtaRefinement(false, etaDebounce.onlyId), delayMs);
    if (etaDebounce.timer.unref) etaDebounce.timer.unref();
  }

  async function runEtaRefinement(manual = false, onlyId = null) {
    if (stopped || etaDebounce.inFlight || !estimatorUsesAI()) return;
    const day = today();
    // anything unfinished that the human has not hand-edited is fair game:
    // the frontier keeps one task yellow, so red-only would often match nothing.
    // Auto runs after task:add estimate ONLY the new task; the full list is
    // refined exclusively via the Refine with AI button (manual).
    const only = manual ? null : onlyId ?? etaDebounce.onlyId ?? null;
    etaDebounce.onlyId = null;
    const candidates = day.tasks.filter(
      (t) => t.status !== 'green' && t.status !== 'white' && !t.estEdited && (!only || t.id === only)
    );
    if (!candidates.length) {
      if (manual) {
        emit('llm:status', {
          ok: false,
          where: 'etas',
          nothingToRefine: true, // renderer swaps in the localized eta.nothing_to_refine
          error: 'nothing to refine: every task is done, hung, or hand-edited',
        });
        onDirty();
      }
      return;
    }
    etaDebounce.inFlight = true;
    try {
      const updates = await LLM.refineEtas(llmCfg(), {
        tasks: candidates,
        history: store.historyBefore(day.date).map((t) => ({
          title: t.title,
          est: t.estimateMin,
          act: Math.round((t.worked || []).reduce((s, seg) => s + ((seg.end ?? 0) - seg.start), 0) / 60000),
        })),
        workHours: `${store.settings.workStart}–${store.settings.workEnd}`,
        bias: Estimator.biasFactor(store.historyBefore(day.date)),
      });
      if (stopped) return;
      let applied = 0;
      for (const u of updates) {
        const t = Model.findTask(day, u.id);
        if (t && t.status !== 'green' && t.status !== 'white' && !t.estEdited) {
          t.estimateMin = u.minutes;
          applied++;
        }
      }
      if (applied) {
        // The AI just changed numbers the user may have already approved:
        // reopen the review so the change is seen, never silent.
        if (day.etaReviewed) day.etaReviewed = false;
        touch();
        emit('llm:etas', { applied });
        onDirty();
      }
    } catch (e) {
      emit('llm:status', { ok: false, where: 'etas', error: String(e.message || e).slice(0, 140) });
      onDirty();
    } finally {
      etaDebounce.inFlight = false;
      store.flush();
    }
  }

  /** Per-day context for the summarizer, matching prompts/summary.txt:
   *  todos with expected and execution timespans, ids citable. */
  function summaryDays(days, now) {
    const s = store.settings;
    return days.map((d) => {
      const hours = d.hours || s;
      const bounds = TimeUtil.workBounds(d.date, hours.workStart, hours.workEnd);
      const endRef = d.date === TimeUtil.todayKey() ? now : Math.min(midnightAfter(d.date), Math.max(bounds.end, ...(d.tasks || []).map((t) => t.finishedAt ?? 0)));
      const workRef = d.date === TimeUtil.todayKey() ? now : Math.min(now, d.lastSeenAt ?? midnightAfter(d.date));
      return {
        date: d.date,
        scheduledWorkHours: `${hours.workStart}-${hours.workEnd}`,
        totalActualWorkMinutes: Math.round((d.tasks || []).reduce((sum, t) => sum + Advisor.actualWorkMinutes(t, workRef), 0)),
        overworkMinutes: Math.max(0, Math.round((endRef - bounds.end) / TimeUtil.MIN)),
        breaks: (d.breaks || []).length,
        tasks: (d.tasks || []).map((t) => ({
          id: t.id,
          title: t.title,
          expectedMinutes: t.estimateMin,
          actualMinutes: Math.round(Advisor.actualWorkMinutes(t, workRef)),
          status: t.status,
        })),
      };
    });
  }

  /** The past three days' summaries, for the daily prompt's {history_reports}.
   *  Persisted AI recaps when present; the local template line as fallback. */
  function historyReports(now, key = TimeUtil.todayKey()) {
    const s = store.settings;
    const pad = (x) => String(x).padStart(2, '0');
    const from = new Date(key + 'T00:00:00');
    from.setDate(from.getDate() - 3);
    const fromKey = `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())}`;
    return store
      .daysRange(fromKey, key)
      .filter((d) => d.date !== key && (d.tasks || []).length)
      .slice(-3)
      .map((d) => {
        const persisted = store.summary(d.date);
        if (persisted?.recap) return `${d.date}: ${persisted.recap.replace(/\s+/g, ' ').slice(0, 300)}`;
        const local = Advisor.report([d], s);
        return `${d.date}: ${Template.render(s.summaryTemplate || '', templateArgs(local.metrics, 'day'))}`;
      })
      .join('\n');
  }

  // ---------- summary scopes: day / week / month / year ----------

  const pad2 = (x) => String(x).padStart(2, '0');

  /** '2026-09-14' | '2026-W37' | '2026-09' | '2026' */
  function periodKeyFor(scope, dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    if (scope === 'day') return dateKey;
    if (scope === 'month') return `${y}-${pad2(m)}`;
    if (scope === 'year') return String(y);
    // ISO week, Monday-based
    const dt = new Date(y, m - 1, d);
    const dayNum = (dt.getDay() + 6) % 7;
    dt.setDate(dt.getDate() - dayNum + 3);
    const firstThursday = new Date(dt.getFullYear(), 0, 4);
    const week = 1 + Math.round(((dt - firstThursday) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
    return `${dt.getFullYear()}-W${pad2(week)}`;
  }

  /** Days in the period containing dateKey (day: just it; week: Mon..Sun). */
  function daysForScope(scope, dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const pad = pad2;
    if (scope === 'day') {
      const day = store.day(dateKey);
      return day ? [day] : [];
    }
    let fromKey, toKey;
    if (scope === 'week') {
      const dt = new Date(y, m - 1, d);
      const dow = (dt.getDay() + 6) % 7;
      dt.setDate(dt.getDate() - dow);
      fromKey = periodKeyFor('day', `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`);
      dt.setDate(dt.getDate() + 6);
      toKey = TimeUtil.dateKey(dt);
    } else if (scope === 'month') {
      fromKey = `${y}-${pad(m)}-01`;
      toKey = TimeUtil.dateKey(new Date(y, m, 0));
    } else if (scope === 'year') {
      fromKey = `${y}-01-01`;
      toKey = `${y}-12-31`;
    } else {
      return [];
    }
    return store.daysRange(fromKey, toKey < TimeUtil.todayKey() ? toKey : TimeUtil.todayKey());
  }

  function reportSelection(scope, date) {
    const selectedScope = ['day', 'week', 'month', 'year'].includes(scope) ? scope : 'day';
    const key = date == null ? TimeUtil.todayKey() : String(date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || TimeUtil.dateKey(new Date(key + 'T00:00:00')) !== key) return null;
    return { scope: selectedScope, date: key, periodKey: periodKeyFor(selectedScope, key) };
  }

  function reportFingerprint(days) {
    // Heartbeats and wall-clock drift must not make an otherwise unchanged
    // request stale while it is awaiting the model. Task/period/config changes do.
    return JSON.stringify({ days: days.map((d) => ({ date: d.date, tasks: d.tasks, breaks: d.breaks, hours: d.hours })), settings: store.settings });
  }

  /** Fire-and-merge AI summary; local report renders immediately regardless. */
  function fireSummary(selection, days, force = false) {
    if (stopped) return;
    const { scope, date, periodKey } = selection;
    const key = `${scope}:${periodKey}`;
    const fingerprint = reportFingerprint(days);
    const current = llmReport.inFlight[key];
    if (!force && current?.fingerprint === fingerprint) return;
    const request = { fingerprint };
    llmReport.inFlight[key] = request;
    const now = Date.now();
    const daysCtx = summaryDays(days, now);
    const workStamp = JSON.stringify(daysCtx.map((d) => [d.date, d.totalActualWorkMinutes, d.overworkMinutes]));
    const idToTitle = {};
    for (const d of daysCtx) for (const t of d.tasks) idToTitle[t.id] = t.title;
    // The shared LLM transport limits days to 31. Pack years into at most
    // twelve month entries, retaining every day's context and task citations.
    const payload = scope === 'year' ? [...new Set(daysCtx.map((d) => d.date.slice(0, 7)))].map((month) => {
      const entries = daysCtx.filter((d) => d.date.startsWith(month));
      return { date: month, totalActualWorkMinutes: entries.reduce((sum, d) => sum + d.totalActualWorkMinutes, 0), days: entries };
    }) : daysCtx;
    const cfg = llmCfg();
    Promise.resolve().then(() => LLM.summarize(cfg, {
      scope,
      days: payload,
      historyReports: historyReports(now, date),
      idToTitle,
    }))
      .then((r) => {
        if (stopped || llmReport.inFlight[key] !== request ||
            fingerprint !== reportFingerprint(daysForScope(scope, date))) return;
        llmReport.cache[key] = { report: r, fingerprint, workStamp };
        store.putSummary(periodKey, {
          at: now, scope, date, periodKey,
          recap: r.headline,
          suggestions: r.issues.map((i) => ({ content: i.text, about: i.about || i.fix || '' })),
        });
        emit('llm:report', { scope, date, periodKey, report: r });
        onDirty();
      })
      .catch((e) => {
        if (stopped || llmReport.inFlight[key] !== request) return;
        emit('llm:status', { ok: false, where: 'report', scope, date, periodKey, error: String(e.message || e).slice(0, 140) });
        onDirty();
      })
      .finally(() => {
        if (llmReport.inFlight[key] === request) delete llmReport.inFlight[key];
        store.flush();
      });
  }

  const actions = {
    'day:get': () => snapshot(),

    'task:add': ({ title }) => {
      const parsed = Recurrence.extract(title);
      if (!parsed.title || parsed.error) return { ok: false, error: 'invalid recurrence' };
      const day = today();
      const est = Estimator.estimate(parsed.title, store.historyBefore(day.date));
      const task = Model.newTask(parsed.title, est.minutes);
      if (parsed.frequency) setFrequency(task, parsed.frequency);
      // Step 1: "I list. I reset the status." — new items land red, on top of nothing.
      logged(day, () => {
        day.tasks.push(task);
        maintainIfAuto(day, Date.now()); // first-in-list flags itself in progress
      });
      touch();
      scheduleEtaRefinement(2500, task.id); // heuristic lands first; the AI estimates ONLY this task
      return { task, estimate: est };
    },

    /**
     * The click. Auto-advance mode: left click = finish (one gesture),
     * white re-queues to red. Manual mode: the classic two-step
     * red → yellow → green.
     */
    'task:click': ({ id }) => {
      const day = today();
      const t = Model.findTask(day, id);
      let r;
      logged(day, () => {
        if (autoMode()) {
          if (!t) r = { event: null };
          else if (t.status === 'green') r = Model.reopenTask(day, id); // click a finished task → back live
          else if (t.status === 'white') r = { changed: Model.requeueTask(day, id).changed, event: 'requeued' };
          else if (t.status === 'yellow') r = Model.finishTask(day, id); // click the current → done
          else {
            // click another task → IT becomes current; a running break ends
            // (the user clearly wants to work); the old current goes on break.
            if (activeBreak(day)) {
              activeBreak(day).end = Date.now();
              emit('break-over', {});
            }
            r = Model.switchTo(day, id);
          }
        } else {
          r = Model.clickTask(day, id);
        }
      });
      touch();
      if (r.event === 'finished') {
        // Spec: after each task is finished, propose a 10-minute break.
        emit('break-propose', { finishedTitle: r.task.title, nextTitle: Model.nextTask(day)?.title ?? null });
      }
      // Reviving, switching and reopening deliberately do NOT re-flag: the
      // user's explicit choice must stand (a re-flag would immediately park
      // the task they just made live). The frontier re-establishes on the
      // next finish/abort/move.
      if (r.event !== 'requeued' && r.event !== 'switched' && r.event !== 'reopened') {
        maintainIfAuto(day, Date.now());
      }
      return { event: r.event };
    },

    'task:skip': ({ id }) => {
      const day = today();
      const r = logged(day, () => {
        const out = Model.skipTask(day, id);
        maintainIfAuto(day, Date.now()); // aborted current → next red flags
        return out;
      });
      touch();
      return { event: r.event };
    },

    'task:delete': ({ id }) => {
      const day = today();
      const r = logged(day, () => {
        const i = day.tasks.findIndex((x) => x.id === id);
        if (i < 0) return { ok: false };
        day.tasks.splice(i, 1);
        return { ok: true };
      });
      touch();
      return r;
    },

    'task:move': ({ id, toIndex }) => {
      const day = today();
      const from = day.tasks.findIndex((x) => x.id === id);
      if (from < 0) return { ok: false };
      const out = logged(day, () => {
        const [moved] = day.tasks.splice(from, 1);
        day.tasks.splice(Math.max(0, Math.min(day.tasks.length, toIndex)), 0, moved);
        maintainIfAuto(day, Date.now()); // the frontier may have moved
        return { ok: true };
      });
      touch();
      return out;
    },

    'task:reopen': ({ id }) => {
      const r = logged(today(), (day) => Model.reopenTask(day, id));
      touch();
      return { event: r.event };
    },

    'task:rename': ({ id, title }) => {
      const t = Model.findTask(today(), id);
      const parsed = Recurrence.extract(title);
      const clean = parsed.title.slice(0, 200);
      if (!t || !clean || parsed.error) return { ok: false };
      t.title = clean;
      if (parsed.frequency) setFrequency(t, parsed.frequency);
      const rule = store.recurring.find((r) => r.id === t.recurringId);
      if (rule) store.updateRecurring(() => { rule.title = clean; });
      touch();
      return { ok: true, title: clean };
    },

    'task:setRecurrence': ({ id, frequency }) => {
      const task = Model.findTask(today(), id);
      if (!task) return { ok: false };
      if (!String(frequency || '').trim()) {
        if (task.recurringId) removeRecurring(task.recurringId);
        return { ok: true };
      }
      const parsed = Recurrence.parse(frequency);
      if (!parsed) return { ok: false, error: 'invalid recurrence' };
      return { ok: true, rule: setFrequency(task, parsed) };
    },

    'recurring:delete': ({ id }) => {
      removeRecurring(id);
      return { ok: true };
    },

    /** The rule's minutes are the duration used by future recurring copies. */
    'recurring:setEstimate': ({ id, minutes }) => {
      const rule = store.recurring.find((r) => r.id === id);
      const value = Number(minutes);
      if (!rule || String(minutes).trim() === '' || !Number.isInteger(value) || value < 1 || value > 480) {
        return { ok: false };
      }
      store.updateRecurring(() => { rule.estimateMin = value; });
      touch();
      return { ok: true, minutes: value };
    },

    'task:setEstimate': ({ id, minutes }) => {
      const t = Model.findTask(today(), id);
      if (t) {
        t.estimateMin = Math.max(1, Math.min(480, Math.round(minutes)));
        t.estEdited = true; // human override wins over any AI refinement
        touch();
      }
      return { ok: !!t };
    },

    'day:resetStatuses': () => {
      const day = today();
      logged(day, () => {
        Model.resetStatuses(day);
        maintainIfAuto(day, Date.now()); // fresh day: first item flags in progress
      });
      touch();
      return { ok: true };
    },

    'day:clear': () => {
      const d = today();
      logged(d, () => {
        d.tasks = [];
        d.breaks = [];
        d.selfEval = null;
        d.etaReviewed = true;
      });
      touch();
      return { ok: true };
    },

    'day:reviewEtas': () => {
      today().etaReviewed = true;
      return { ok: true };
    },

    'break:propose': () => {
      if (activeBreak(today())) return { ok: false, already: true };
      emit('break-propose', { manual: true });
      return { ok: true };
    },

    'break:respond': ({ accept }) => {
      const now = Date.now();
      const day = today();
      if (accept) {
        // Idempotent: a stale toast (or a double-click) must not stack
        // overlapping open breaks — that leaves a zombie the toast adopts.
        if (activeBreak(day)) return { ok: false, already: true };
        day.breaks.push({ start: now, plannedMin: store.settings.breakMinutes, end: null });
        logged(day, () => maintainIfAuto(day, now)); // break active → park current
        emit('break-started', {});
      } else {
        emit('break-skipped', {}); // main hides the toast; renderer resets
        logged(day, () => maintainIfAuto(day, now));
      }
      touch();
      return { ok: true };
    },

    'break:end': () => {
      const now = Date.now();
      const day = today();
      logged(day, () => {
        const brk = activeBreak(day);
        if (brk) brk.end = now;
        maintainIfAuto(day, now);
      });
      emit('break-over', {}); // manual end hides the toast too — no frozen countdown
      touch();
      return { ok: true };
    },

    'eval:respond': ({ response }) => {
      const d = today();
      d.selfEval = d.selfEval || { promptedAt: Date.now() };
      d.selfEval.response = String(response || 'dismissed').slice(0, 24);
      touch();
      return { ok: true };
    },

    'settings:set': (patch) => {
      const allowed = {};
      for (const k of ['workStart', 'workEnd', 'breakMinutes', 'autoAdvance', 'overlayEnabled']) {
        if (patch && k in patch) allowed[k] = patch[k];
      }
      if (patch && 'reflogOpen' in patch) allowed.reflogOpen = !!patch.reflogOpen;
      if (patch && 'overlayStyle' in patch) {
        allowed.overlayStyle = patch.overlayStyle === 'floater' ? 'floater' : 'top';
      }
      if (patch && 'locale' in patch) {
        allowed.locale = ['auto', 'en-us', 'zh-hans', 'zh-hant'].includes(patch.locale) ? patch.locale : 'auto';
      }
      if (patch && 'tintStrength' in patch) {
        const v = Math.round(Number(patch.tintStrength));
        allowed.tintStrength = Number.isFinite(v) ? Math.max(0, Math.min(200, v)) : 100;
      }
      if (patch && typeof patch.backgroundImage === 'string') {
        allowed.backgroundImage = patch.backgroundImage.slice(0, 400);
      }
      if (patch && 'overlayOpacity' in patch) {
        const v = Math.round(Number(patch.overlayOpacity));
        allowed.overlayOpacity = Number.isFinite(v) ? Math.max(20, Math.min(100, v)) : 92;
      }
      if (patch && patch.estimatorMode) {
        allowed.estimatorMode = patch.estimatorMode === 'ai' ? 'ai' : 'smart';
      }
      if (patch && patch.summaryMode) {
        allowed.summaryMode = patch.summaryMode === 'ai' ? 'ai' : 'template';
      }
      if (patch && typeof patch.summaryTemplate === 'string') {
        allowed.summaryTemplate = patch.summaryTemplate.slice(0, 500);
      }
      if (patch && patch.llm && typeof patch.llm === 'object') {
        const cur = store.settings.llm || {};
        const next = {};
        for (const k of ['baseUrl', 'apiKey', 'model']) next[k] = String(patch.llm[k] ?? cur[k] ?? '');
        allowed.llm = next;
      }
      store.setSettings(allowed);
      // Config or mode just landed on "AI estimation" → try a refinement soon.
      if (estimatorUsesAI()) scheduleEtaRefinement(1500);
      return { settings: store.settings };
    },

    /** Manual re-summarize: flush the cached AI summary, regenerate now. */
    'report:regen': ({ scope, date } = {}) => {
      if (store.settings.summaryMode !== 'ai' || !llmCfg()) {
        return { ok: false, reason: 'summarize is not in AI mode' };
      }
      const selection = reportSelection(scope, date);
      if (!selection) return { ok: false, error: 'bad date' };
      delete llmReport.cache[`${selection.scope}:${selection.periodKey}`];
      fireSummary(selection, daysForScope(selection.scope, selection.date), true);
      return { ok: true, ...selection };
    },

    'report:get': ({ scope, date } = {}) => {
      const s = store.settings;
      const selection = reportSelection(scope, date);
      if (!selection) return { error: 'bad date' };
      scope = selection.scope;
      const days = daysForScope(scope, selection.date);
      const local = Advisor.report(days, s);
      Object.assign(local, selection);
      local.day = store.day(selection.date) || Model.newDay(selection.date);
      local.persisted = store.summary(selection.periodKey);
      if (store.settings.summaryMode === 'ai' && llmCfg()) {
        const cached = llmReport.cache[`${scope}:${selection.periodKey}`];
        const workStamp = JSON.stringify(summaryDays(days, Date.now()).map((d) => [d.date, d.totalActualWorkMinutes, d.overworkMinutes]));
        if (cached?.fingerprint === reportFingerprint(days) && cached.workStamp === workStamp) {
          local.llm = cached.report;
        } else {
          fireSummary(selection, days);
        }
      } else {
        // Templated-text mode (default): mustache over documented args.
        local.templated = Template.render(
          store.settings.summaryTemplate || '',
          templateArgs(local.metrics, scope)
        );
      }
      return local;
    },

    'llm:test': async () => {
      if (!llmCfg()) return { ok: false, error: 'set baseUrl + model first' };
      try {
        return await LLM.testConnection(llmCfg());
      } catch (e) {
        return { ok: false, error: String(e.message || e).slice(0, 140) };
      }
    },

    'llm:refineEtas': () => {
      if (!estimatorUsesAI()) {
        return { ok: false, reason: 'estimation is in smart-reading mode' };
      }
      runEtaRefinement(true);
      return { ok: true };
    },

    /**
     * Per-day summaries for the Visualize week/month grids. Week = the
     * current calendar week (Mon..Sun), month = the current calendar month;
     * future days simply have no entry and render grayed out.
     */
    /** One day's raw data for the Day chart, for any date. */
    'viz:day': ({ date }) => {
      const s = store.settings;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { error: 'bad date' };
      const day = store.day(date) || { date, tasks: [], breaks: [] };
      const hours = day.hours || s; // past days keep the hours they lived under
      const bounds = TimeUtil.workBounds(date, hours.workStart, hours.workEnd);
      return { date, day, bounds };
    },

    'viz:days': ({ scope, anchor }) => {
      const s = store.settings;
      // navigation: the grid centers on the anchor's week/month, defaulting to today
      const key =
        anchor && /^\d{4}-\d{2}-\d{2}$/.test(String(anchor)) ? anchor : TimeUtil.todayKey();
      const today = new Date(key + 'T00:00:00');
      const pad = (x) => String(x).padStart(2, '0');
      const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const from = new Date(today);
      if (scope === 'month') {
        from.setDate(1);
      } else {
        const dow = (today.getDay() + 6) % 7; // Monday = 0
        from.setDate(from.getDate() - dow);
      }
      const to = scope === 'month' ? new Date(today.getFullYear(), today.getMonth() + 1, 0) : (() => {
        const sun = new Date(today);
        sun.setDate(sun.getDate() + (6 - ((today.getDay() + 6) % 7)));
        return sun;
      })();
      const now = Date.now();
      const days = store.daysRange(keyOf(from), keyOf(to)).map((d) => {
        const hours = d.hours || s; // past days keep the hours they lived under
        const bounds = TimeUtil.workBounds(d.date, hours.workStart, hours.workEnd);
        // overwork: today runs live to `now`; past days end at their last finish
        // stamp. Either way the day cuts off at its own 24:00 — a finish stamp
        // past midnight or a past anchor day must not accrue overwork beyond it.
        const midnight = new Date(d.date + 'T00:00:00').getTime() + 24 * 60 * TimeUtil.MIN;
        const endRef = Math.min(
          midnight,
          d.date === key ? now : Math.max(bounds.end, ...d.tasks.map((t) => t.finishedAt ?? 0))
        );
        return {
          date: d.date,
          workStart: bounds.start,
          workEnd: bounds.end,
          overworkMin: Math.max(0, Math.round((endRef - bounds.end) / TimeUtil.MIN)),
          breaks: (d.breaks || []).length,
          summary: store.summary(d.date)?.recap || '',
          tasks: (d.tasks || []).map((t) => ({
            title: t.title,
            status: t.status,
            estimateMin: t.estimateMin,
            elapsedMin: Math.round(TimeUtil.taskElapsedMin(t, now)),
            startedAt: t.startedAt,
            finishedAt: t.finishedAt,
            worked: t.worked || [], // the month bubble's mini chart needs the segments
          })),
        };
      });
      const periodSummary = store.summary(periodKeyFor(scope, key))?.recap || '';
      return {
        scope, fromKey: keyOf(from), toKey: keyOf(to),
        anchorKey: key,
        todayKey: TimeUtil.todayKey(),
        periodSummary, days,
      };
    },
  };

  return { snapshot, tick, actions, drain, shutdown };
}

module.exports = { createState };
