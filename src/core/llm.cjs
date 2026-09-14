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
 * System prompts are editable text files, authoritative in this order:
 *   1. <cfg.promptsDir>/<name>.txt   (user edits, data dir)
 *   2. <cfg.bundledDir>/<name>.txt   (the repo/packaged defaults)
 *   3. a minimal inline contract      (emergency only)
 * They are re-read on every call, so an edit applies on the next request.
 */
const INLINE_PROMPTS = {
  eta: 'Estimate minutes per task. Reply ONLY with JSON: {"tasks":[{"id":"...","minutes":N}]}',
  summary:
    'Reply ONLY with JSON: {"recap":"...","suggestions":[{"content":"...","cite":"task_id"}]}',
  daily_summary:
    'Reply ONLY with JSON: {"recap":"...","suggestions":[{"content":"...","cite":"task_id"}]}',
  weekly_summary:
    'Reply ONLY with JSON: {"recap":"...","suggestions":[{"content":"...","cite":"task_id"}]}',
  monthly_summary:
    'Reply ONLY with JSON: {"recap":"...","suggestions":[{"content":"...","cite":"task_id"}]}',
  yearly_summary:
    'Reply ONLY with JSON: {"recap":"...","suggestions":[{"content":"...","cite":"task_id"}]}',
};

function readPromptFile(dir, name) {
  try {
    const text = fs.readFileSync(path.join(dir, `${name}.txt`), 'utf8');
    if (text.trim()) return text;
  } catch {
    // absent or blank: fall through
  }
  return null;
}

function loadPrompt(cfg, name) {
  return readPromptFile(cfg.promptsDir, name) || readPromptFile(cfg.bundledDir, name) || INLINE_PROMPTS[name];
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
 * Batch-refine ETAs. ctx: {tasks:[{id,title}], history:[{title,est,act}],
 * workHours:"09:00–17:00", bias:1.3} → [{id, minutes}] (validated, clamped
 * to the prompt's contract: whole minutes, minimum 1).
 */
async function refineEtas(cfg, ctx) {
  const user = JSON.stringify({
    workHours: ctx.workHours,
    history: (ctx.history || []).slice(-15),
    planningBias: ctx.bias ?? 1,
    // deliberately no current estimate: anchoring the model on the local
    // guess makes it echo the heuristic instead of judging the task
    tasks: ctx.tasks.map((t) => ({ id: t.id, title: t.title })),
  });
  const reply = await chat(cfg, [
    { role: 'system', content: loadPrompt(cfg, 'eta') },
    { role: 'user', content: user },
  ]);
  const out = extractJson(reply);
  if (!out || !Array.isArray(out.tasks)) throw new Error('LLM eta reply unparseable');
  const byId = new Map(ctx.tasks.map((t) => [t.id, t]));
  const updates = [];
  for (const t of out.tasks) {
    const known = byId.get(String(t.id));
    if (!known) continue;
    const minutes = Math.ceil(Number(t.minutes)); // prompt contract: round up, min 1
    if (!Number.isFinite(minutes)) continue;
    updates.push({ id: known.id, minutes: Math.max(1, Math.min(480, minutes)) });
  }
  return updates;
}

/**
 * Summarize. ctx: {scope, days or months payload, historyReports, idToTitle}
 * → {headline, issues:[{sev,text,about?,fix?}]}. The prompt file is chosen
 * per scope: daily_summary / weekly_summary / monthly_summary / yearly_summary.
 *
 * Reply formats accepted (the prompt files are user-owned):
 *   - {recap, suggestions:[{content, cite}]}   (the current prompt contract)
 *   - {headline, issues:[{sev,text,fix}]}      (older JSON shape)
 *   - prose                                    (rendered as the headline)
 */
const SCOPE_PROMPTS = {
  day: 'daily_summary',
  week: 'weekly_summary',
  month: 'monthly_summary',
  year: 'yearly_summary',
};

async function summarize(cfg, ctx) {
  const promptName = SCOPE_PROMPTS[ctx.scope] || 'daily_summary';
  const systemPrompt = loadPrompt(cfg, promptName).replace(
    '{history_reports}',
    () => (ctx.historyReports && ctx.historyReports.trim() ? ctx.historyReports : 'none yet')
  );
  const user = JSON.stringify({
    scope: ctx.scope,
    days: (ctx.days || []).slice(-31),
  });
  const reply = await chat(cfg, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: user },
  ]);

  const idToTitle = ctx.idToTitle || {};
  const resolveAbout = (cite) => {
    const title = idToTitle[String(cite ?? '')];
    return title ? String(title).slice(0, 80) : '';
  };

  const out = extractJson(reply);
  if (out && typeof out.recap === 'string' && Array.isArray(out.suggestions)) {
    return {
      headline: out.recap.slice(0, 600) || 'Recap.',
      issues: out.suggestions.slice(0, 8).map((sg) => ({
        sev: 'low',
        text: String(sg?.content || '').slice(0, 240),
        about: resolveAbout(sg?.cite),
      })),
    };
  }
  if (out && Array.isArray(out.issues)) {
    const SEV = new Set(['high', 'med', 'low', 'ok']);
    return {
      headline: String(out.headline || '').slice(0, 600),
      issues: out.issues.slice(0, 8).map((i) => ({
        sev: SEV.has(i?.sev) ? i.sev : 'med',
        text: String(i?.text || '').slice(0, 240),
        fix: String(i?.fix || '').slice(0, 240),
      })),
    };
  }
  if (!out) {
    // prose reply from a user-written prompt: render it as the recap
    const prose = String(reply || '').trim();
    if (prose) return { headline: prose.slice(0, 600), issues: [] };
  }
  // valid JSON in an unknown shape: report it rather than dumping raw JSON
  throw new Error('LLM summary reply unparseable');
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
