'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Template = require('../src/core/template.cjs');
const Store = require('../src/core/store.cjs');
const { createState } = require('../src/main/state.cjs');

// ---------- template renderer ----------

test('template renders variables, tolerates inner spacing', () => {
  assert.strictEqual(Template.render('{{tasksDone}}/{{tasksTotal}} done', { tasksDone: 2, tasksTotal: 4 }), '2/4 done');
  assert.strictEqual(Template.render('{{ tasksDone }}!', { tasksDone: 7 }), '7!');
});

test('unknown or missing variables render empty (mustache semantics)', () => {
  assert.strictEqual(Template.render('a {{nope}} b', { x: 1 }), 'a  b');
  assert.strictEqual(Template.render('{{only}}', null), '');
  assert.strictEqual(Template.render('{{nul}}', { nul: null }), '');
});

test('non-string values stringified; non-variable braces untouched', () => {
  assert.strictEqual(Template.render('{{n}}', { n: 42 }), '42');
  assert.strictEqual(Template.render('{ not a tag }', {}), '{ not a tag }');
  assert.strictEqual(Template.render('', { x: 1 }), '');
  assert.strictEqual(Template.render(undefined, { x: 1 }), '');
});

// ---------- mode gating (state, headless) ----------

const fixtureFiles = [];
test.after(async () => {
  // Let the Store's debounced writes settle before removing test data.
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (const file of fixtureFiles) {
    fs.rmSync(file, { force: true });
    fs.rmSync(file + '.tmp', { force: true });
  }
});

