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

function freshState() {
  const file = path.join(os.tmpdir(), `shapeday-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
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
