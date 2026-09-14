/**
 * llm-smoke — live test of the real backend module against any
 * OpenAI-compatible chat/completions endpoint.
 *
 *   node scripts/llm-smoke.mjs <baseUrl> <model> [apiKey]
 *   SHAPEDAY_LLM_URL=… SHAPEDAY_LLM_MODEL=… SHAPEDAY_LLM_KEY=… node scripts/llm-smoke.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const LLM = require('../src/core/llm.cjs');

const [baseUrl, model, apiKey] = process.argv.slice(2);
const cfg = {
  baseUrl: baseUrl || process.env.SHAPEDAY_LLM_URL,
  model: model || process.env.SHAPEDAY_LLM_MODEL,
  apiKey: apiKey || process.env.SHAPEDAY_LLM_KEY || '',
};
if (!cfg.baseUrl || !cfg.model) {
  console.error('usage: node scripts/llm-smoke.mjs <baseUrl> <model> [apiKey]');
  process.exit(2);
}

const DAY = {
  tasks: [
    { id: 't1', title: 'Reply to launch email thread', estimateMin: 10 },
    { id: 't2', title: 'Refactor the store layer for atomic writes', estimateMin: 60 },
    { id: 't3', title: 'Deep-dive: research competing day planners', estimateMin: 90 },
  ],
  history: [{ title: 'Build timeline chart', est: 90, act: 67 }],
  workHours: '09:00–17:00',
  bias: 1.3,
};

const METRICS = {
  tasksDone: 2, tasksHung: 1, plannedMin: 200, actualMin: 165,
  estBias: 1.4, overworkDays: 1, overworkMin: 75, breaks: 1, breakMin: 10,
  longestNoBreakMin: 180,
};

const ok = (name) => console.log(`✔ ${name}`);
const fail = (name, e) => (console.log(`✖ ${name} — ${e.message}`), false);

let all = true;

// 1. raw round-trip
try {
  const r = await LLM.testConnection(cfg);
  if (!r.ok) throw new Error(`model said: ${r.reply}`);
  ok(`chat/completions round-trip (${r.ms}ms)`);
} catch (e) { all = fail('round-trip', e); }

// 2. ETA refinement — the "reuse the doings list" flow
try {
  const updates = await LLM.refineEtas(cfg, DAY);
  if (!updates.length) throw new Error('no usable updates returned');
  for (const u of updates) console.log(`   ${u.id} → ${u.minutes} min`);
  ok(`refineEtas (${updates.length}/${DAY.tasks.length} tasks re-estimated)`);
} catch (e) { all = fail('refineEtas', e); }

// 3. summarize — terse issue pinpointing
try {
  const r = await LLM.summarize(cfg, { scope: 'day', metrics: METRICS, overworkMin: 75, tasks: [
    { title: 'Build timeline chart', est: 90, act: 67, status: 'green' },
    { title: 'Write launch email', est: 30, act: 98, status: 'green' },
    { title: 'Refactor store', est: 60, act: 0, status: 'white' },
  ]});
  console.log(`   headline: ${r.headline}`);
  for (const i of r.issues) console.log(`   [${i.sev}] ${i.text} → ${i.fix}`);
  ok(`summarize (${r.issues.length} issue(s), all one-liners: ${r.issues.every(i => i.text.length < 120)})`);
} catch (e) { all = fail('summarize', e); }

console.log(all ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(all ? 0 : 1);