function freshState() {
  const file = path.join(os.tmpdir(), `shapeday-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fixtureFiles.push(file);
  const store = Store.open(file);
  return { state: createState(store), store, file };
}

test('defaults: smart reading + templated text — no AI path, templated attached', async () => {
  const { state, store } = freshState();
  state.actions['day:clear']();
  state.actions['task:add']({ title: 'Reply to launch email' });
  // AI configured but modes say smart/template → AI must not run
  state.actions['settings:set']({ llm: { baseUrl: 'http://127.0.0.1:9', model: 'x' } });

  const refine = state.actions['llm:refineEtas']();
  assert.strictEqual(refine.ok, false, 'refine must be refused in smart-reading mode');
  assert.ok(/smart-reading/.test(refine.reason));

  state.actions['task:click']({ id: store.day(state.snapshot().date).tasks[0].id });
  const r = state.actions['report:get']({ scope: 'day' });
  assert.strictEqual(typeof r.templated, 'string', 'templated headline attached');
  assert.ok(r.templated.includes('1/1 done'), r.templated); // one click finishes (auto mode)
  assert.ok(r.templated.includes('overwork'), 'default template mentions overwork');
  assert.strictEqual(r.llm, undefined, 'no AI summary fired');
});

test('custom template round-trips through settings and renders', () => {
  const { state } = freshState();
  state.actions['day:clear']();
  state.actions['settings:set']({ summaryTemplate: 'scope={{scope}} hung={{tasksHung}} bias={{estBias}}' });
  const r = state.actions['report:get']({ scope: 'week' });
  assert.strictEqual(r.templated, 'scope=week hung=0 bias=—'); // empty history → estBias null → em dash
});

test('hung tasks revive on top of the next day, exactly once', () => {
  const Model = require('../src/core/model.cjs');
  const { state, store } = freshState();
  const pad = (x) => String(x).padStart(2, '0');
  const t = new Date();
  const y = new Date(t);
  y.setDate(y.getDate() - 1);
  const yKey = `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`;

  // yesterday: one done, two hung (listed in order)
  store.updateDay(yKey, (d) => {
    d.tasks.push({ ...Model.newTask('Stuck research', 90), status: 'white', skippedAt: 1 });
    d.tasks.push({ ...Model.newTask('Done thing', 30), status: 'green', startedAt: 1, finishedAt: 2, worked: [] });
    d.tasks.push({ ...Model.newTask('Blocked call', 30), status: 'white', skippedAt: 2 });
  });

  // the next tick performs the rollover: hung return as red, on top
  state.tick();
  const after = state.snapshot().day;
  const titles = after.tasks.map((x) => x.title);
  assert.deepStrictEqual(titles.slice(0, 2), ['Stuck research', 'Blocked call'], JSON.stringify(titles));
  assert.ok(after.tasks.slice(0, 2).every((x) => x.status === 'red'), 'revived are red');
  assert.ok(after.tasks.slice(0, 2).every((x) => x.startedAt == null), 'revived carry no stamps');

  // idempotent: another tick adds nothing (yesterday is marked migrated)
  state.tick();
  const again = state.snapshot().day;
  assert.strictEqual(again.tasks.length, 2);
});

test('viz:days cuts every day off at its own 24:00', () => {
  const Model = require('../src/core/model.cjs');
  const { state, store } = freshState();
  const pad = (x) => String(x).padStart(2, '0');
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // anchor the week on yesterday; a second seeded day sits in the same
  // calendar week but is not the anchor (Monday of that week, or Tuesday
  // when yesterday itself is the Monday)
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yKey = keyOf(y);
  const d2 = new Date(y);
  d2.setDate(d2.getDate() - (d2.getDay() + 6) % 7);
  if (keyOf(d2) === yKey) d2.setDate(d2.getDate() + 1);
  const d2Key = keyOf(d2);

  // yesterday (the anchor): work ended 17:00, still open — its overwork
  // must stop at its own midnight, never run live up to `now`
  store.updateDay(yKey, (d) => {
    d.hours = { workStart: '09:00', workEnd: '17:00' };
  });

  // the second day: one task ran until 01:30 the following morning
  const pastMidnight = new Date(d2Key + 'T00:00:00').getTime() + (24 * 60 + 90) * 60000;
  store.updateDay(d2Key, (d) => {
    d.hours = { workStart: '09:00', workEnd: '17:00' };
    d.tasks.push({
      ...Model.newTask('Late sprint', 60),
      status: 'green', startedAt: 1, finishedAt: pastMidnight, worked: [],
    });
  });

  const viz = state.actions['viz:days']({ scope: 'week', anchor: yKey });
  const byDate = new Map(viz.days.map((d) => [d.date, d]));
  assert.strictEqual(byDate.get(yKey)?.overworkMin, 7 * 60, 'anchor day stops at its 24:00');
  assert.strictEqual(byDate.get(d2Key)?.overworkMin, 7 * 60, 'past-midnight finish caps at 24:00');
});

test('ai modes with endpoint flip the guards', () => {
  const { state } = freshState();
  state.actions['settings:set']({ llm: { baseUrl: 'http://127.0.0.1:9', model: 'x' }, estimatorMode: 'ai' });
  const refine = state.actions['llm:refineEtas']();
  assert.strictEqual(refine.ok, true, 'accepted in ai mode (call itself will fail offline, surfaced via event)');
});

test('overlay opacity clamps to 20..100; reflog default toggles', () => {
  const { state } = freshState();
  state.actions['settings:set']({ overlayOpacity: 500 });
  let s = state.snapshot().settings;
  assert.strictEqual(s.overlayOpacity, 100, 'clamped high');
  state.actions['settings:set']({ overlayOpacity: 3 });
  s = state.snapshot().settings;
  assert.strictEqual(s.overlayOpacity, 20, 'clamped low');
  state.actions['settings:set']({ reflogOpen: false });
  assert.strictEqual(state.snapshot().settings.reflogOpen, false);
});

test('reflog records additions, status changes, deletions', () => {
  const { state } = freshState();
  state.actions['day:clear']();
  const { task } = state.actions['task:add']({ title: 'Write tests' });
  state.actions['task:click']({ id: task.id }); // one click: auto-flag + finish
  state.actions['task:delete']({ id: task.id });
  const day = state.snapshot().day;
  const kinds = (day.reflog || []).map((e) => e.kind);
  assert.deepEqual(kinds, ['added', 'status', 'deleted']); // add logs 'added'; flag+finish share the add diff, finish logs 'status'
});

const Model = require('../src/core/model.cjs');
const TimeUtil = require('../src/core/timeutil.cjs');
const Advisor = require('../src/core/advisor.cjs');
const LLM = require('../src/core/llm.cjs');
const settled = () => new Promise((resolve) => setImmediate(resolve));

function fixedClock(t, date = '2026-09-14', time = '12:00:00') {
  let key = date;
  let now = new Date(date + 'T' + time).getTime();
  t.mock.method(TimeUtil, 'todayKey', () => key);
  t.mock.method(Date, 'now', () => now);
  return { get now() { return now; }, set(date, time = '12:00:00') { key = date; now = new Date(date + 'T' + time).getTime(); } };
}

function seed(store, date, title, status = 'red', minutes = 0) {
  const task = Model.newTask(title, 60);
  task.status = status;
  if (minutes) {
    task.startedAt = new Date(date + 'T09:00:00').getTime();
    task.worked = [{ start: task.startedAt, end: task.startedAt + minutes * 60000 }];
    if (status === 'green') task.finishedAt = task.worked[0].end;
  }
  store.updateDay(date, (day) => day.tasks.push(task));
  return task;
}

function fakeSummaries(t) {
  const calls = [];
  t.mock.method(LLM, 'summarize', (cfg, ctx) => new Promise((resolve, reject) => calls.push({ cfg, ctx, resolve, reject })));
  return calls;
}
function enableSummary(state) {
  state.actions['settings:set']({ summaryMode: 'ai', llm: { baseUrl: 'http://example.invalid', model: 'test' } });
}
const recap = (headline) => ({ headline, issues: [] });

test('historical report returns selected details and persisted summary without creating missing days', (t) => {
  fixedClock(t);
  const { state, store } = freshState();
  seed(store, '2026-09-11', 'Friday', 'green', 15);
  seed(store, '2026-09-14', 'Today', 'red');
  store.putSummary('2026-09-11', { recap: 'Friday recap' });
  const r = state.actions['report:get']({ scope: 'day', date: '2026-09-11' });
  assert.strictEqual(r.date, '2026-09-11');
  assert.strictEqual(r.periodKey, '2026-09-11');
  assert.strictEqual(r.day.tasks[0].title, 'Friday');
  assert.strictEqual(r.persisted.recap, 'Friday recap');
  assert.strictEqual(r.metrics.actualMin, 15);
  assert.strictEqual(state.actions['report:get']({ date: '2026-09-10' }).day.tasks.length, 0);
  assert.strictEqual(store.day('2026-09-10'), null);
  assert.strictEqual(state.actions['report:get']({ date: '2026-02-30' }).error, 'bad date');
});

test('selected week/month/year include days after anchor, capped at today', (t) => {
  fixedClock(t, '2026-09-16');
  const { state, store } = freshState();
  for (const date of ['2026-01-01', '2026-09-01', '2026-09-08', '2026-09-13', '2026-09-14', '2026-09-16', '2026-09-17', '2026-12-31']) seed(store, date, date);
  assert.strictEqual(state.actions['report:get']({ scope: 'week', date: '2026-09-08' }).metrics.tasksTotal, 2);
  assert.strictEqual(state.actions['report:get']({ scope: 'week', date: '2026-09-14' }).metrics.tasksTotal, 2);
  assert.strictEqual(state.actions['report:get']({ scope: 'month', date: '2026-09-01' }).metrics.tasksTotal, 5);
  assert.strictEqual(state.actions['report:get']({ scope: 'year', date: '2026-01-01' }).metrics.tasksTotal, 6);
});

test('actual work aggregates every status, only real segments, and clamps negative segments', (t) => {
  const clock = fixedClock(t);
  const { state, store } = freshState();
  for (const status of Model.STATUSES) seed(store, '2026-09-14', status, status, 10);
  seed(store, '2026-09-14', 'Scheduled only', 'green');
  const yellow = store.day('2026-09-14').tasks.find((x) => x.status === 'yellow');
  yellow.worked.push({ start: clock.now - 5 * 60000, end: null }, { start: clock.now, end: clock.now - 60000 });
  assert.strictEqual(Advisor.report([store.day('2026-09-14')], store.settings, clock.now).metrics.actualMin, 55);
  assert.strictEqual(state.actions['report:get']({ scope: 'day' }).metrics.actualMin, 55);
  assert.match(state.actions['report:get']({ scope: 'day' }).templated, /55m worked/);
});

test('graceful shutdown finishes yellow, closes all open segments, leaves red/paused unchanged and does not advance', (t) => {
  const clock = fixedClock(t);
  const { state, store, file } = freshState();
  state.tick();
  const a = state.actions['task:add']({ title: 'Active' }).task;
  const b = seed(store, '2026-09-14', 'Unstarted');
  const paused = seed(store, '2026-09-14', 'Paused', 'paused', 3);
  const end = clock.now + 7 * 60000;
  state.drain();
  state.shutdown(end);
  state.shutdown(end + 60000);
  assert.strictEqual(a.status, 'green');
  assert.strictEqual(a.finishedAt, end);
  assert.strictEqual(a.worked.at(-1).end, end);
  assert.strictEqual(b.status, 'red');
  assert.strictEqual(paused.status, 'paused');
  assert.strictEqual(state.tick(end + 60000).snapshot.active, null);
  assert.ok(!state.drain().some((e) => e.type === 'break-propose'));
  const loaded = Store.open(file);
  assert.strictEqual(loaded.day('2026-09-14').tasks[0].status, 'green');
});

test('rollover closes yellow at local midnight and carries red/white/paused without advancing', (t) => {
  const clock = fixedClock(t, '2026-09-14', '23:50:00');
  const { state, store } = freshState();
  state.tick();
  const a = state.actions['task:add']({ title: 'Late task' }).task;
  seed(store, '2026-09-14', 'Red');
  seed(store, '2026-09-14', 'White', 'white');
  seed(store, '2026-09-14', 'Paused', 'paused', 5);
  clock.set('2026-09-15', '00:05:00');
  const out = state.tick(clock.now);
  assert.strictEqual(a.status, 'green');
  assert.strictEqual(a.worked.at(-1).end, new Date('2026-09-15T00:00:00').getTime());
  assert.deepStrictEqual(out.snapshot.day.tasks.map((x) => [x.title, x.status]), [['Red', 'red'], ['White', 'red'], ['Paused', 'red']]);
  assert.strictEqual(out.snapshot.active, null);
  assert.ok(!out.events.some((e) => e.type === 'break-propose'));
});

test('first tick recovers crash segments at persisted heartbeat, never at restart time', (t) => {
  const clock = fixedClock(t);
  const { store, file } = freshState();
  const task = seed(store, '2026-09-11', 'Crash task', 'yellow', 20);
  task.worked[0].end = null;
  const lastSeenAt = task.startedAt + 20 * 60000;
  store.day('2026-09-11').lastSeenAt = lastSeenAt;
  store.flush();
  const loaded = Store.open(file);
  const state = createState(loaded);
  assert.strictEqual(loaded.day('2026-09-11').tasks[0].status, 'yellow', 'recovery deferred to tick');
  state.tick(clock.now);
  const recovered = loaded.day('2026-09-11').tasks[0];
  assert.strictEqual(recovered.status, 'green');
  assert.strictEqual(recovered.worked[0].end, lastSeenAt);
  assert.strictEqual(TimeUtil.taskElapsedMin(recovered, clock.now), 20);
  assert.strictEqual(state.snapshot().day.tasks.length, 0);
});

test('legacy crash without heartbeat closes conservatively at segment start', (t) => {
  fixedClock(t);
  const { store } = freshState();
  const a = seed(store, '2026-09-11', 'Legacy', 'yellow', 15);
  a.worked[0].end = null;
  const state = createState(store);
  state.tick();
  assert.strictEqual(a.worked[0].end, a.worked[0].start);
  assert.strictEqual(a.status, 'green');
});

test('multiday inheritance picks latest stored earlier day and survives reboot/deletion without duplicates', (t) => {
  fixedClock(t);
  const { state, store, file } = freshState();
  seed(store, '2026-09-10', 'Older red');
  const source = seed(store, '2026-09-11', 'Friday red');
  source.recurringId = 'recurring-friday';
  seed(store, '2026-09-11', 'Friday white', 'white');
  seed(store, '2026-09-11', 'Friday paused', 'paused', 5);
  seed(store, '2026-09-14', 'Monday existing');
  state.tick();
  const day = store.day('2026-09-14');
  assert.deepStrictEqual(day.tasks.map((x) => x.title), ['Friday red', 'Friday white', 'Friday paused', 'Monday existing']);
  assert.strictEqual(day.tasks[0].recurringId, source.recurringId);
  assert.deepStrictEqual(day.tasks[0].worked, []);
  assert.strictEqual(store.day('2026-09-11').tasksMigratedTo, '2026-09-14');
  day.tasks.shift(); // deliberately deleted carried task must not revive again
  store.flush();
  const loaded = Store.open(file);
  createState(loaded).tick();
  assert.strictEqual(loaded.day('2026-09-14').tasks.length, 3);
  assert.ok(!loaded.day('2026-09-14').tasks.some((x) => x.title === 'Friday red'));
});

test('manual break proposes without finishing; accept parks yellow even with auto disabled and stays idempotent', (t) => {
  const clock = fixedClock(t);
  const { state, store } = freshState();
  state.tick();
  state.actions['settings:set']({ autoAdvance: false });
  const a = state.actions['task:add']({ title: 'Manual active' }).task;
  state.actions['task:click']({ id: a.id });
  state.drain();
  assert.strictEqual(state.actions['break:propose']().ok, true);
  assert.deepStrictEqual(state.drain(), [{ type: 'break-propose', data: { manual: true } }]);
  assert.strictEqual(a.status, 'yellow');
  assert.strictEqual(state.actions['break:respond']({ accept: true }).ok, true);
  assert.strictEqual(a.status, 'paused');
  assert.strictEqual(a.worked.at(-1).end, clock.now);
  assert.strictEqual(state.actions['break:propose']().already, true);
  assert.strictEqual(state.actions['break:respond']({ accept: true }).already, true);
  assert.strictEqual(store.day('2026-09-14').breaks.length, 1);
  state.actions['break:end']();
  assert.strictEqual(a.status, 'yellow', 'manual mode resumes the task that was actually paused for this break');
  assert.strictEqual(a.worked.at(-1).start, clock.now);
  assert.strictEqual(a.worked.at(-1).end, null);
  state.actions['break:respond']({ accept: false });
  assert.ok(state.drain().some((e) => e.type === 'break-skipped'));
});

test('existing auto-advance and break resume semantics remain unchanged', (t) => {
  fixedClock(t);
  const { state } = freshState();
  state.tick();
  const a = state.actions['task:add']({ title: 'First' }).task;
  const b = state.actions['task:add']({ title: 'Next' }).task;
  state.actions['task:click']({ id: a.id });
  assert.strictEqual(a.status, 'green');
  assert.strictEqual(b.status, 'yellow');
  state.actions['break:respond']({ accept: true });
  assert.strictEqual(b.status, 'paused');
  state.actions['break:end']();
  assert.strictEqual(b.status, 'yellow');
});

test('AI historical requests cache and emit by date/period, history relative to selected day', async (t) => {
  fixedClock(t);
  const calls = fakeSummaries(t);
  const { state, store } = freshState();
  seed(store, '2026-09-10', 'Prior', 'green', 10);
  seed(store, '2026-09-11', 'Friday', 'paused', 20);
  seed(store, '2026-09-12', 'Saturday', 'white', 30);
  store.day('2026-09-11').hours = { workStart: '08:00', workEnd: '16:00' };
  store.putSummary('2026-09-10', { recap: 'Prior recap' });
  enableSummary(state);
  state.actions['report:get']({ scope: 'day', date: '2026-09-11' });
  state.actions['report:get']({ scope: 'day', date: '2026-09-12' });
  await settled();
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].ctx.days[0].totalActualWorkMinutes, 20);
  assert.strictEqual(calls[0].ctx.days[0].scheduledWorkHours, '08:00-16:00');
  assert.match(calls[0].ctx.historyReports, /Prior recap/);
  calls[1].resolve(recap('Saturday recap'));
  calls[0].resolve(recap('Friday recap'));
  await settled();
  assert.strictEqual(store.summary('2026-09-11').recap, 'Friday recap');
  assert.strictEqual(store.summary('2026-09-12').recap, 'Saturday recap');
  assert.strictEqual(store.summary('2026-09-14'), null);
  assert.strictEqual(state.actions['report:get']({ scope: 'day', date: '2026-09-11' }).llm.headline, 'Friday recap');
  assert.deepStrictEqual(state.drain().filter((e) => e.type === 'llm:report').map((e) => e.data.periodKey).sort(), ['2026-09-11', '2026-09-12']);
  assert.strictEqual(calls.length, 2);
});

test('AI requests in same period dedupe; regeneration supersedes older completion', async (t) => {
  fixedClock(t);
  const calls = fakeSummaries(t);
  const { state, store } = freshState();
  seed(store, '2026-09-08', 'Tuesday', 'green', 10);
  seed(store, '2026-09-13', 'Sunday', 'green', 10);
  enableSummary(state);
  state.actions['report:get']({ scope: 'week', date: '2026-09-08' });
  state.actions['report:get']({ scope: 'week', date: '2026-09-13' });
  await settled();
  assert.strictEqual(calls.length, 1);
  const regen = state.actions['report:regen']({ scope: 'week', date: '2026-09-13' });
  assert.strictEqual(regen.periodKey, '2026-W37');
  await settled();
  calls[1].resolve(recap('Fresh'));
  await settled();
  calls[0].resolve(recap('Obsolete'));
  await settled();
  assert.strictEqual(store.summary('2026-W37').recap, 'Fresh');
  assert.strictEqual(state.actions['report:get']({ scope: 'week', date: '2026-09-08' }).llm.headline, 'Fresh');
  assert.strictEqual(state.drain().filter((e) => e.type === 'llm:report').length, 1);
});

test('AI stale mutation/config results are not persisted or marked fresh; unrelated date cache survives', async (t) => {
  fixedClock(t);
  const calls = fakeSummaries(t);
  const { state, store } = freshState();
  const task = seed(store, '2026-09-11', 'Friday');
  seed(store, '2026-09-12', 'Saturday');
  enableSummary(state);
  state.actions['report:get']({ date: '2026-09-11' });
  state.actions['report:get']({ date: '2026-09-12' });
  await settled();
  calls[1].resolve(recap('Saturday cached'));
  task.title = 'Changed while in flight';
  calls[0].resolve(recap('Stale Friday'));
  await settled();
  assert.strictEqual(store.summary('2026-09-11'), null);
  assert.strictEqual(state.actions['report:get']({ date: '2026-09-12' }).llm.headline, 'Saturday cached');
  state.actions['report:get']({ date: '2026-09-11' });
  await settled();
  state.actions['settings:set']({ llm: { model: 'new-model' } });
  calls[2].resolve(recap('Stale config'));
  await settled();
  assert.strictEqual(store.summary('2026-09-11'), null);
});

test('AI error events identify historical request, and shutdown suppresses late completion', async (t) => {
  fixedClock(t);
  const calls = fakeSummaries(t);
  const { state, store } = freshState();
  enableSummary(state);
  state.actions['report:regen']({ date: '2026-09-11' });
  await settled();
  calls[0].reject(new Error('offline'));
  await settled();
  const error = state.drain().find((e) => e.type === 'llm:status');
  assert.strictEqual(error.data.date, '2026-09-11');
  assert.strictEqual(error.data.periodKey, '2026-09-11');
  state.actions['report:regen']({ date: '2026-09-11' });
  await settled();
  state.shutdown();
  calls[1].resolve(recap('Late'));
  await settled();
  assert.strictEqual(store.summary('2026-09-11'), null);
});

test('year AI context keeps all days despite shared 31-entry transport limit', async (t) => {
  fixedClock(t);
  const calls = fakeSummaries(t);
  const { state, store } = freshState();
  for (let i = 1; i <= 40; i++) {
    const date = TimeUtil.dateKey(new Date(2026, 0, i));
    seed(store, date, date, 'green', 1);
  }
  enableSummary(state);
  state.actions['report:get']({ scope: 'year', date: '2026-01-01' });
  await settled();
  assert.ok(calls[0].ctx.days.length <= 12);
  assert.strictEqual(calls[0].ctx.days.flatMap((m) => m.days).length, 40);
  assert.strictEqual(calls[0].ctx.days.reduce((sum, m) => sum + m.totalActualWorkMinutes, 0), 40);
  calls[0].resolve(recap('Year'));
  await settled();
  assert.strictEqual(store.summary('2026').recap, 'Year');
});

test('same-day crash recovery uses optional Store heartbeat and does not start next red', (t) => {
  const clock = fixedClock(t);
  const { store } = freshState();
  const a = seed(store, '2026-09-14', 'Same-day crash', 'yellow', 10);
  a.worked[0].end = null;
  seed(store, '2026-09-14', 'Next red');
  store.lastSeenAt = a.startedAt + 10 * 60000;
  const state = createState(store);
  state.tick(clock.now);
  assert.strictEqual(a.status, 'green');
  assert.strictEqual(a.worked[0].end, store.lastSeenAt);
  assert.strictEqual(state.snapshot().active, null);
  assert.strictEqual(store.day('2026-09-14').lastSeenAt, clock.now);
});

test('red inheritance chains across later rollovers and legacy white marker does not swallow red', (t) => {
  const clock = fixedClock(t);
  const { state, store } = freshState();
  seed(store, '2026-09-11', 'Old red');
  seed(store, '2026-09-11', 'Already migrated white', 'white');
  store.day('2026-09-11').whitesMigrated = true;
  state.tick();
  assert.deepStrictEqual(state.snapshot().day.tasks.map((x) => x.title), ['Old red']);
  clock.set('2026-09-17');
  state.tick();
  assert.deepStrictEqual(state.snapshot().day.tasks.map((x) => [x.title, x.status]), [['Old red', 'red']]);
  assert.strictEqual(store.day('2026-09-14').tasksMigratedTo, '2026-09-17');
});

test('longest work stretch uses real segments, not scheduled start or idle gaps', (t) => {
  fixedClock(t);
  const { store } = freshState();
  const a = seed(store, '2026-09-14', 'Short late work', 'green');
  const base = new Date('2026-09-14T16:00:00').getTime();
  a.startedAt = base;
  a.finishedAt = base + 20 * 60000;
  a.worked = [{ start: base, end: a.finishedAt }];
  let report = Advisor.report([store.day('2026-09-14')], store.settings);
  assert.strictEqual(report.metrics.longestNoBreakMin, 20);
  a.worked.push({ start: base + 30 * 60000, end: base + 50 * 60000 });
  report = Advisor.report([store.day('2026-09-14')], store.settings);
  assert.strictEqual(report.metrics.actualMin, 40);
  assert.strictEqual(report.metrics.longestNoBreakMin, 20);
});

test('AI live-work cache refreshes with elapsed work but heartbeat does not supersede pending request', async (t) => {
  const clock = fixedClock(t);
  const calls = fakeSummaries(t);
  const { state } = freshState();
  state.tick();
  state.actions['task:add']({ title: 'Live task' });
  enableSummary(state);
  state.actions['report:get']();
  await settled();
  clock.set('2026-09-14', '12:01:00');
  state.tick(clock.now);
  state.actions['report:get']();
  await settled();
  assert.strictEqual(calls.length, 1, 'heartbeat keeps request identity stable');
  calls[0].resolve(recap('At request time'));
  await settled();
  assert.strictEqual(state.actions['report:get']().llm, undefined, 'old live duration is not a fresh cache');
  await settled();
  assert.strictEqual(calls.length, 2);
  calls[1].resolve(recap('Updated live work'));
  await settled();
  assert.strictEqual(state.actions['report:get']().llm.headline, 'Updated live work');
});

test('all summary prompts explicitly distinguish recorded work from scheduled hours', () => {
  for (const scope of ['daily', 'weekly', 'monthly', 'yearly']) {
    const prompt = fs.readFileSync(path.join(__dirname, '..', 'prompts', scope + '_summary.txt'), 'utf8');
    assert.match(prompt, /totalActualWorkMinutes/);
    assert.match(prompt, /scheduledWorkHours/);
    assert.match(prompt, /NOT hours actually worked/);
    assert.match(prompt, /offline time/);
  }
});
