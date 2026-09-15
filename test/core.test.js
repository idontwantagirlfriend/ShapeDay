'use strict';
const test = require('node:test');
const assert = require('node:assert');

const TimeUtil = require('../src/core/timeutil.cjs');
const Model = require('../src/core/model.cjs');
const Overwork = require('../src/core/overwork.cjs');
const Estimator = require('../src/core/estimator.cjs');
const Advisor = require('../src/core/advisor.cjs');

const T0 = Date.UTC(2026, 8, 14, 7, 0); // 2026-09-14 07:00Z — but we construct day keys explicitly

function dayFixture() {
  const day = Model.newDay('2026-09-14');
  day.tasks.push(Model.newTask('Reply to launch email', 10));
  day.tasks.push(Model.newTask('Build timeline chart', 60));
  day.tasks.push(Model.newTask('Read spec draft', 20));
  return day;
}

// ---------- timeutil ----------

test('parseHM accepts HH:MM and rejects junk', () => {
  assert.strictEqual(TimeUtil.parseHM('09:00'), 9 * 60);
  assert.strictEqual(TimeUtil.parseHM('17:30'), 17 * 60 + 30);
  assert.strictEqual(TimeUtil.parseHM('24:00'), null);
  assert.strictEqual(TimeUtil.parseHM(''), null);
});

test('workBounds maps a day key + hours to epoch boundaries', () => {
  const b = TimeUtil.workBounds('2026-09-14', '09:00', '17:00');
  assert.strictEqual(new Date(b.start).getHours(), 9);
  assert.strictEqual(new Date(b.end).getHours(), 17);
  assert.strictEqual((b.end - b.start) / 60000, 8 * 60);
});

test('overworkMinutes: zero before end, counts up after', () => {
  const b = TimeUtil.workBounds('2026-09-14', '09:00', '17:00');
  assert.strictEqual(TimeUtil.overworkMinutes(b.end - 1, b), 0);
  assert.strictEqual(TimeUtil.overworkMinutes(b.end + 29 * 60000, b), 29);
  assert.strictEqual(TimeUtil.overworkMinutes(b.end + 121 * 60000, b), 121);
});

// ---------- model: the tactile state machine ----------

test('click advances red → yellow → green with timestamps', () => {
  const day = dayFixture();
  const a = day.tasks[0];
  const r1 = Model.clickTask(day, a.id, T0);
  assert.strictEqual(r1.event, 'started');
  assert.strictEqual(a.status, 'yellow');
  assert.strictEqual(a.startedAt, T0);

  const r2 = Model.clickTask(day, a.id, T0 + 10 * 60000);
  assert.strictEqual(r2.event, 'finished');
  assert.strictEqual(a.status, 'green');
  assert.strictEqual(a.finishedAt, T0 + 10 * 60000);
  assert.strictEqual(TimeUtil.taskElapsedMin(a), 10);
});

test('starting B while A is yellow puts A on break (paused), keeping worked time', () => {
  const day = dayFixture();
  const [a, b] = day.tasks;
  Model.clickTask(day, a.id, T0);
  Model.clickTask(day, b.id, T0 + 15 * 60000);
  assert.strictEqual(a.status, 'paused', 'displaced task goes on break');
  assert.strictEqual(b.status, 'yellow');
  assert.strictEqual(TimeUtil.taskElapsedMin(a), 15);
  // resuming A (paused → yellow) continues accumulation
  Model.clickTask(day, a.id, T0 + 30 * 60000);
  Model.clickTask(day, a.id, T0 + 40 * 60000);
  assert.strictEqual(a.status, 'green');
  assert.strictEqual(TimeUtil.taskElapsedMin(a), 25);
});

test('skipTask whites a task; clicking revives it to red (not in progress)', () => {
  const day = dayFixture();
  const a = day.tasks[0];
  Model.skipTask(day, a.id, T0);
  assert.strictEqual(a.status, 'white');
  assert.strictEqual(a.skippedAt, T0);
  Model.clickTask(day, a.id, T0 + 1);
  assert.strictEqual(a.status, 'red', 'revived → unfinished, not started');
  assert.strictEqual(a.skippedAt, null);
  assert.strictEqual(active_none(day), true);
});
function active_none(day) { return !day.tasks.some((t) => t.status === 'yellow'); }

test('maintainCurrent flags the first red after the last finished one', () => {
  const day = dayFixture();
  // no finished tasks yet → the first item in the list
  let r = Model.maintainCurrent(day, T0);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.task.id, day.tasks[0].id);
  assert.strictEqual(day.tasks[0].status, 'yellow');

  // one-click finish of the current task
  const fin = Model.finishTask(day, day.tasks[0].id, T0 + 10 * 60000);
  assert.strictEqual(fin.event, 'finished');
  assert.strictEqual(day.tasks[0].status, 'green');
  assert.strictEqual(TimeUtil.taskElapsedMin(day.tasks[0]), 10);

  // frontier moves past the finished one
  r = Model.maintainCurrent(day, T0 + 10 * 60000);
  assert.strictEqual(r.task.id, day.tasks[1].id);
});

