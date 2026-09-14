/**
 * store — single-file JSON persistence in the OS user-data dir.
 * Atomic writes (tmp + rename). Main process only.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('fs'), require('path'));
  } else {
    root.Store = factory(null, null);
  }
})(typeof self !== 'undefined' ? self : this, function (fs, path) {
  'use strict';

  const DEFAULTS = {
    version: 1,
    settings: {
      workStart: '09:00',
      workEnd: '17:00',
      breakMinutes: 10,
      autoAdvance: true,
      overlayEnabled: true,
      overlayOpacity: 92, // % — the always-on-top bar's background
      reflogOpen: true, // unfold the plan-tab reflog by default
      backgroundImage: '', // absolute path; rendered cover-fit (scaled, clipped, ratio kept)
      // AI is opt-in per feature, never intrusive:
      estimatorMode: 'smart',   // 'smart' (local keyword+bias reading) | 'ai'
      summaryMode: 'template',  // 'template' (mustache) | 'ai'
      summaryTemplate:
        '{{tasksDone}}/{{tasksTotal}} done · {{actualMin}} worked vs {{plannedMin}} planned · overwork {{overworkMin}} · {{breaks}} breaks',
      llm: { baseUrl: '', apiKey: '', model: '' }, // user-supplied, OpenAI-compatible
    },
    days: {},
  };

  function open(filePath) {
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      data = null; // missing or corrupt → fresh start; never lose the day to a bad parse
    }
    const state = {
      version: data?.version ?? DEFAULTS.version,
      settings: { ...DEFAULTS.settings, ...(data?.settings || {}) },
      days: data?.days || {},
    };

    let writeTimer = null;
    function flush() {
      const tmp = filePath + '.tmp';
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, filePath);
    }

    return {
      get settings() {
        return state.settings;
      },
      setSettings(patch) {
        Object.assign(state.settings, patch || {});
        schedule();
        return state.settings;
      },
      day(dateKey) {
        return state.days[dateKey] || null;
      },
      /** Get-or-create the day, then persist the result of mutate(day). */
      updateDay(dateKey, mutate) {
        const day = state.days[dateKey] || { date: dateKey, tasks: [], breaks: [], selfEval: null, etaReviewed: false };
        state.days[dateKey] = day;
        const out = mutate(day) !== false;
        schedule();
        return out ? day : null;
      },
      /** Days in [fromKey, toKey] inclusive, sorted ascending. */
      daysRange(fromKey, toKey) {
        return Object.values(state.days)
          .filter((d) => d.date >= fromKey && d.date <= toKey)
          .sort((a, b) => (a.date < b.date ? -1 : 1));
      },
      /** Completed tasks before a date — estimator history. */
      historyBefore(dateKey, limit = 60) {
        const all = [];
        for (const key of Object.keys(state.days)) {
          if (key >= dateKey) continue;
          const d = state.days[key];
          for (const t of d.tasks || []) {
            if (t.status === 'green') all.push(t);
          }
        }
        return all.slice(-limit);
      },
      flush,
      _scheduleImmediate: flush,
    };

    function schedule() {
      if (writeTimer) return;
      writeTimer = setTimeout(() => {
        writeTimer = null;
        try {
          flush();
        } catch (e) {
          console.error('[store] flush failed:', e.message);
        }
      }, 150);
      if (writeTimer.unref) writeTimer.unref();
    }
  }

  return { open, DEFAULTS };
});
