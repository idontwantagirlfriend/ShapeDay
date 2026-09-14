/**
 * llm — the AI backend. Talks to any OpenAI-compatible chat/completions
 * endpoint (user supplies baseUrl + key + model in settings; nothing is
 * hardcoded, nothing leaves the machine unless configured).
 *
 * Zero-dependency transport: fetch + AbortController timeout, retry with
 * backoff on 429/5xx/network. Runs in the main process only.
 *
 * House style from PROJECT.md still applies to model output:
 * one line per finding, no essays.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 25000;
const MAX_RETRIES = 2;

/**
 * System prompts are editable text files: <promptsDir>/<name>.txt, seeded
 * from the bundled defaults on first run. They are re-read on every call,
 * so an edit applies on the next request without restarting. A missing or
 * blank file falls back to the compiled default.
 */
const DEFAULT_PROMPTS = {
  eta: [
    'You estimate how long tasks take for one person, today.',
    'Reply ONLY with JSON: {"tasks":[{"id":"...","minutes":N}]}',
    'Rules: whole minutes, 5..240. Use the history (actual vs estimated) to correct for this person’s bias.',
    'No prose, no markdown, no extra keys.',
  ].join(' '),
  summary: [
    'You are a work-health reviewer for one person. You get metrics and their tasks with estimates vs actuals.',
    'Pinpoint the REAL issues; do not pad. At most 4. If nothing is wrong, say so.',
    'Reply ONLY with JSON: {"headline":"one short line","issues":[{"sev":"high|med|low|ok","text":"one line","fix":"one line"}]}',
    'Terse. One line each. No essays, no praise padding.',
  ].join(' '),
};

function loadPrompt(promptsDir, name) {
  if (promptsDir) {
    try {
      const text = fs.readFileSync(path.join(promptsDir, `${name}.txt`), 'utf8');
      if (text.trim()) return text;
    } catch {
      // no file yet: the compiled default is the real fallback
    }
  }
  return DEFAULT_PROMPTS[name];
}

/** POST {baseUrl}/chat/completions → assistant message content. Throws on final failure. */
async function chat(cfg, messages, opts = {}) {
  const baseUrl = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !cfg.model) throw new Error('LLM not configured (need baseUrl + model)');
  const url = baseUrl + '/chat/completions';

  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(700 * attempt);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: opts.temperature ?? 0.2,
          messages,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content === 'string') return content;
        throw new Error('malformed chat/completions response');
      }
      // Retry only on rate limit / server errors; 4xx (bad key, bad model) fail fast.
      if (res.status !== 429 && res.status < 500) {
        throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 180)}`);
      }
      lastErr = new Error(`LLM ${res.status}`);
    } catch (e) {
      if (e?.name === 'AbortError') lastErr = new Error('LLM timeout');
      else lastErr = e;
      const fatal = /^LLM 4/.test(e?.message || '');
      if (fatal) throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('LLM unreachable');
}

/** Parse JSON from a model reply: direct parse → first balanced {...} block. */
function extractJson(text) {
  const t = String(text || '').trim();
  try {
    return JSON.parse(t);
  } catch {}
  const stripFence = t.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '');
  const start = stripFence.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < stripFence.length; i++) {
    const c = stripFence[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stripFence.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Batch-refine ETAs. ctx: {tasks:[{id,title,estimateMin}], history:[{title,est,act}],
 * workHours:"09:00–17:00", bias:1.3} → [{id, minutes}] (validated, clamped).
 */
async function refineEtas(cfg, ctx) {
  const user = JSON.stringify({
    workHours: ctx.workHours,
    history: (ctx.history || []).slice(-15),
    planningBias: ctx.bias ?? 1,
    tasks: ctx.tasks.map((t) => ({ id: t.id, title: t.title, currentEstimate: t.estimateMin })),
  });
  const reply = await chat(cfg, [
    { role: 'system', content: loadPrompt(cfg.promptsDir, 'eta') },
    { role: 'user', content: user },
  ]);
  const out = extractJson(reply);
  if (!out || !Array.isArray(out.tasks)) throw new Error('LLM eta reply unparseable');
  const byId = new Map(ctx.tasks.map((t) => [t.id, t]));
  const updates = [];
  for (const t of out.tasks) {
    const known = byId.get(String(t.id));
    const minutes = Math.round(Number(t.minutes));
    if (!known || !Number.isFinite(minutes)) continue;
    updates.push({ id: known.id, minutes: Math.max(5, Math.min(240, minutes)) });
  }
  return updates;
}

/**
 * Summarize. ctx: {scope, metrics, overworkMin, tasks:[{title,est,act,status}]}
 * → {headline, issues:[{sev,text,fix}]} (validated).
 */
async function summarize(cfg, ctx) {
  const user = JSON.stringify({
    scope: ctx.scope,
    overworkMinutes: ctx.overworkMin ?? 0,
    metrics: ctx.metrics,
    tasks: (ctx.tasks || []).slice(0, 60),
  });
  const reply = await chat(cfg, [
    { role: 'system', content: loadPrompt(cfg.promptsDir, 'summary') },
    { role: 'user', content: user },
  ]);
  const out = extractJson(reply);
  if (!out || !Array.isArray(out.issues)) {
    // the prompt file is user-owned: if the model answered in prose instead
    // of JSON, show the prose as the headline rather than failing
    const prose = String(reply || '').trim();
    if (prose) return { headline: prose.slice(0, 200), issues: [] };
    throw new Error('LLM summary reply unparseable');
  }
  const SEV = new Set(['high', 'med', 'low', 'ok']);
  return {
    headline: String(out.headline || '').slice(0, 120),
    issues: out.issues.slice(0, 4).map((i) => ({
      sev: SEV.has(i?.sev) ? i.sev : 'med',
      text: String(i?.text || '').slice(0, 160),
      fix: String(i?.fix || '').slice(0, 160),
    })),
  };
}

/** Tiny round-trip for the settings "Test" button. */
async function testConnection(cfg) {
  const t0 = Date.now();
  const reply = await chat(cfg, [
    { role: 'user', content: 'Reply with exactly: ok' },
  ], { timeoutMs: 12000, temperature: 0 });
  return { ok: /ok/i.test(reply), ms: Date.now() - t0, reply: reply.slice(0, 60) };
}

module.exports = { chat, extractJson, refineEtas, summarize, testConnection };