test('maintainCurrent parks a stale yellow (worked time kept) and skips whites', () => {
  const day = dayFixture();
  const [a, b, c] = day.tasks;
  Model.clickTask(day, b.id, T0); // manual yellow on B, left running
  const r = Model.maintainCurrent(day, T0 + 20 * 60000);
  assert.strictEqual(r.task.id, a.id, 'first-in-list flags');
  assert.strictEqual(b.status, 'paused', 'stale yellow goes on break');
  assert.strictEqual(TimeUtil.taskElapsedMin(b), 20, 'parked time preserved');

  Model.skipTask(day, b.id, T0 + 21 * 60000); // B aborted (white)
  Model.finishTask(day, a.id, T0 + 30 * 60000); // finish current
  const r2 = Model.maintainCurrent(day, T0 + 30 * 60000);
  assert.strictEqual(r2.task.id, c.id, 'white is skipped, next red flags');
});

test('switchTo: clicking a non-current task makes it current, old goes on break', () => {
  const day = dayFixture();
  const [a, b] = day.tasks;
  Model.maintainCurrent(day, T0); // a is current
  const r = Model.switchTo(day, b.id, T0 + 12 * 60000);
  assert.strictEqual(r.event, 'switched');
  assert.strictEqual(b.status, 'yellow', 'clicked one enters progress');
  assert.strictEqual(a.status, 'paused', 'previous current put on break');
  assert.strictEqual(TimeUtil.taskElapsedMin(a, T0 + 12 * 60000), 12, 'time registered up to the switch');
  // exactly one in progress, always
  assert.strictEqual(day.tasks.filter((t) => t.status === 'yellow').length, 1);
  // resuming the paused one displaces the other back — resumable ping-pong
  Model.switchTo(day, a.id, T0 + 20 * 60000);
  assert.strictEqual(a.status, 'yellow');
  assert.strictEqual(b.status, 'paused');
});

test('reopenTask parks the current first — never two in progress', () => {
  const day = dayFixture();
  const [a, b] = day.tasks;
  Model.maintainCurrent(day, T0); // a current
  Model.finishTask(day, a.id, T0 + 5 * 60000); // a green
  Model.maintainCurrent(day, T0 + 5 * 60000); // b current
  const r = Model.reopenTask(day, a.id, T0 + 9 * 60000);
  assert.strictEqual(r.event, 'reopened');
  assert.strictEqual(a.status, 'yellow');
  assert.strictEqual(b.status, 'paused');
  assert.strictEqual(day.tasks.filter((t) => t.status === 'yellow').length, 1);
});

test('finishTask on a never-started task stamps an honest zero-length segment', () => {
  const day = dayFixture();
  const r = Model.finishTask(day, day.tasks[2].id, T0);
  assert.strictEqual(r.event, 'finished');
  const t = day.tasks[2];
  assert.strictEqual(t.status, 'green');
  assert.strictEqual(t.startedAt, T0);
  assert.strictEqual(t.finishedAt, T0);
  assert.strictEqual(TimeUtil.taskElapsedMin(t), 0);
});

test('resetStatuses: titles stay, everything returns red, stamps cleared', () => {
  const day = dayFixture();
  Model.clickTask(day, day.tasks[0].id, T0);
  Model.clickTask(day, day.tasks[0].id, T0 + 5 * 60000);
  Model.resetStatuses(day, T0 + 60 * 60000);
  for (const t of day.tasks) {
    assert.strictEqual(t.status, 'red');
    assert.strictEqual(t.startedAt, null);
    assert.strictEqual(t.finishedAt, null);
    assert.deepStrictEqual(t.worked, []);
  }
  assert.deepStrictEqual(day.breaks, []);
});

test('dayProgress measured in planned units; white excluded', () => {
  const day = dayFixture();
  Model.clickTask(day, day.tasks[0].id, T0);
  Model.clickTask(day, day.tasks[0].id, T0 + 5 * 60000);
  Model.skipTask(day, day.tasks[2].id, T0);
  const p = Model.dayProgress(day);
  assert.strictEqual(p.total, 70); // 10 + 60, white 20 excluded
  assert.strictEqual(p.done, 10);
  assert.ok(Math.abs(p.ratio - 10 / 70) < 1e-9);
});

test('dayProgress is continuous: partial credit for the task under way', () => {
  // her example: five 2h tasks, two done, 1h into the third => 50%, not 40%
  const day = Model.newDay('2026-09-15');
  for (let i = 0; i < 5; i++) day.tasks.push(Model.newTask(`task ${i + 1}`, 120));
  const T = Date.now() - 3 * 3600000;
  for (const t of day.tasks.slice(0, 2)) {
    t.status = 'green';
    t.startedAt = T;
    t.finishedAt = T + 7200000;
    t.worked = [{ start: T, end: T + 7200000 }];
  }
  const third = day.tasks[2];
  third.status = 'yellow';
  third.startedAt = T;
  third.worked = [{ start: T, end: T + 3600000 }]; // 1h worked
  const p = Model.dayProgress(day, T + 3600000);
  assert.strictEqual(p.total, 600);
  assert.strictEqual(p.done, 300); // 240 finished + 60 partial
  assert.ok(Math.abs(p.ratio - 0.5) < 1e-9, `ratio ${p.ratio}`);

  // overrun never inflates: 3h worked on a 120min task still credits 120
  third.worked = [{ start: T, end: T + 3 * 3600000 }];
  const q = Model.dayProgress(day, T + 3 * 3600000);
  assert.strictEqual(q.done, 360);
});

