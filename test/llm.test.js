'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const LLM = require('../src/core/llm.cjs');

/** Spin a mock chat/completions server. Handler receives {body, headers} and returns {status, content}. */
function mockServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let buf = '';
      req.on('data', (c) => (buf += c));
      req.on('end', () => {
        const out = handler({
          url: req.url,
          headers: req.headers,
          body: JSON.parse(buf || '{}'),
          hits: (mockServer._hits = (mockServer._hits || 0) + 1),
        });
        const payload = JSON.stringify({
          choices: [{ message: { role: 'assistant', content: out.content ?? '' } }],
        });
        res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
        res.end(payload);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/v1` }));
  });
}

const CFG = { baseUrl: '', apiKey: 'test-key', model: 'test-model' };

test.afterEach(() => {});

test('chat posts to {baseUrl}/chat/completions with auth + model + messages', async () => {
  let seen = null;
  const { srv, url } = await mockServer((r) => {
    seen = r;
    return { content: 'pong' };
  });
  try {
    const out = await LLM.chat({ ...CFG, baseUrl: url }, [{ role: 'user', content: 'ping' }]);
    assert.strictEqual(out, 'pong');
    assert.strictEqual(seen.url, '/v1/chat/completions');
    assert.strictEqual(seen.headers.authorization, 'Bearer test-key');
    assert.strictEqual(seen.body.model, 'test-model');
    assert.deepStrictEqual(seen.body.messages, [{ role: 'user', content: 'ping' }]);
  } finally {
    srv.close();
  }
});

test('chat retries on 500 then succeeds', async () => {
  let n = 0;
  const { srv, url } = await mockServer(() => (++n === 1 ? { status: 500 } : { content: 'second try' }));
  try {
    const out = await LLM.chat({ ...CFG, baseUrl: url }, [{ role: 'user', content: 'x' }]);
    assert.strictEqual(out, 'second try');
    assert.strictEqual(n, 2);
  } finally {
    srv.close();
  }
});

test('chat fails fast on 401 (no retry)', async () => {
  let n = 0;
  const { srv, url } = await mockServer(() => {
    n++;
    return { status: 401, content: 'bad key' };
  });
  try {
    await assert.rejects(
      LLM.chat({ ...CFG, baseUrl: url }, [{ role: 'user', content: 'x' }]),
      (e) => /LLM 401/.test(e.message)
    );
    assert.strictEqual(n, 1);
  } finally {
    srv.close();
  }
});

test('chat requires configuration', async () => {
  await assert.rejects(LLM.chat({ baseUrl: '', model: '', apiKey: '' }, []), /not configured/);
});

test('extractJson handles fenced, prose-wrapped, and garbage replies', () => {
  assert.deepStrictEqual(LLM.extractJson('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(LLM.extractJson('```json\n{"a":{"b":2}}\n```'), { a: { b: 2 } });
  assert.deepStrictEqual(LLM.extractJson('Sure! Here it is: {"tasks":[{"id":"t1","minutes":15}]} hope that helps'), {
    tasks: [{ id: 't1', minutes: 15 }],
  });
  assert.strictEqual(LLM.extractJson('no json here'), null);
  assert.strictEqual(LLM.extractJson('{"unbalanced": '), null);
});

test('refineEtas validates: clamps range, drops unknown ids, keeps known', async () => {
  let seen = null;
  const { srv, url } = await mockServer((r) => {
    seen = r;
    return {
      content: JSON.stringify({
        tasks: [
          { id: 't1', minutes: 900 }, // clamps to the ceiling
          { id: 't2', minutes: 3 }, // prompt contract: minimum is 1, kept as-is
          { id: 'ghost', minutes: 30 }, // dropped
          { id: 't3', minutes: 42 },
        ],
      }),
    };
  });
  try {
    const out = await LLM.refineEtas({ ...CFG, baseUrl: url }, {
      tasks: [
        { id: 't1', title: 'a', estimateMin: 60 },
        { id: 't2', title: 'b', estimateMin: 20 },
        { id: 't3', title: 'c', estimateMin: 30 },
      ],
      history: [],
      workHours: '09:00–17:00',
      bias: 1,
    });
    assert.deepStrictEqual(out, [
      { id: 't1', minutes: 480 }, // ceiling clamp
      { id: 't2', minutes: 3 }, // prompt contract: minimum is 1, no floor of 5
      { id: 't3', minutes: 42 },
    ]);
    // no anchoring: the request must not carry the local estimate
    const user = JSON.parse(seen.body.messages.find((m) => m.role === 'user').content);
    assert.deepStrictEqual(Object.keys(user.tasks[0]).sort(), ['id', 'title']);
  } finally {
    srv.close();
  }
});

test('refineEtas rejects unparseable replies', async () => {
  const { srv, url } = await mockServer(() => ({ content: 'I could not parse that, sorry' }));
  try {
    await assert.rejects(
      LLM.refineEtas({ ...CFG, baseUrl: url }, { tasks: [{ id: 't1', title: 'a', estimateMin: 10 }], history: [] }),
      /unparseable/
    );
  } finally {
    srv.close();
  }
});

test('summarize: legacy JSON shape still accepted, capped at 8', async () => {
  const { srv, url } = await mockServer(() => ({
    content: JSON.stringify({
      headline: 'Solid day, one flag.',
      issues: Array.from({ length: 10 }, (_, i) => ({ sev: 'high', text: `i${i}`, fix: 'f' })),
    }),
  }));
  try {
    const out = await LLM.summarize({ ...CFG, baseUrl: url }, { scope: 'day', days: [] });
    assert.strictEqual(out.issues.length, 8);
    assert.strictEqual(out.headline, 'Solid day, one flag.');
  } finally {
    srv.close();
  }
});

test('summarize: recap + suggestions shape resolves cite to a task title', async () => {
  const { srv, url } = await mockServer(() => ({
    content: JSON.stringify({
      recap: 'Steady morning, late finish.',
      suggestions: [
        { content: 'Cap the day at the boundary.', cite: 't_abc' },
        { content: 'Take the break after deep work.', cite: 't_missing' },
        { content: 'No citation here.' },
      ],
    }),
  }));
  try {
    const out = await LLM.summarize({ ...CFG, baseUrl: url }, {
      scope: 'day',
      days: [],
      idToTitle: { t_abc: 'Build timeline chart' },
    });
    assert.strictEqual(out.headline, 'Steady morning, late finish.');
    assert.strictEqual(out.issues.length, 3);
    assert.strictEqual(out.issues[0].about, 'Build timeline chart');
    assert.strictEqual(out.issues[1].about, ''); // unknown cite resolves to nothing
    assert.strictEqual(out.issues[2].about, '');
  } finally {
    srv.close();
  }
});

test('testConnection round-trips and reports latency', async () => {
  const { srv, url } = await mockServer(() => ({ content: 'OK' }));
  try {
    const r = await LLM.testConnection({ ...CFG, baseUrl: url });
    assert.strictEqual(r.ok, true);
    assert.ok(r.ms >= 0);
  } finally {
    srv.close();
  }
});

test('summarize falls back to prose when the reply is not JSON', async () => {
  const { srv, url } = await mockServer(() => ({ content: 'Recap: steady day. 1. sleep 2. walk 3. plan less.' }));
  try {
    const out = await LLM.summarize({ ...CFG, baseUrl: url }, { scope: 'day', metrics: {}, tasks: [] });
    assert.strictEqual(out.headline.includes('Recap: steady day'), true);
    assert.strictEqual(out.issues.length, 0);
  } finally {
    srv.close();
  }
});

test('system prompts load from editable files; missing file falls back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shapeday-prompts-'));
  fs.writeFileSync(path.join(dir, 'eta.txt'), 'CUSTOM ETA PROMPT');
  let seen = null;
  const { srv, url } = await mockServer((r) => {
    seen = r;
    const sys = seen.body.messages[0].content;
    const content = sys.includes('suggestions')
      ? JSON.stringify({ recap: 'r', suggestions: [] })
      : JSON.stringify({ tasks: [] });
    return { content };
  });
  try {
    // custom file wins, sent verbatim as the system message
    await LLM.refineEtas({ ...CFG, baseUrl: url, promptsDir: dir }, { tasks: [], history: [] });
    assert.strictEqual(seen.body.messages[0].role, 'system');
    assert.strictEqual(seen.body.messages[0].content, 'CUSTOM ETA PROMPT');

    // no data-dir file for the summary prompt -> inline contract default
    await LLM.summarize({ ...CFG, baseUrl: url, promptsDir: dir }, { scope: 'day', days: [] });
    assert.ok(seen.body.messages[0].content.includes('suggestions'));
  } finally {
    srv.close();
  }
});
