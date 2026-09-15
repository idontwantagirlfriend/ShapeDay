/**
 * model — task state machine. Pure functions over a day object.
 *
 * Status vocabulary (PROJECT.md):
 *   red    — unfinished (default; everything starts here)
 *   yellow — in progress (click to start; auto-advance marks the next one)
 *   green  — done
 *   white  — hung / skip this
 *
 * Timestamps are the product's spine: every transition stamps something.
 * A yellow task accumulates `worked` segments [{start,end}] so pausing
 * (starting another task) never loses elapsed time.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Model = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATUSES = ['red', 'yellow', 'green', 'white', 'paused'];

  function newId() {
    return 't_' + Math.random().toString(36).slice(2, 10);
  }

  function newDay(dayKey) {
    return { date: dayKey, tasks: [], breaks: [], selfEval: null, etaReviewed: false };
  }

  function newTask(title, estimateMin) {
    return {
      id: newId(),
      title: String(title || '').trim(),
      status: 'red',
      estimateMin: Math.max(1, Math.round(estimateMin || 30)),
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      skippedAt: null,
      worked: [],
    };
  }

  /** Close the open worked-segment of the yellow task, if any. */
  function closeSegment(task, atMs) {
    if (task.status === 'yellow') {
      const segs = task.worked || (task.worked = []);
      if (segs.length && segs[segs.length - 1].end == null) {
        segs[segs.length - 1].end = atMs;
      }
    }
  }

  function findTask(day, id) {
    return (day.tasks || []).find((t) => t.id === id) || null;
  }

  function activeTask(day) {
    return (day.tasks || []).find((t) => t.status === 'yellow') || null;
  }

  /** Next task eligible for auto-advance (first red, in list order). */
  function nextTask(day) {
    return (day.tasks || []).find((t) => t.status === 'red') || null;
  }

  function dayProgress(day, nowMs) {
    // Continuous progress in planned units: finished tasks count fully, the
    // task under way counts its worked minutes (capped at its estimate, so
    // overrun never inflates progress). Two of five 2h tasks done plus 1h
    // into the third reads 5h/10h = 50%, ticking in real time — not 40%.
    const tasks = day.tasks || [];
    const total = tasks.filter((t) => t.status !== 'white').reduce((s, t) => s + t.estimateMin, 0);
    const now = nowMs ?? Date.now();
    let done = 0;
    for (const t of tasks) {
      if (t.status === 'white') continue;
      if (t.status === 'green') {
        done += t.estimateMin;
        continue;
      }
      let ms = 0;
      for (const seg of t.worked || []) ms += Math.max(0, (seg.end ?? now) - seg.start);
      done += Math.min(ms / 60000, t.estimateMin);
    }
    return { total, done, ratio: total > 0 ? done / total : 0 };
  }

  /**
   * The click: tactile status transition.
   *   red    → click → yellow  (stamp startedAt, open worked segment)
   *   yellow → click → green   (stamp finishedAt; caller handles break + auto-advance)
   *   paused → click → yellow  (resume: the segment clock restarts)
   *   white  → click → red     (revive: back to unfinished, NOT in progress)
   *   green  → click → yellow  (reopen: back live, current parks on break)
   * Starting task B while A is yellow puts A "on break" (paused) with its
   * worked time kept.
   */
  function clickTask(day, id, nowMs) {
    const now = nowMs ?? Date.now();
    const t = findTask(day, id);
    if (!t) return { changed: false, event: null };

    const cur = activeTask(day);
    if (cur && cur.id !== id) {
      // Displaced: the other task goes on break — time kept, clock stopped.
      closeSegment(cur, now);
      cur.status = 'paused';
    }

    if (t.status === 'green') {
      return reopenTask(day, id, now);
    }
    if (t.status === 'red' || t.status === 'paused') {
      t.status = 'yellow';
      t.startedAt = t.startedAt ?? now;
      t.worked.push({ start: now, end: null });
      return { changed: true, event: 'started', task: t };
    }
    if (t.status === 'white') {
      t.status = 'red';
      t.skippedAt = null;
      return { changed: true, event: 'revived', task: t };
    }
    if (t.status === 'yellow') {
      closeSegment(t, now);
      t.status = 'green';
      t.finishedAt = now;
      return { changed: true, event: 'finished', task: t };
    }
    return { changed: false, event: null };
  }

  /** Right-click / alt-click: hung → white. Green → white also allowed. */
  function skipTask(day, id, nowMs) {
    const now = nowMs ?? Date.now();
    const t = findTask(day, id);
    if (!t || t.status === 'white') return { changed: false, event: null };
    closeSegment(t, now);
    t.status = 'white';
    t.skippedAt = now;
    return { changed: true, event: 'skipped', task: t };
  }

  /** Green → yellow: reopen a done task. Any current is put on break first,
   *  so two tasks can never be in progress at once. */
  function reopenTask(day, id, nowMs) {
    const now = nowMs ?? Date.now();
    const t = findTask(day, id);
    if (!t || t.status !== 'green') return { changed: false, event: null };
    const cur = activeTask(day);
    if (cur && cur.id !== id) {
      closeSegment(cur, now);
      cur.status = 'paused';
    }
    t.status = 'yellow';
    t.finishedAt = null;
    t.worked.push({ start: now, end: null });
    return { changed: true, event: 'reopened', task: t };
  }

  /**
   * Auto-advance mode: one click finishes. red|yellow → green, stamped.
   * Finishing a never-started task stamps a zero-length worked segment —
   * "declared done on the spot" is honest in the timeline.
   */
  function finishTask(day, id, nowMs) {
    const now = nowMs ?? Date.now();
    const t = findTask(day, id);
    if (!t || t.status === 'green' || t.status === 'white') return { changed: false, event: null };
    if (t.status === 'red') {
      t.startedAt = t.startedAt ?? now;
      t.worked.push({ start: now, end: now }); // declared done on the spot
    }
    closeSegment(t, now); // paused/yellow: stop the clock where it is
    t.status = 'green';
    t.finishedAt = now;
    return { changed: true, event: 'finished', task: t };
  }

  /** White → red: revive, without starting it (auto mode decides what runs next). */
  function requeueTask(day, id) {
    const t = findTask(day, id);
    if (!t || t.status !== 'white') return { changed: false };
    t.status = 'red';
    t.skippedAt = null;
    return { changed: true, task: t };
  }

  /**
   * Switch the current: click a non-current task → IT enters progress; the
   * previous current is put on break (paused) with its registered time kept,
   * resumable. Only ever one in progress.
   */
  function switchTo(day, id, nowMs) {
    const now = nowMs ?? Date.now();
    const t = findTask(day, id);
    if (!t || t.status === 'green' || t.status === 'white' || t.status === 'yellow') {
      return { changed: false, event: null };
    }
    const cur = activeTask(day);
    if (cur && cur.id !== id) {
      closeSegment(cur, now);
      cur.status = 'paused';
    }
    t.status = 'yellow';
    t.startedAt = t.startedAt ?? now;
    t.worked.push({ start: now, end: null });
    return { changed: true, event: 'switched', task: t };
  }

  /**
   * The frontier rule (auto-advance mode): exactly one task is in progress —
   * the first red or paused one after the LAST finished task, else the first
   * in the list. Displaced in-progress tasks go "on break" (paused, worked
   * time kept); a paused frontier task resumes rather than restarts.
   */
  function maintainCurrent(day, nowMs) {
    const now = nowMs ?? Date.now();
    const tasks = day.tasks || [];
    for (const t of tasks) {
      if (t.status === 'yellow') {
        closeSegment(t, now);
        t.status = 'paused';
      }
    }
    let start = 0;
    for (let i = tasks.length - 1; i >= 0; i--) {
      if (tasks[i].status === 'green') {
        start = i + 1;
        break;
      }
    }
    for (let i = start; i < tasks.length; i++) {
      const t = tasks[i];
      if (t.status === 'red' || t.status === 'paused') {
        t.status = 'yellow';
        t.startedAt = t.startedAt ?? now;
        t.worked.push({ start: now, end: null });
        return { changed: true, task: t };
      }
    }
    return { changed: false };
  }

  /** Step 1: "I list. I reset the status." — keep titles, reset everything to red. */
  function resetStatuses(day, nowMs) {
    const now = nowMs ?? Date.now();
    for (const t of day.tasks || []) {
      t.status = 'red';
      t.startedAt = null;
      t.finishedAt = null;
      t.skippedAt = null;
      t.worked = [];
      t.createdAt = now;
    }
    day.breaks = [];
    day.selfEval = null;
    return day;
  }

  return {
    STATUSES,
    newDay,
    newTask,
    findTask,
    activeTask,
    nextTask,
    dayProgress,
    clickTask,
    finishTask,
    requeueTask,
    switchTo,
    maintainCurrent,
    skipTask,
    reopenTask,
    resetStatuses,
  };
});