// ---------- overwork: exact spec colors ----------

test('stageColor follows the PROJECT.md tint spec at every boundary', () => {
  assert.strictEqual(Overwork.stageColor(0), '#aed8fc');
  assert.strictEqual(Overwork.stageColor(15), '#aed8fc');
  assert.strictEqual(Overwork.stageColor(29), '#aed8fc');
  assert.strictEqual(Overwork.stageColor(30), '#aed8fc'); // start of shift
  assert.strictEqual(Overwork.stageColor(60), '#db9696'); // fully shifted at 60
  assert.strictEqual(Overwork.stageColor(90), '#ae6a68'); // midway to darkest
  assert.strictEqual(Overwork.stageColor(120), '#803d3a'); // stays darkest
  assert.strictEqual(Overwork.stageColor(300), '#803d3a');
});

test('tintAlpha ramps 0 → ~0.16 and never exceeds it', () => {
  assert.strictEqual(Overwork.tintAlpha(0), 0);
  const a45 = Overwork.tintAlpha(45);
  const a300 = Overwork.tintAlpha(300);
  assert.ok(a45 > 0 && a300 > a45);
  assert.ok(a300 <= 0.161);
});

// ---------- estimator ----------

test('keyword buckets: email short, build long, default sane', () => {
  assert.strictEqual(Estimator.baseEstimate('Reply to launch email'), 10);
  assert.strictEqual(Estimator.baseEstimate('Build timeline chart'), 90);
  assert.ok(Estimator.baseEstimate('Something entirely novel') >= 30);
});

test('biasFactor learned from history; needs 3+ completed tasks', () => {
  const mk = (est, actMin) => ({
    status: 'green',
    estimateMin: est,
    worked: [{ start: 0, end: actMin * 60000 }],
  });
  assert.strictEqual(Estimator.biasFactor([]), 1);
  assert.strictEqual(Estimator.biasFactor([mk(10, 20)]), 1); // <3 → neutral
  assert.strictEqual(Estimator.biasFactor([mk(10, 15), mk(10, 15), mk(10, 15)]), 1.5);
  // clamped to [0.75, 2]
  assert.strictEqual(Estimator.biasFactor([mk(10, 100), mk(10, 100), mk(10, 100)]), 2);
});

test('estimate output bounded and bias-corrected', () => {
  const hist = [1, 2, 3].map(() => ({ status: 'green', estimateMin: 30, worked: [{ start: 0, end: 6000000 }] }));
  const e = Estimator.estimate('Reply to launch email', hist); // base 10, bias 2.0 → 20
  assert.strictEqual(e.minutes, 20);
  assert.ok(e.minutes >= 10 && e.minutes <= 180);
});

// ---------- advisor ----------

function advisorFixture() {
  const s = { workStart: '09:00', workEnd: '17:00' };
  const day = Model.newDay('2026-09-14');
  const end = TimeUtil.workBounds('2026-09-14', '09:00', '17:00').end;
  const mk = (title, est, startOffset, finOffset) => {
    const t = Model.newTask(title, est);
    t.status = 'green';
    t.startedAt = end + startOffset * 60000;
    t.finishedAt = end + finOffset * 60000;
    t.worked = [{ start: t.startedAt, end: t.finishedAt }];
    day.tasks.push(t);
  };
  mk('Build deck', 60, -120, 40); // 160 actual vs 60 est, ends 40 past 17:00
  mk('Write summary', 30, -60, 100); // 160 actual vs 30 est, ends 100 past 17:00
  return { settings: s, days: [day] };
}

test('advisor pinpoints overwork with a one-line issue + fix', () => {
  const { settings, days } = advisorFixture();
  const r = Advisor.report(days, settings);
  assert.ok(r.issues.length >= 1);
  const ow = r.issues.find((i) => i.text.includes('Overworked'));
  assert.ok(ow, 'expected an overwork issue');
  assert.strictEqual(ow.sev, 'high'); // 100 min avg overwork → high
  assert.ok(ow.fix.length > 0);
  assert.ok(r.metrics.overworkMin >= 95);
});

test('advisor estimates bias issue when work runs long', () => {
  const { settings, days } = advisorFixture();
  const r = Advisor.report(days, settings);
  assert.ok(r.metrics.estBias >= 1.5);
  const bias = r.issues.find((i) => i.text.includes('Estimates'));
  assert.ok(bias);
});

test('advisor returns an OK line on a clean, empty history', () => {
  const r = Advisor.report([], { workStart: '09:00', workEnd: '17:00' });
  assert.strictEqual(r.issues.length, 1);
  assert.strictEqual(r.issues[0].sev, 'ok');
});
