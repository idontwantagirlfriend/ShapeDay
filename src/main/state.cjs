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
const Template = require('../core/template.cjs');

function createState(store, hooks = {}) {
  const pending = { events: [] }; // queued events drained each tick/action
  const onDirty = () => hooks.onDirty && hooks.onDirty();

  const etaDebounce = { timer: null, inFlight: false };
  const llmReport = { cache: {}, inFlight: {}, mut: 0, cacheMut: -1 };

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
    if (!autoMode()) return;
    if (activeBreak(day)) {
      // On a break, the current task goes "on break" too (paused) — its
      // worked-time stamps never absorb the break, and it resumes after.
      for (const t of day.tasks || []) {
        if (t.status === 'yellow') {
          const segs = t.worked || (t.worked = []);
          if (segs.length && segs[segs.length - 1].end == null) segs[segs.length - 1].end = now;
          t.status = 'paused';
        }
      }
      return;
    }
    Model.maintainCurrent(day, now);
  }

  /**
   * tick — called ~1 Hz from the main process.
   * Closes finished breaks, fires the 50% self-evaluation prompt once.
   */
  function tick(nowMs) {
    const now = nowMs ?? Date.now();
    const day = today();
    const brk = activeBreak(day);
    if (brk && now >= brk.start + brk.plannedMin * 60000) {
      brk.end = now;
      emit('break-over', {});
      logged(day, () => maintainIfAuto(day, now));
      store.flush();
    }
    if (!day.selfEval) {
      const p = Model.dayProgress(day);
      if (p.total >= 20 && p.ratio >= 0.5) {
        day.selfEval = { promptedAt: now, response: null };
        emit('eval-prompt', { ratio: p.ratio });
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
    return l.baseUrl && l.model ? l : null; // key optional for local endpoints
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
  function scheduleEtaRefinement(delayMs = 2500) {
    if (!estimatorUsesAI()) return;
    clearTimeout(etaDebounce.timer);
    etaDebounce.timer = setTimeout(runEtaRefinement, delayMs);
    if (etaDebounce.timer.unref) etaDebounce.timer.unref();
  }

  async function runEtaRefinement() {
    if (etaDebounce.inFlight || !estimatorUsesAI()) return;
    const day = today();
    const candidates = day.tasks.filter((t) => t.status === 'red' && !t.estEdited);
    if (!candidates.length) return;
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
      let applied = 0;
      for (const u of updates) {
        const t = Model.findTask(day, u.id);
        if (t && t.status === 'red' && !t.estEdited) {
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

  /** Compact task context for the summarizer. */
  function compactTasks(days) {
    const out = [];
    for (const d of days) {
      for (const t of d.tasks || []) {
        out.push({
          title: t.title,
          est: t.estimateMin,
          act: Math.round(TimeUtil.taskElapsedMin(t, Date.now())),
          status: t.status,
        });
      }
    }
    return out;
  }

  /** Fire-and-merge AI summary; local report renders immediately regardless. */
  function fireSummary(scope, days, local) {
    if (llmReport.inFlight[scope]) return;
    llmReport.inFlight[scope] = true;
    LLM.summarize(llmCfg(), {
      scope,
      metrics: local.metrics,
      overworkMin: local.metrics.overworkMin,
      tasks: compactTasks(days),
    })
      .then((r) => {
        llmReport.cache[scope] = r;
        llmReport.cacheMut = llmReport.mut;
        emit('llm:report', { scope, report: r });
        onDirty();
      })
      .catch((e) => {
        emit('llm:status', { ok: false, where: 'report', error: String(e.message || e).slice(0, 140) });
        onDirty();
      })
      .finally(() => {
        llmReport.inFlight[scope] = false;
        store.flush();
      });
  }

  const actions = {
    'day:get': () => snapshot(),

    'task:add': ({ title }) => {
      const day = today();
      const est = Estimator.estimate(title, store.historyBefore(day.date));
      const task = Model.newTask(title, est.minutes);
      // Step 1: "I list. I reset the status." — new items land red, on top of nothing.
      logged(day, () => {
        day.tasks.push(task);
        maintainIfAuto(day, Date.now()); // first-in-list flags itself in progress
      });
      touch();
      scheduleEtaRefinement(); // heuristic lands first, AI refines when you pause
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
          if (!t || t.status === 'green') r = { event: null };
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
      // Reviving and switching deliberately do NOT re-flag: the user's
      // explicit choice must stand (a re-flag would immediately park the
      // task they just switched to). The frontier re-establishes on the
      // next finish/abort/move.
      if (r.event !== 'requeued' && r.event !== 'switched') maintainIfAuto(day, Date.now());
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

    'task:setEstimate': ({ id, minutes }) => {
      const t = Model.findTask(today(), id);
      if (t) {
        t.estimateMin = Math.max(1, Math.min(480, Math.round(minutes)));
        t.estEdited = true; // human override wins over any AI refinement
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

    'report:get': ({ scope }) => {
      const s = store.settings;
      const key = TimeUtil.todayKey();
      let days;
      if (scope === 'week' || scope === '30d') {
        const n = scope === 'week' ? 6 : 29;
        const from = new Date(key + 'T00:00:00');
        from.setDate(from.getDate() - n);
        const pad = (x) => String(x).padStart(2, '0');
        const fromKey = `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())}`;
        days = store.daysRange(fromKey, key);
      } else {
        days = [store.day(key)].filter(Boolean);
      }
      const local = Advisor.report(days, s);
      if (store.settings.summaryMode === 'ai' && llmCfg()) {
        if (llmReport.cache[scope] && llmReport.cacheMut === llmReport.mut) {
          local.llm = llmReport.cache[scope];
        } else {
          fireSummary(scope, days, local);
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
      runEtaRefinement();
      return { ok: true };
    },
  };

  return { snapshot, tick, actions, drain };
}

module.exports = { createState };
