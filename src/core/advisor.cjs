/**
 * advisor — the summarize "AI". Pinpoints issues from task content and
 * execution progress, then suggests fixes from productive-work principles.
 *
 * House rule from PROJECT.md: "It's not intelligent. It's verbose."
 * Every finding is one line. No essays.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./timeutil.cjs'));
  } else {
    root.Advisor = factory(root.TimeUtil);
  }
})(typeof self !== 'undefined' ? self : this, function (TimeUtil) {
  'use strict';

  const MIN = 60000;

  function fmtHM(min) {
    const h = Math.floor(min / 60);
    return h > 0 ? `${h}h ${min % 60}m` : `${Math.round(min)}m`;
  }

  /** Flatten completed tasks across days with per-day overwork minutes. */
  function scan(days, settings) {
    const out = {
      nDays: 0,
      done: 0,
      skipped: 0,
      taskTotal: 0,
      plannedMin: 0,
      actualMin: 0,
      estPairs: [], // {title, est, act}
      overworkDays: 0,
      overworkMin: 0,
      breaks: 0,
      breakMin: 0,
      longestNoBreak: 0,
    };
    for (const day of days || []) {
      if (!day || !day.tasks || day.tasks.length === 0) continue;
      out.nDays++;
      const bounds = TimeUtil
        ? TimeUtil.workBounds(day.date, settings.workStart, settings.workEnd)
        : null;
      let lastEnd = bounds ? bounds.start : null;
      let dayNoBreak = 0;
      for (const t of day.tasks) {
        out.plannedMin += t.estimateMin;
        const act = (t.worked || []).reduce((s, seg) => s + ((seg.end ?? Date.now()) - seg.start), 0) / MIN;
        if (t.status === 'green') {
          out.done++;
          out.actualMin += act;
          if (t.finishedAt && t.startedAt) out.estPairs.push({ title: t.title, est: t.estimateMin, act });
        }
        if (t.status === 'white') out.skipped++;
        out.taskTotal++;
        const f = t.finishedAt;
        if (f && lastEnd != null) {
          dayNoBreak = Math.max(dayNoBreak, (f - lastEnd) / MIN);
          lastEnd = f;
        }
      }
      out.longestNoBreak = Math.max(out.longestNoBreak, dayNoBreak);
      for (const b of day.breaks || []) {
        out.breaks++;
        out.breakMin += ((b.end ?? b.start + (b.plannedMin || 10) * MIN) - b.start) / MIN;
      }
      if (bounds) {
        const last = Math.max(bounds.end, ...day.tasks.map((t) => t.finishedAt ?? 0));
        const ow = Math.max(0, (last - bounds.end) / MIN);
        if (ow > 5) {
          out.overworkDays++;
          out.overworkMin += ow;
        }
      }
    }
    return out;
  }

  /** Median estimation error: actual/estimate. >1 means work runs long. */
  function estBias(s) {
    const ratios = s.estPairs.filter((p) => p.est > 0).map((p) => p.act / p.est);
    if (ratios.length < 2) return null;
    ratios.sort((a, b) => a - b);
    return ratios[Math.floor(ratios.length / 2)];
  }

  /**
   * days: array of day objects (already scoped: [today] / week / 30d).
   * Returns {metrics, issues: [{sev, text, fix}]} — one line each.
   */
  function report(days, settings) {
    const s = scan(days, settings);
    const issues = [];

    if (s.overworkDays > 0) {
      const avg = Math.round(s.overworkMin / s.overworkDays);
      issues.push({
        sev: avg >= 60 ? 'high' : 'med',
        text: `Overworked ${fmtHM(avg)} past ${settings.workEnd} on ${s.overworkDays} of ${s.nDays} day(s).`,
        fix: 'End-of-day scope cut: move the last task to tomorrow at the boundary.',
      });
    }
    const bias = estBias(s);
    if (bias != null && (bias > 1.25 || bias < 0.7)) {
      const dir = bias > 1 ? `run ${Math.round((bias - 1) * 100)}% long` : `finish ${Math.round((1 - bias) * 100)}% early`;
      issues.push({
        sev: 'med',
        text: `Estimates ${dir} (median of ${s.estPairs.length} tasks).`,
        fix: bias > 1 ? 'Apply a ×' + bias.toFixed(1) + ' planning buffer when you review ETAs.' : 'Plan more per day — you have slack.',
      });
    }
    if (s.longestNoBreak > 110) {
      issues.push({
        sev: 'med',
        text: `Longest no-break stretch: ${fmtHM(s.longestNoBreak)}.`,
        fix: 'Take the 10-minute break. Breaks are productive, not a tax.',
      });
    }
    if (s.skipped >= 3) {
      issues.push({
        sev: 'low',
        text: `${s.skipped} task(s) hung (white).`,
        fix: 'Hung tasks are scope lying about itself — shrink or drop them at tomorrow’s plan.',
      });
    }
    if (s.done > 0 && s.breaks === 0 && s.actualMin > 240) {
      issues.push({
        sev: 'med',
        text: `No breaks across ${fmtHM(s.actualMin)} of completed work.`,
        fix: 'Accept the post-task break proposal at least every ~90 minutes.',
      });
    }
    if (issues.length === 0) {
      issues.push({ sev: 'ok', text: 'No issues pinpointed.', fix: 'Keep the shape.' });
    }

    return {
      metrics: {
        daysTracked: s.nDays,
        tasksDone: s.done,
        tasksTotal: s.taskTotal,
        tasksHung: s.skipped,
        plannedMin: Math.round(s.plannedMin),
        actualMin: Math.round(s.actualMin),
        estBias: bias == null ? null : +bias.toFixed(2),
        overworkDays: s.overworkDays,
        overworkMin: Math.round(s.overworkMin),
        breaks: s.breaks,
        breakMin: Math.round(s.breakMin),
        longestNoBreakMin: Math.round(s.longestNoBreak),
      },
      issues,
    };
  }

  return { report, scan, estBias };
});
