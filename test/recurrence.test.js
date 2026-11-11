'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const Recurrence = require('../src/core/recurrence.cjs');
const Store = require('../src/core/store.cjs');
const TimeUtil = require('../src/core/timeutil.cjs');
const { createState } = require('../src/main/state.cjs');

const UNIT_MS = { h: 3600000, m: 60000, s: 1000 };

for (const interval of ['1h', 'day']) {
  test(`unchanged ${interval} edits retain the original trigger anchor`, (t) => {
    const f = fixture(t);
    f.tick();
    const task = f.add(`Anchored each: ${interval}`);
    const original = clone(f.store.recurring[0]);
    f.setTime(f.now + 47 * 60000);
    f.action('task:setRecurrence', { id: task.id, frequency: interval });
    assert.deepEqual(f.store.recurring[0], original);
    f.action('task:rename', { id: task.id, title: `New title each: ${interval}` });
    assert.equal(f.store.recurring[0].nextAt, original.nextAt);
    assert.equal(f.store.recurring[0].nextDate, original.nextDate);
  });
}
const ANCHOR = '2026-09-14T14:03:27.125';
const clone = (value) => JSON.parse(JSON.stringify(value));

// Top-level tests are intentionally serial: the clock is shared by state/model.
function fixture(t, start = ANCHOR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shapeday-recurrence-'));
  const file = path.join(dir, 'store.json');
  const originalNow = Date.now;
  const originalTodayKey = TimeUtil.todayKey;
  let now = new Date(start).getTime();
  assert.ok(Number.isFinite(now));
  Date.now = () => now;
  TimeUtil.todayKey = () => TimeUtil.dateKey(now);
  let store = Store.open(file);
  store.setSettings({ autoAdvance: false });
  let state = createState(store);
  const sessions = [state];

  t.after(async () => {
    try {
      for (const session of sessions) session.shutdown(now);
      // Store.flush does not cancel its pending 150 ms write. Drain those
      // writes before removing the directory so cleanup cannot recreate it.
      await delay(200);
    } finally {
      Date.now = originalNow;
      TimeUtil.todayKey = originalTodayKey;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  return {
    get now() { return now; },
    get store() { return store; },
    get state() { return state; },
    get day() { return store.day(TimeUtil.todayKey()); },
    setTime(value) {
      now = typeof value === 'number' ? value : new Date(value).getTime();
      assert.ok(Number.isFinite(now));
    },
    tick() { return state.tick(now); },
    action(name, args) { return state.actions[name](args); },
    add(title) {
      const result = state.actions['task:add']({ title });
      assert.ok(result.task, JSON.stringify(result));
      return result.task;
    },
    finish(task) {
      if (task.status === 'red' || task.status === 'paused') {
        state.actions['task:click']({ id: task.id });
      }
      if (task.status === 'yellow') state.actions['task:click']({ id: task.id });
      assert.equal(task.status, 'green');
    },
    reboot() {
      state.shutdown(now);
      store = Store.open(file);
      state = createState(store);
      sessions.push(state);
      return state;
    },
    persisted() {
      store.flush();
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
  };
}

const validFrequencies = [
  ['day', { every: 1, unit: 'd' }],
  ['week', { every: 1, unit: 'w' }],
  ...['w', 'd', 'h', 'm', 's'].flatMap((unit) => [
    [`12${unit}`, { every: 12, unit }],
    [`12 ${unit}`, { every: 12, unit }],
  ]),
];

for (const [input, expected] of validFrequencies) {
  test(`parse accepts ${JSON.stringify(input)} with optional each: prefix`, () => {
    assert.deepEqual(Recurrence.parse(input), expected);
    assert.deepEqual(Recurrence.parse(`each: ${input}`), expected);
    assert.deepEqual(Recurrence.parse(`  each: ${input}  `), expected);
    assert.deepEqual(Recurrence.parse(Recurrence.format(expected)), expected);
  });
}

const invalidFrequencies = [
  '', 'once', 'hour', 'minute', 'second', 'days', 'weeks',
  '1week', '1 day', '2 hours', '2 minutes', '2 seconds',
  '0w', '0d', '0h', '0m', '0s', '-1d', '-2 h', '+1d',
  '1.5d', '0.5h', '1e3s', '1x', '1y', 'd', 'H', 'DAY',
  '1  d', '1\td', '1d extra', '9007199254740992s', '999999999999999w',
];

for (const input of invalidFrequencies) {
  test(`parse rejects ${JSON.stringify(input)}`, () => {
    assert.equal(Recurrence.parse(input), null);
    assert.equal(Recurrence.parse(`each: ${input}`), null);
  });
}

test('extract strips valid tags anywhere in the title and the last tag wins', () => {
  assert.deepEqual(Recurrence.extract('  each: day  Review   notes each: 2 h each: week  '), {
    title: 'Review notes', frequency: { every: 1, unit: 'w' }, hasTag: true, error: false,
  });
  assert.deepEqual(Recurrence.extract('Review each: 3m notes'), {
    title: 'Review notes', frequency: { every: 3, unit: 'm' }, hasTag: true, error: false,
  });
  assert.deepEqual(Recurrence.extract('Review notes'), {
    title: 'Review notes', frequency: null, hasTag: false, error: false,
  });
  assert.deepEqual(Recurrence.extract('each: day'), {
    title: '', frequency: { every: 1, unit: 'd' }, hasTag: true, error: false,
  });
});

test('extract retains invalid tags and reports an error even alongside valid tags', () => {
  // A valid tag followed by more title text is not an invalid extraction.
  for (const input of invalidFrequencies.filter((input) => input !== '1d extra')) {
    const text = `Review each: ${input}`.trim();
    const extracted = Recurrence.extract(text);
    assert.equal(extracted.title, text.replace(/\s+/g, ' '), input);
    assert.equal(extracted.frequency, null, input);
    assert.equal(extracted.hasTag, true, input);
    assert.equal(extracted.error, true, input);
  }
  for (const text of ['Review each: 0d each: week', 'Review each: week each: -1h']) {
    const extracted = Recurrence.extract(text);
    assert.equal(extracted.error, true);
    assert.deepEqual(extracted.frequency, { every: 1, unit: 'w' });
    assert.match(extracted.title, /each:/);
  }
});

test('day/week scheduling uses the local calendar across both DST transitions', () => {
  const script = `
    const assert = require('node:assert/strict');
    const R = require(${JSON.stringify(require.resolve('../src/core/recurrence.cjs'))});
    const cases = [
      ['2026-03-08T00:30:00', '2026-03-09', 'd', 1, 23],
      ['2026-11-01T00:30:00', '2026-11-02', 'd', 1, 25],
      ['2026-03-02T00:30:00', '2026-03-09', 'w', 1, 167],
      ['2026-10-26T00:30:00', '2026-11-02', 'w', 1, 169],
      ['2026-03-07T00:30:00', '2026-03-09', 'd', 2, 47],
    ];
    for (const [start, nextDate, unit, every, hours] of cases) {
      const now = new Date(start).getTime();
      assert.deepEqual(R.schedule({ every, unit }, now), { nextDate, nextAt: null });
      assert.equal((new Date(nextDate + 'T00:30:00').getTime() - now) / 3600000, hours);
    }
    assert.equal(new Date('2026-03-08T00:30:00').getTimezoneOffset(), 300);
    assert.equal(new Date('2026-03-09T00:30:00').getTimezoneOffset(), 240);
    const rule = { every: 1, unit: 'd', nextDate: '2026-03-09', nextAt: null };
    const saved = { ...rule };
    // UTC already says March 9, but New York is still March 8.
    assert.equal(R.consume(rule, Date.parse('2026-03-09T03:59:59Z'), true), false);
    assert.deepEqual(rule, saved);
    assert.equal(R.consume(rule, Date.parse('2026-03-09T04:00:00Z'), false), false);
    assert.deepEqual(rule, saved);
    assert.equal(R.consume(rule, Date.parse('2026-03-09T04:00:00Z'), true), true);
    assert.equal(rule.nextDate, '2026-03-10');
    assert.equal(R.consume(rule, Date.parse('2026-03-20T16:00:00Z'), true), true);
    assert.equal(rule.nextDate, '2026-03-21');
    assert.equal(R.consume(rule, Date.parse('2026-03-20T16:00:00Z'), true), false);
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

for (const [unit, milliseconds] of Object.entries(UNIT_MS)) {
  test(`${unit} schedule is creation-anchored and consume skips missed intervals`, () => {
    const now = new Date(ANCHOR).getTime();
    const interval = 2 * milliseconds;
    const rule = { every: 2, unit, ...Recurrence.schedule({ every: 2, unit }, now) };
    assert.deepEqual(rule, { every: 2, unit, nextDate: null, nextAt: now + interval });
    const before = clone(rule);
    assert.equal(Recurrence.consume(rule, now + interval - 1, false), false);
    assert.deepEqual(rule, before);
    assert.equal(Recurrence.consume(rule, now + interval, false), true);
    assert.equal(rule.nextAt, now + 2 * interval);
    const late = now + 8 * interval + 137;
    assert.equal(Recurrence.consume(rule, late, false), true);
    assert.equal(rule.nextAt, now + 9 * interval);
    assert.equal(Recurrence.consume(rule, late, true), false);
  });

  test(`${unit} state triggers exactly from creation, appends once after a backlog`, async (t) => {
    const f = fixture(t);
    f.tick();
    const task = f.add(`Review each: 2${unit}`);
    const rule = f.store.recurring[0];
    const createdAt = f.now;
    const interval = 2 * milliseconds;
    assert.equal(task.createdAt, createdAt);
    assert.equal(rule.createdAt, createdAt);
    assert.equal(rule.nextAt, createdAt + interval);
    f.finish(task);
    f.tick();
    const completed = clone(task);
    // Auto-advance must not turn a scheduled copy yellow on insertion.
    f.action('settings:set', { autoAdvance: true });
    f.setTime(createdAt + interval - 1);
    f.tick();
    assert.equal(f.day.tasks.length, 1);
    f.setTime(createdAt + interval);
    f.tick();
    assert.equal(f.day.tasks.length, 2);
    assert.deepEqual(f.day.tasks[0], completed);
    const copy = f.day.tasks.at(-1);
    assert.notEqual(copy.id, task.id);
    assert.equal(copy.recurringId, task.recurringId);
    assert.equal(copy.title, 'Review');
    assert.equal(copy.status, 'red');
    assert.equal(copy.createdAt, f.now);
    assert.deepEqual(copy.worked, []);
    assert.equal(copy.estimateMin, task.estimateMin);
    f.action('task:delete', { id: copy.id });
    // Stay within the same local day even for 2h, isolating backlog behavior
    // from day rollover (which has its own coverage below).
    f.setTime(createdAt + 4 * interval + 137);
    f.tick();
    assert.equal(f.day.tasks.length, 2, 'no backlog of copies');
    assert.equal(rule.nextAt, createdAt + 5 * interval);
    f.tick();
    assert.equal(f.day.tasks.length, 2, 'same timestamp cannot trigger twice');
  });
}

test('invalid add/rename/frequency edits are rejected without mutating tasks or rules', async (t) => {
  const f = fixture(t);
  f.tick();
  for (const input of ['0d', '-1h', '1.5m', '1 hour', '1x', '']) {
    assert.equal(f.action('task:add', { title: `Review each: ${input}` }).ok, false);
  }
  assert.equal(f.action('task:add', { title: 'each: day' }).ok, false);
  assert.equal(f.day.tasks.length, 0);
  assert.equal(f.store.recurring.length, 0);
  const task = f.add('Review each: day each: 2 h');
  assert.equal(task.title, 'Review');
  assert.equal(f.store.recurring.length, 1);
  assert.equal(f.store.recurring[0].unit, 'h');
  assert.equal(f.store.recurring[0].every, 2);
  const beforeTask = clone(task);
  const beforeRules = clone(f.store.recurring);
  for (const input of ['0d', '-1h', '1.5m', '1 hour', '1x']) {
    assert.equal(f.action('task:rename', { id: task.id, title: `Changed each: ${input}` }).ok, false);
    assert.equal(f.action('task:setRecurrence', { id: task.id, frequency: input }).ok, false);
    assert.deepEqual(task, beforeTask);
    assert.deepEqual(f.store.recurring, beforeRules);
  }
  const once = f.add('One-off');
  assert.equal(once.recurringId, undefined);
  assert.equal(f.store.recurring.length, 1);
});

for (const status of ['red', 'yellow', 'paused']) {
  test(`${status} instance blocks duplication and consumes the due interval`, async (t) => {
    const f = fixture(t);
    f.tick();
    const task = f.add('Review each: 1s');
    if (status !== 'red') f.action('task:click', { id: task.id });
    if (status === 'paused') {
      const other = f.add('Other work');
      f.action('task:click', { id: other.id });
    }
    assert.equal(task.status, status);
    const before = clone(task);
    const rule = f.store.recurring[0];
    const due = rule.nextAt;
    f.setTime(due);
    f.tick();
    assert.equal(f.day.tasks.filter((x) => x.recurringId === rule.id).length, 1);
    assert.deepEqual(task, before);
    assert.equal(rule.nextAt, due + 1000);
    f.action('task:delete', { id: task.id });
    f.setTime(due + 999);
    f.tick();
    assert.equal(f.day.tasks.filter((x) => x.recurringId === rule.id).length, 0);
    f.setTime(due + 1000);
    f.tick();
    assert.equal(f.day.tasks.filter((x) => x.recurringId === rule.id).length, 1);
    assert.equal(f.day.tasks.at(-1).status, 'red');
  });
}

for (const [frequency, dueDay, nextDay, overdueDay, nextAfterOverdue] of [
  ['day', '2026-09-15', '2026-09-16', '2026-09-20', '2026-09-21'],
  ['week', '2026-09-21', '2026-09-28', '2026-10-12', '2026-10-19'],
]) {
  test(`${frequency} fires only on first local-day startup, not creation/reboot/rollover`, async (t) => {
    const f = fixture(t);
    f.tick();
    const task = f.add(`Review each: ${frequency}`);
    const ruleId = task.recurringId;
    f.finish(task);
    f.tick();
    assert.equal(f.store.recurring[0].nextDate, dueDay);
    assert.equal(f.store.lastDailyLaunch, '2026-09-14');
    f.reboot();
    f.tick();
    assert.equal(f.day.tasks.length, 1, 'no copy on creation-day reboot');
    f.setTime(`${dueDay}T09:15:00`);
    f.tick();
    assert.equal(f.day.tasks.length, 0, 'midnight rollover is not a startup');
    assert.equal(f.store.recurring[0].nextDate, dueDay);
    f.reboot();
    f.tick();
    assert.equal(f.store.lastDailyLaunch, dueDay);
    assert.equal(f.store.recurring[0].nextDate, nextDay);
    assert.equal(f.day.tasks.length, 1);
    assert.equal(f.day.tasks[0].recurringId, ruleId);
    assert.equal(f.day.tasks[0].status, 'red');
    f.action('task:delete', { id: f.day.tasks[0].id });
    f.reboot();
    f.tick();
    assert.equal(f.day.tasks.length, 0, 'deleting a copy cannot retrigger same-day reboot');
    f.setTime(`${overdueDay}T10:00:00`);
    f.reboot();
    f.tick();
    assert.equal(f.day.tasks.length, 1, 'missed days create only one copy');
    assert.equal(f.store.recurring[0].nextDate, nextAfterOverdue);
    f.tick();
    assert.equal(f.day.tasks.length, 1);
  });
}

test('copies have independent titles, shared editable frequency, and independent deletion', async (t) => {
  const f = fixture(t);
  f.tick();
  const first = f.add('Review each: 1s');
  f.finish(first);
  f.setTime(f.store.recurring[0].nextAt);
  f.tick();
  const second = f.day.tasks.at(-1);
  const ruleId = first.recurringId;
  const beforeSecond = clone(second);
  assert.equal(f.action('task:rename', { id: first.id, title: 'Older copy' }).ok, true);
  assert.deepEqual(second, beforeSecond);
  assert.equal(f.action('task:rename', { id: second.id, title: 'Newer copy each: 2 m' }).ok, true);
  assert.equal(first.title, 'Older copy');
  assert.equal(second.title, 'Newer copy');
  assert.equal(first.recurringId, second.recurringId);
  assert.equal(f.store.recurring.length, 1);
  assert.deepEqual([f.store.recurring[0].every, f.store.recurring[0].unit], [2, 'm']);
  assert.equal(f.store.recurring[0].nextAt, f.now + 120000);
  assert.equal(f.action('task:setRecurrence', { id: first.id, frequency: '3h' }).ok, true);
  assert.deepEqual([f.store.recurring[0].every, f.store.recurring[0].unit], [3, 'h']);
  assert.equal(f.state.snapshot().recurring.find((r) => r.id === second.recurringId).every, 3);
  assert.equal(f.store.recurring[0].nextAt, f.now + 10800000);
  const savedSecond = clone(second);
  assert.equal(f.action('task:delete', { id: first.id }).ok, true);
  assert.deepEqual(second, savedSecond);
  assert.equal(f.store.recurring[0].id, ruleId);
  assert.equal(f.action('task:delete', { id: second.id }).ok, true);
  assert.equal(f.store.recurring.length, 1, 'even deleting the last copy leaves the rule alive');
  f.setTime(f.store.recurring[0].nextAt);
  f.tick();
  assert.equal(f.day.tasks.length, 1);
  assert.equal(f.day.tasks[0].recurringId, ruleId);
});

test('task:add captures the first estimate separately for each recurring rule', async (t) => {
  const f = fixture(t);
  f.tick();
  for (const title of [
    'Reply each: day', 'Review each: week', 'Design each: 2h',
    'Build each: 3m', 'Research each: 4s',
  ]) {
    const { task, estimate } = f.action('task:add', { title });
    assert.ok(task);
    const rule = f.store.recurring.find((r) => r.id === task.recurringId);
    assert.ok(rule);
    assert.equal(task.estimateMin, estimate.minutes);
    assert.equal(rule.estimateMin, estimate.minutes);
    assert.equal(rule.title, task.title);
    const beforeRules = clone(f.store.recurring);
    assert.equal(f.action('task:setEstimate', { id: task.id, minutes: estimate.minutes + 7 }).ok, true);
    assert.equal(task.estimateMin, estimate.minutes + 7);
    assert.equal(task.estEdited, true);
    assert.deepEqual(f.store.recurring, beforeRules);
  }
  assert.equal(f.store.recurring.length, 5);
});

for (const convertBy of ['task:setRecurrence', 'task:rename']) {
  for (const frequency of ['day', '2h']) {
    test(`${convertBy} captures an existing task's current estimate for ${frequency}`, async (t) => {
      const f = fixture(t);
      f.tick();
      const task = f.add('Review notes');
      const firstEstimate = task.estimateMin;
      assert.equal(f.action('task:setEstimate', { id: task.id, minutes: 42 }).ok, true);
      assert.notEqual(firstEstimate, task.estimateMin);
      assert.equal(f.store.recurring.length, 0);
      const beforeTask = clone(task);
      f.setTime(f.now + 17000);
      const args = convertBy === 'task:setRecurrence'
        ? { id: task.id, frequency }
        : { id: task.id, title: `Review notes each: ${frequency}` };
      assert.equal(f.action(convertBy, args).ok, true);
      assert.equal(f.store.recurring.length, 1);
      const rule = f.store.recurring[0];
      assert.deepEqual(task, { ...beforeTask, recurringId: rule.id });
      assert.deepEqual(rule, {
        id: task.recurringId, title: 'Review notes', estimateMin: 42, createdAt: f.now,
        ...Recurrence.parse(frequency), ...Recurrence.schedule(Recurrence.parse(frequency), f.now),
      });
      const beforeRule = clone(rule);
      assert.equal(f.action('task:setEstimate', { id: task.id, minutes: 67 }).ok, true);
      assert.equal(task.estimateMin, 67);
      assert.deepEqual(rule, beforeRule);
    });
  }
}

test('recurring:setEstimate accepts integer minutes from 1 through 480 for the selected rule', async (t) => {
  const f = fixture(t);
  f.tick();
  const task = f.add('Review each: 1h');
  f.add('Design each: 2h');
  const beforeTasks = clone(f.day.tasks);
  for (const minutes of [1, 42, 480, '1', '42', '480', ' 73 ']) {
    const expectedRules = clone(f.store.recurring);
    expectedRules[0].estimateMin = Number(minutes);
    assert.deepEqual(f.action('recurring:setEstimate', { id: task.recurringId, minutes }), {
      ok: true, minutes: Number(minutes),
    });
    assert.deepEqual(f.store.recurring, expectedRules);
    assert.deepEqual(f.day.tasks, beforeTasks);
    assert.deepEqual(f.state.snapshot().recurring, expectedRules);
  }
});

test('recurring:setEstimate rejects missing, empty, non-integer, out-of-range and unknown-rule inputs', async (t) => {
  const f = fixture(t);
  f.tick();
  const task = f.add('Review each: 1h');
  f.add('Design each: day');
  const id = task.recurringId;
  const beforeRules = clone(f.store.recurring);
  const beforeTasks = clone(f.day.tasks);
  const invalid = [
    ['missing minutes', { id }],
    ['missing id', { minutes: 42 }],
    ['missing fields', {}],
    ['unknown id', { id: 'missing-rule', minutes: 42 }],
    ['task id', { id: task.id, minutes: 42 }],
    ...[
      ['undefined', undefined], ['null', null], ['empty', ''], ['spaces', '   '],
      ['whitespace', '\t\n'], ['NaN', NaN], ['NaN text', 'NaN'],
      ['infinity', Infinity], ['negative infinity', -Infinity], ['infinity text', 'Infinity'],
      ['zero', 0], ['negative', -1], ['above maximum', 481], ['fraction', 1.5],
      ['fraction above maximum', 480.5], ['zero text', '0'], ['above maximum text', '481'],
      ['fraction text', '1.5'], ['non-numeric text', 'minutes'], ['unit suffix', '42m'],
      ['false', false], ['empty array', []], ['object', {}],
    ].map(([label, minutes]) => [label, { id, minutes }]),
  ];
  for (const [label, args] of invalid) {
    assert.equal(f.action('recurring:setEstimate', args).ok, false, label);
    assert.deepEqual(f.store.recurring, beforeRules, label);
    assert.deepEqual(f.day.tasks, beforeTasks, label);
  }
  assert.equal(f.action('recurring:delete', { id }).ok, true);
  const afterDeletion = clone(f.store.recurring);
  const unlinkedTasks = clone(f.day.tasks);
  assert.equal(f.action('recurring:setEstimate', { id, minutes: 42 }).ok, false);
  assert.deepEqual(f.store.recurring, afterDeletion);
  assert.deepEqual(f.day.tasks, unlinkedTasks);
});

for (const status of ['green', 'red', 'paused', 'yellow']) {
  test(`rule duration edits preserve existing ${status} copies and set future copy minutes`, async (t) => {
    const f = fixture(t);
    f.tick();
    const first = f.add('Review each: 1s');
    f.action('task:click', { id: first.id });
    f.setTime(f.now + 250);
    f.finish(first);
    f.tick();
    f.setTime(f.store.recurring[0].nextAt);
    f.tick();
    const copy = f.day.tasks.at(-1);
    const rule = f.store.recurring[0];
    const initialRule = clone(rule);
    assert.equal(f.action('task:setEstimate', { id: copy.id, minutes: 42 }).ok, true);
    assert.equal(copy.estimateMin, 42);
    assert.deepEqual(rule, initialRule);
    if (status !== 'red') {
      f.action('task:click', { id: copy.id });
      f.setTime(f.now + 250);
      if (status === 'green') {
        f.finish(copy);
        f.tick();
      } else if (status === 'paused') {
        const other = f.add('Other work');
        f.action('task:click', { id: other.id });
      }
    }
    assert.equal(copy.status, status);
    const beforeTasks = clone(f.day.tasks);
    assert.deepEqual(f.action('recurring:setEstimate', { id: rule.id, minutes: 73 }), {
      ok: true, minutes: 73,
    });
    const editedRule = { ...initialRule, estimateMin: 73 };
    assert.deepEqual(rule, editedRule);
    assert.deepEqual(f.day.tasks, beforeTasks, 'all estimates, statuses and work stamps are preserved');
    assert.equal(f.action('task:setEstimate', { id: copy.id, minutes: 91 }).ok, true);
    const editedTasks = beforeTasks.map((task) => task.id === copy.id
      ? { ...task, estimateMin: 91, estEdited: true } : task);
    assert.deepEqual(f.day.tasks, editedTasks);
    assert.deepEqual(rule, editedRule, 'individual copy minutes keep the rule and its trigger anchor intact');
    if (status !== 'green') {
      const due = rule.nextAt;
      f.setTime(due);
      f.tick();
      assert.deepEqual(f.day.tasks, editedTasks, 'unfinished copies continue to block duplication');
      assert.deepEqual(rule, { ...editedRule, nextAt: due + 1000 });
      f.finish(copy);
      f.tick();
    }
    const beforeTrigger = clone(f.day.tasks);
    f.setTime(rule.nextAt);
    f.tick();
    assert.equal(f.day.tasks.length, beforeTrigger.length + 1);
    assert.deepEqual(f.day.tasks.slice(0, -1), beforeTrigger);
    const future = f.day.tasks.at(-1);
    assert.notEqual(future.id, copy.id);
    assert.equal(future.recurringId, rule.id);
    assert.equal(future.estimateMin, 73);
    assert.equal(future.status, 'red');
    assert.equal(future.createdAt, f.now);
    assert.equal(future.startedAt, null);
    assert.equal(future.finishedAt, null);
    assert.equal(future.skippedAt, null);
    assert.deepEqual(future.worked, []);
    assert.equal(future.estEdited, undefined);
  });
}

for (const editBy of ['task:setRecurrence', 'task:rename']) {
  test(`${editBy} frequency edits retain the rule's minutes independently of task estimates`, async (t) => {
    const f = fixture(t);
    f.tick();
    const task = f.add('Review each: 1h');
    assert.equal(f.action('task:setEstimate', { id: task.id, minutes: 42 }).ok, true);
    const rule = f.store.recurring[0];
    assert.equal(f.action('recurring:setEstimate', { id: rule.id, minutes: 73 }).ok, true);
    const beforeTask = clone(task);
    for (const frequency of ['1h', '2m', 'day', 'day']) {
      f.setTime(f.now + 17000);
      const beforeRule = clone(rule);
      const parsed = Recurrence.parse(frequency);
      const unchanged = beforeRule.every === parsed.every && beforeRule.unit === parsed.unit;
      const args = editBy === 'task:setRecurrence'
        ? { id: task.id, frequency }
        : { id: task.id, title: `Review each: ${frequency}` };
      assert.equal(f.action(editBy, args).ok, true);
      assert.deepEqual(task, beforeTask);
      assert.deepEqual(rule, unchanged ? beforeRule : {
        ...beforeRule, ...parsed, ...Recurrence.schedule(parsed, f.now),
      });
      assert.equal(rule.estimateMin, 73);
      assert.equal(f.store.recurring.length, 1);
    }
  });
}

for (const removeBy of ['recurring:delete', 'task:setRecurrence']) {
  test(`${removeBy} removes the rule, unlinks all copies, and stops persisted scheduling`, async (t) => {
    const f = fixture(t);
    f.tick();
    const first = f.add('Review each: 1s');
    f.finish(first);
    f.setTime(f.store.recurring[0].nextAt);
    f.tick();
    const second = f.day.tasks.at(-1);
    const due = f.store.recurring[0].nextAt;
    const before = f.day.tasks.map(clone);
    const result = removeBy === 'recurring:delete'
      ? f.action(removeBy, { id: first.recurringId })
      : f.action(removeBy, { id: second.id, frequency: '' });
    assert.equal(result.ok, true);
    assert.equal(f.store.recurring.length, 0);
    for (const task of before) delete task.recurringId;
    assert.deepEqual(f.day.tasks, before, 'only the recurrence link is removed');
    f.setTime(due + 10000);
    f.tick();
    assert.equal(f.day.tasks.length, 2);
    f.reboot();
    f.tick();
    assert.equal(f.store.recurring.length, 0);
    assert.equal(f.day.tasks.length, 2);
    f.setTime('2026-09-15T14:03:00');
    f.reboot();
    f.tick();
    assert.equal(f.day.tasks.length, 1, 'only the unfinished task is carried, not scheduled');
    assert.equal(f.day.tasks[0].recurringId, undefined);
  });
}

test('rules, launch marker, and precise h/m/s anchor persist across reboot', async (t) => {
  const f = fixture(t);
  f.tick();
  const task = f.add('Review each: 1m');
  f.finish(task);
  f.tick();
  const originalRule = clone(f.store.recurring[0]);
  const persisted = f.persisted();
  assert.deepEqual(persisted.recurring, [originalRule]);
  assert.equal(persisted.lastDailyLaunch, '2026-09-14');
  assert.equal(persisted.days['2026-09-14'].tasks[0].recurringId, originalRule.id);
  f.setTime(originalRule.nextAt - 1);
  f.reboot();
  assert.deepEqual(f.store.recurring, [originalRule]);
  assert.equal(f.store.lastDailyLaunch, '2026-09-14');
  f.tick();
  assert.equal(f.day.tasks.length, 1);
  f.setTime(originalRule.nextAt);
  f.tick();
  assert.equal(f.day.tasks.length, 2);
  assert.equal(f.day.tasks.at(-1).recurringId, originalRule.id);
  assert.equal(f.store.recurring[0].nextAt, originalRule.nextAt + 60000);
  const consumedRule = clone(f.store.recurring[0]);
  f.reboot();
  f.tick();
  assert.deepEqual(f.store.recurring, [consumedRule]);
  assert.equal(f.day.tasks.length, 2, 'reboot cannot consume the same interval twice');
});

for (const frequency of ['1m', 'day', 'week']) {
  test(`${frequency} rule minutes persist separately from task estimates across reboot`, async (t) => {
    const f = fixture(t);
    f.tick();
    const task = f.add(`Review each: ${frequency}`);
    const creationDay = f.day.date;
    const originalRule = clone(f.store.recurring[0]);
    assert.equal(f.action('task:setEstimate', { id: task.id, minutes: 42 }).ok, true);
    assert.deepEqual(f.store.recurring, [originalRule]);
    f.finish(task);
    f.tick();
    const completed = clone(task);
    f.setTime(f.now + 17000);
    assert.equal(f.action('recurring:setEstimate', { id: originalRule.id, minutes: 73 }).ok, true);
    const editedRule = { ...originalRule, estimateMin: 73 };
    assert.deepEqual(task, completed);
    const saved = f.persisted();
    assert.deepEqual(saved.recurring, [editedRule]);
    assert.deepEqual(saved.days[creationDay].tasks, [completed]);
    f.reboot();
    assert.deepEqual(f.store.recurring, [editedRule]);
    assert.deepEqual(f.day.tasks, [completed]);
    f.tick();
    assert.deepEqual(f.store.recurring, [editedRule]);
    assert.deepEqual(f.day.tasks, [completed]);
    f.setTime(editedRule.nextAt ?? new Date(`${editedRule.nextDate}T00:00:00`).getTime());
    if (editedRule.nextDate) f.reboot();
    f.tick();
    const future = f.day.tasks.at(-1);
    assert.notEqual(future.id, task.id);
    assert.equal(future.recurringId, originalRule.id);
    assert.equal(future.estimateMin, 73);
    assert.equal(future.status, 'red');
    assert.deepEqual(future.worked, []);
    assert.equal(future.estEdited, undefined);
    assert.deepEqual(f.store.day(creationDay).tasks[0], completed);
    const afterTrigger = clone(f.day.tasks);
    const consumedRule = clone(f.store.recurring[0]);
    assert.equal(consumedRule.estimateMin, 73);
    f.reboot();
    f.tick();
    assert.deepEqual(f.store.recurring, [consumedRule]);
    assert.deepEqual(f.day.tasks, afterTrigger);
    assert.deepEqual(f.store.day(creationDay).tasks[0], completed);
  });
}

for (const frequency of ['1m', 'day']) {
  test(`${frequency} rule stays editable after deleting its last task, including after reboot`, async (t) => {
    const f = fixture(t);
    f.tick();
    const task = f.add(`Review each: ${frequency}`);
    const originalRule = clone(f.store.recurring[0]);
    assert.equal(f.action('task:setEstimate', { id: task.id, minutes: 42 }).ok, true);
    assert.deepEqual(f.store.recurring, [originalRule]);
    assert.equal(f.action('task:delete', { id: task.id }).ok, true);
    assert.deepEqual(f.day.tasks, []);
    assert.deepEqual(f.store.recurring, [originalRule]);
    f.setTime(f.now + 17000);
    assert.deepEqual(f.action('recurring:setEstimate', { id: originalRule.id, minutes: 73 }), {
      ok: true, minutes: 73,
    });
    assert.deepEqual(f.day.tasks, []);
    assert.deepEqual(f.store.recurring, [{ ...originalRule, estimateMin: 73 }]);
    f.reboot();
    f.tick();
    assert.deepEqual(f.day.tasks, []);
    assert.deepEqual(f.store.recurring, [{ ...originalRule, estimateMin: 73 }]);
    assert.deepEqual(f.action('recurring:setEstimate', { id: originalRule.id, minutes: 480 }), {
      ok: true, minutes: 480,
    });
    const editedRule = { ...originalRule, estimateMin: 480 };
    assert.deepEqual(f.store.recurring, [editedRule]);
    assert.deepEqual(f.day.tasks, []);
    assert.deepEqual(f.persisted().recurring, [editedRule]);
    f.reboot();
    f.tick();
    assert.deepEqual(f.store.recurring, [editedRule]);
    assert.deepEqual(f.day.tasks, []);
    f.setTime(editedRule.nextAt ?? new Date(`${editedRule.nextDate}T00:00:00`).getTime());
    if (editedRule.nextDate) f.reboot();
    f.tick();
    assert.equal(f.day.tasks.length, 1);
    const future = f.day.tasks[0];
    assert.notEqual(future.id, task.id);
    assert.equal(future.recurringId, originalRule.id);
    assert.equal(future.title, originalRule.title);
    assert.equal(future.estimateMin, 480);
    assert.equal(future.status, 'red');
    assert.equal(future.createdAt, f.now);
    assert.deepEqual(future.worked, []);
  });
}

for (const [frequency, reopenAt, nextDate] of [
  ['day', '2026-09-18T09:00:00', '2026-09-19'],
  ['week', '2026-09-28T09:00:00', '2026-10-05'],
  ['1h', '2026-09-18T09:00:00', null],
]) {
  test(`carried red ${frequency} task retains its rule and blocks scheduled duplicates`, async (t) => {
    const f = fixture(t);
    f.tick();
    const source = f.add(`Review each: ${frequency}`);
    const ruleId = source.recurringId;
    const sourceId = source.id;
    const oldRule = clone(f.store.recurring[0]);
    assert.equal(f.action('task:rename', { id: source.id, title: 'Unfinished review' }).ok, true);
    const renamedRule = { ...oldRule, title: 'Unfinished review' };
    assert.equal(f.action('task:setEstimate', { id: source.id, minutes: 42 }).ok, true);
    assert.equal(source.estimateMin, 42);
    assert.deepEqual(f.store.recurring, [renamedRule]);
    f.reboot();
    assert.deepEqual(f.store.recurring, [renamedRule]);
    f.setTime(reopenAt);
    f.reboot();
    f.tick();
    assert.equal(f.day.tasks.length, 1, 'carry happens before recurrence duplication check');
    const carried = f.day.tasks[0];
    assert.notEqual(carried.id, sourceId);
    assert.equal(carried.status, 'red');
    assert.equal(carried.recurringId, ruleId);
    assert.equal(carried.title, 'Unfinished review');
    assert.equal(carried.estimateMin, 42);
    assert.equal(carried.estEdited, true);
    assert.deepEqual(carried.carriedFrom, { date: '2026-09-14', id: sourceId });
    assert.equal(f.store.day('2026-09-14').tasksMigratedTo, TimeUtil.todayKey());
    assert.equal(f.store.day('2026-09-14').tasks[0].status, 'red');
    assert.equal(f.store.recurring.length, 1);
    assert.equal(f.store.recurring[0].estimateMin, oldRule.estimateMin);
    if (nextDate) assert.equal(f.store.recurring[0].nextDate, nextDate);
    else {
      const expected = oldRule.nextAt + (Math.floor((f.now - oldRule.nextAt) / 3600000) + 1) * 3600000;
      assert.equal(f.store.recurring[0].nextAt, expected);
    }
    const beforeReboot = clone(carried);
    f.reboot();
    f.tick();
    f.tick();
    assert.equal(f.day.tasks.length, 1, 'reboot cannot carry or schedule another copy');
    assert.deepEqual(f.day.tasks[0], beforeReboot);
    assert.equal(f.store.recurring[0].id, ruleId);
    assert.equal(f.store.recurring[0].estimateMin, oldRule.estimateMin);
  });
}
