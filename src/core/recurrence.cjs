/** Recurring task syntax and local-calendar scheduling, shared with the UI. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Recurrence = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const UNIT_MS = { h: 3600000, m: 60000, s: 1000 };
  const keyOf = (d) => {
    const date = new Date(d);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };

  function parse(value) {
    const text = String(value || '').trim().replace(/^each:\s*/, '');
    if (text === 'day') return { every: 1, unit: 'd' };
    if (text === 'week') return { every: 1, unit: 'w' };
    const match = /^(\d+) ?([wdhms])$/.exec(text);
    if (!match) return null;
    const every = Number(match[1]);
    const unit = match[2];
    const milliseconds = every * (UNIT_MS[unit] || (unit === 'w' ? 7 : 1) * 86400000);
    if (!Number.isSafeInteger(every) || every <= 0 || milliseconds > 8640000000000000) return null;
    return { every, unit };
  }

  /** Strip valid tags from the stored title; the final tag defines the rule. */
  function extract(value) {
    const text = String(value || '');
    let frequency = null;
    const title = text.replace(/(?:^|\s)each:\s*(day|week|\d+ ?[wdhms])(?=$|\s|[,.!?])/g, (tag, interval) => {
      const parsed = parse(interval);
      if (!parsed) return tag;
      frequency = parsed;
      return ' ';
    }).replace(/\s+/g, ' ').trim();
    const hasTag = /(?:^|\s)each:/.test(text);
    return { title, frequency, hasTag, error: /(?:^|\s)each:/.test(title) };
  }

  function format(frequency) {
    return frequency ? `each: ${frequency.every}${frequency.unit}` : '';
  }

  function schedule(frequency, now) {
    if (frequency.unit === 'd' || frequency.unit === 'w') {
      const date = new Date(now);
      date.setDate(date.getDate() + frequency.every * (frequency.unit === 'w' ? 7 : 1));
      return { nextDate: keyOf(date), nextAt: null };
    }
    return { nextDate: null, nextAt: now + frequency.every * UNIT_MS[frequency.unit] };
  }

  /** Consume missed intervals once, without queuing a backlog of copies. */
  function consume(rule, now, dailyLaunch) {
    if (rule.unit === 'd' || rule.unit === 'w') {
      if (!dailyLaunch || keyOf(now) < rule.nextDate) return false;
      Object.assign(rule, schedule(rule, now));
      return true;
    }
    if (now < rule.nextAt) return false;
    const interval = rule.every * UNIT_MS[rule.unit];
    rule.nextAt += (Math.floor((now - rule.nextAt) / interval) + 1) * interval;
    return true;
  }

  return { parse, extract, format, schedule, consume };
});
