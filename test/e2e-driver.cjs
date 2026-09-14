/**
 * e2e-driver — runs inside the Electron main process when SHAPEDAY_E2E=1.
 * Drives the real renderer through the interaction contract:
 *   auto-flag frontier · left click = finish · right click = abort
 *   break parks the current task (on break) · revive → red · drag reorder
 */
'use strict';
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ app, getMainWin, state, windows }) {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: detail ?? '' });
    console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  const win = getMainWin();
  const toast = () => windows.ALL.find((w) => w.webContents.getURL().includes('break.html'));

  await win.webContents.executeJavaScript(`
    window.__events = [];
    shapeday.onEvent(e => window.__events.push(e));
    true
  `);
  const call = async (kind, payload) =>
    win.webContents.executeJavaScript(
      `shapeday.call(${JSON.stringify(kind)}, ${JSON.stringify(payload ?? {})})`
    );

  await sleep(400);
  await call('day:clear');
  // hermetic start: a previously crashed run may have left AI modes pointing
  // at a dead mock endpoint, which would poison the early templated checks
  await call('settings:set', {
    autoAdvance: true,
    estimatorMode: 'smart',
    summaryMode: 'template',
    llm: { baseUrl: '', apiKey: '', model: '' },
  });
  check('windows created (main+bar+toast+tint)', windows.ALL.length >= 4, `${windows.ALL.length}`);

  // 1. list — first item auto-flags in progress, rest red
  await call('task:add', { title: 'Reply to launch email' });
  const add2 = await call('task:add', { title: 'Build timeline chart' });
  let snap = await call('day:get');
  check('first task auto-flagged in progress',
    snap.day.tasks[0].status === 'yellow' && snap.day.tasks[1].status === 'red');
  const grip = await win.webContents.executeJavaScript(`(() => {
    const g = document.querySelector('li.task .grip');
    return g ? getComputedStyle(g).opacity + '|' + getComputedStyle(g).cursor : 'MISSING';
  })()`);
  check('drag grip present and visible on rows', grip !== 'MISSING' && !grip.startsWith('0)'), grip);
  check('estimator buckets applied', add2.task.estimateMin >= 45, `build est ${add2.task.estimateMin}m`);

  // 1b. click a NON-current task → it becomes current, old goes on break
  await call('task:add', { title: 'Read spec draft' });
  snap = await call('day:get');
  const sw = await call('task:click', { id: snap.day.tasks[2].id });
  snap = await call('day:get');
  check('clicking a non-current task switches to it',
    sw.event === 'switched' && snap.day.tasks[2].status === 'yellow' && snap.day.tasks[0].status === 'paused');
  check('exactly one task in progress', snap.day.tasks.filter((t) => t.status === 'yellow').length === 1);
  // click the current → finished (the one she switched to)
  const sw2 = await call('task:click', { id: snap.day.tasks[2].id });
  snap = await call('day:get');
  check('clicking the current finishes it', sw2.event === 'finished' && snap.day.tasks[2].status === 'green');
  // pause the frontier again so later steps see the classic layout
  await call('task:skip', { id: snap.day.tasks[0].id }); // old paused one → abort
  await call('task:delete', { id: snap.day.tasks[0].id }); // clean up the aborted entry
  await call('day:resetStatuses'); // fresh frontier: first of the two flags itself
  snap = await call('day:get');
  check('after cleanup two tasks remain, first flagged',
    snap.day.tasks.length === 2 && snap.day.tasks[0].status === 'yellow', `${snap.day.tasks.length}`);

  await win.webContents.executeJavaScript('window.__events = [], true'); // reset collectors after 1b

  // 2. left click = finish, one gesture; next task auto-flags
  const id1 = snap.day.tasks[0].id;
  const click1 = await call('task:click', { id: id1 });
  snap = await call('day:get');
  check('left click finishes in one gesture',
    click1.event === 'finished' && snap.day.tasks[0].status === 'green' && snap.day.tasks[0].finishedAt > 0);
  check('next task auto-flagged after finish', snap.day.tasks[1].status === 'yellow');
  await sleep(1200);
  let ev = await win.webContents.executeJavaScript('window.__events.filter(e => e.type === "break-propose")');
  check('break proposal fired', ev.length === 1);

  // 3. accept break → current goes on break (paused); double-accept idempotent
  await call('break:respond', { accept: true });
  await call('break:respond', { accept: true });
  snap = await call('day:get');
  check('break accepted & idempotent',
    !!snap.break && snap.day.breaks.filter((b) => b.end == null).length === 1);
  check('current task on break during the break', snap.day.tasks[1].status === 'paused');

  // 4. end break → same task resumes (not the next one skipped over)
  await call('break:end');
  snap = await call('day:get');
  check('paused task resumes after break',
    snap.day.tasks[1].status === 'yellow' && !!snap.active && snap.active.id === snap.day.tasks[1].id);
  check('toast hidden after break ends', toast() && !toast().isVisible());

  // 5. finish the second → 100% → 50% self-eval prompt
  await call('task:click', { id: snap.day.tasks[1].id });
  await sleep(1300);
  ev = await win.webContents.executeJavaScript('window.__events.filter(e => e.type === "eval-prompt")');
  check('50% self-evaluation prompted', ev.length === 1);

  // 6. right click = abort; click again = revive → red
  await call('task:add', { title: 'Read spec draft' });
  snap = await call('day:get');
  const id3 = snap.day.tasks[2].id;
  check('frontier flagged the new task', snap.day.tasks[2].status === 'yellow');
  await call('task:skip', { id: id3 });
  snap = await call('day:get');
  check('right-click aborts → white (hung)', snap.day.tasks[2].status === 'white');
  await call('task:click', { id: id3 });
  snap = await call('day:get');
  check('click revives white → red, not in progress',
    snap.day.tasks[2].status === 'red' && !snap.active);

  // 7. reorder: move the red task above the finished ones — per the rule
  //    ("first item after the previous finished one") nothing follows the
  //    last green, so no auto-flag; it stays red until clicked.
  await call('task:move', { id: id3, toIndex: 0 });
  snap = await call('day:get');
  check('task:move reorders', snap.day.tasks[0].id === id3 && snap.day.tasks[0].title === 'Read spec draft');
  check('moved-above-finished task stays red, frontier empty',
    snap.day.tasks[0].status === 'red' && !snap.active);

  // 7b. deletion + reflog
  await call('task:delete', { id: id3 });
  snap = await call('day:get');
  check('task:delete removes the task', !snap.day.tasks.some((t) => t.id === id3));
  const log = snap.day.reflog || [];
  check('reflog records added / status / deleted',
    log.some((e) => e.kind === 'added') && log.some((e) => e.kind === 'status') && log.some((e) => e.kind === 'deleted'));

  // 8. overwork clock: shove work-end into the past
  const past = new Date(Date.now() - 60 * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  await call('settings:set', { workEnd: `${pad(past.getHours())}:${pad(past.getMinutes())}` });
  snap = await call('day:get');
  check('overwork clock running past hours end', snap.overworkMin >= 55, `${snap.overworkMin}m`);

  // 9. report — metrics + templated headline (default template mode)
  const rep = await call('report:get', { scope: 'day' });
  // 9b. click a finished task → reopens it (regression: green was a no-op)
  const doneId = snap.day.tasks.find((t) => t.status === 'green')?.id;
  if (doneId) {
    await call('task:click', { id: doneId });
    snap = await call('day:get');
    check('clicking a finished task reopens it',
      snap.day.tasks.find((t) => t.id === doneId)?.status === 'yellow');
    await call('task:click', { id: doneId }); // finish it again to restore
  } else {
    check('clicking a finished task reopens it', true, 'no green task in scope');
  }

  check('day report has metrics, issues, templated headline',
    rep.metrics && Array.isArray(rep.issues) && typeof rep.templated === 'string' && rep.templated.includes('done'));

  // 10. UX affordances: reflog unfolded by default + opacity control + setting round-trip
  const ui = await win.webContents.executeJavaScript(`(() => {
    const box = document.getElementById('reflog');
    const slider = document.getElementById('set-ow-opacity');
    return {
      reflogOpen: box.hidden ? null : box.open,
      hasOpacity: !!slider,
      gear: document.querySelector('details.settings summary').textContent.trim(),
    };
  })()`);
  check('reflog unfolded by default', ui.reflogOpen === true, JSON.stringify(ui));
  check('overlay opacity control present, gear is bare glyph', ui.hasOpacity && ui.gear === '⚙');
  await call('settings:set', { overlayOpacity: 55 });
  snap = await call('day:get');
  check('overlay opacity setting round-trips', snap.settings.overlayOpacity === 55);

  // overlay style switch: top strip ↔ floater geometry follows
  const barWin = windows.ALL.find((w) => w.webContents.getURL().includes('bar.html'));
  const topBounds = barWin.getBounds();
  await call('settings:set', { overlayStyle: 'floater' });
  await sleep(600);
  const flBounds = barWin.getBounds();
  check('overlay style switches strip → floater geometry',
    topBounds.width > 1000 && topBounds.height === 26 && flBounds.width === 460 && flBounds.height === 78,
    `${topBounds.width}x${topBounds.height} → ${flBounds.width}x${flBounds.height}`);
  await call('settings:set', { overlayStyle: 'top' });
  await sleep(600);
  const backBounds = barWin.getBounds();
  check('overlay style returns to strip geometry', backBounds.width > 1000 && backBounds.height === 26);

  // background customization: set a real file, verify cover-fit layer, clear
  fs.writeFileSync('/tmp/shapeday-bg.png', Buffer.from(
    '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000d49444154789c626001000000ffff030000060005' +
    '57bfabd40000000049454e44ae426082', 'hex'));
  await call('settings:set', { backgroundImage: '/tmp/shapeday-bg.png' });
  await sleep(600);
  const bg = await win.webContents.executeJavaScript(`(() => {
    const l = document.getElementById('bg-layer');
    const cs = l ? getComputedStyle(l) : null;
    return {
      applied: !!l && !l.hidden && (l.style.backgroundImage || '').includes('shapeday-bg.png'),
      size: cs ? cs.backgroundSize : '-',
      pos: cs ? cs.backgroundPosition : '-',
    };
  })()`);
  check('background applied cover-fit (scale + clip, ratio kept)',
    bg.applied && bg.size === 'cover' && bg.pos === '50% 50%', JSON.stringify(bg));
  await call('settings:set', { backgroundImage: '' });
  await sleep(400);
  const bgCleared = await win.webContents.executeJavaScript('document.getElementById("bg-layer").hidden');
  check('background clear restores the plain backdrop', bgCleared === true);

  // 11. the real AI estimation path, against a local mock chat/completions
  // endpoint: config -> mode -> debounce -> fetch -> parse -> apply -> event.
  // Regression: etaReviewed (set by day:clear / "Looks right") used to kill
  // refinement silently.
  const http = require('http');
  let mockSys = '';
  const srv = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      let content = '';
      try {
        const body = JSON.parse(buf);
        if (body.messages[0].content.includes('suggestions')) {
          // summarize shape per prompts/summary.txt: recap + cited suggestions
          mockSys = body.messages[0].content;
          const user = JSON.parse(body.messages.find((m) => m.role === 'user').content);
          const cite = user.days?.[0]?.tasks?.[0]?.id || '';
          content = JSON.stringify({
            recap: 'mock recap',
            suggestions: [{ content: 'mock suggestion', cite }],
          });
        } else {
          // eta shape: 77 minutes for every asked-about task
          const user = body.messages.find((m) => m.role === 'user');
          const ids = (JSON.parse(user.content).tasks || []).map((t) => t.id);
          content = JSON.stringify({ tasks: ids.map((id) => ({ id, minutes: 77 })) });
        }
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const mockUrl = `http://127.0.0.1:${srv.address().port}/v1`;

  await call('settings:set', { llm: { baseUrl: mockUrl, model: 'mock', apiKey: '' }, estimatorMode: 'ai' });
  await call('day:resetStatuses'); // all tasks red again; etaReviewed is true here (day:clear set it)
  await call('task:add', { title: 'AI estimated chore' }); // fresh unedited task
  await sleep(5000); // 1.5s config debounce + 2.5s add debounce + round-trip
  snap = await call('day:get');
  const aiCount = snap.day.tasks.filter((t) => t.estimateMin === 77).length;
  check('AI estimation applied through configured endpoint', aiCount >= 1, `${aiCount} task(s) at mock value`);
  check('AI refinement reopens the review after approval', snap.day.etaReviewed === false);
  const evLLM = await win.webContents.executeJavaScript('window.__events.filter(e => e.type === "llm:etas")');
  check('llm:etas event surfaced', evLLM.length >= 1);

  // 11b. summarize through the same mock: fires, merges, event fires
  await call('settings:set', { summaryMode: 'ai' });
  await call('report:get', { scope: 'day' }); // first call triggers the async summary
  let rep2 = null;
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    rep2 = await call('report:get', { scope: 'day' });
    if (rep2.llm) break;
  }
  const merged = !!rep2.llm && rep2.llm.headline === 'mock recap' && Array.isArray(rep2.llm.issues) && rep2.llm.issues.length >= 1;
  check('AI summary merged into report', merged, rep2.llm ? 'cached' : 'never merged in 5s');
  check('suggestion cite resolved to the task title', merged && !!rep2.llm.issues[0].about);
  check('{history_reports} interpolated, not left literal', merged && !mockSys.includes('{history_reports}'));
  const evRep = await win.webContents.executeJavaScript('window.__events.filter(e => e.type === "llm:report")');
  check('llm:report event fired', evRep.length >= 1);
  const dbg = await win.webContents.executeJavaScript('window.__events.map(e => e.type + (e.data && e.data.error ? ":" + e.data.error : ""))');
  console.log('EVENTS:', JSON.stringify(dbg));
  srv.close();

  // leave AI off for any later steps
  await call('settings:set', { estimatorMode: 'smart', summaryMode: 'template', llm: { baseUrl: '', model: '', apiKey: '' } });

  // 11c. week/month grid data: calendar week contains today, entries carry overwork
  const vizWeek = await call('viz:days', { scope: 'week' });
  const vizMonth = await call('viz:days', { scope: 'month' });
  check('viz:days week spans Mon..Sun incl. today',
    vizWeek.days.length >= 1 && vizWeek.days.some((d) => d.date === snap.date) && vizWeek.toKey >= vizWeek.todayKey);
  check('viz:days month spans the 1st..today+',
    vizMonth.days.length >= 1 && vizMonth.fromKey.endsWith('-01') && vizMonth.days.some((d) => d.date === snap.date));
  check('viz:days carries per-day and period summaries',
    typeof vizWeek.days[0].summary === 'string' && 'periodSummary' in vizWeek);

  // regression: leaving the canvas at a grid's edge used to repaint the stale
  // day chart over the week/month pixels (hoverEnd drew state.chart blindly)
  const edgeFlicker = await win.webContents.executeJavaScript(`(async () => {
    const canvas = document.getElementById('timeline');
    document.querySelector('[data-view=viz]').click();
    document.querySelector('[data-viz=week]').click();
    await new Promise((r) => setTimeout(r, 700));
    const snap = () => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.join(',');
    const results = [];
    for (const scope of ['week', 'month']) {
      document.querySelector('[data-viz=' + scope + ']').click();
      await new Promise((r) => setTimeout(r, 700));
      const before = snap();
      canvas.dispatchEvent(new MouseEvent('mouseleave'));
      window.Timeline.hoverEnd();
      await new Promise((r) => setTimeout(r, 120));
      results.push(before === snap());
    }
    return results.every(Boolean);
  })()`);
  check('canvas pixels unchanged by mouseleave in week/month', edgeFlicker === true);
  const repMonth = await call('report:get', { scope: 'month' });
  const repYear = await call('report:get', { scope: 'year' });
  check('month and year report scopes work',
    repMonth.metrics && repYear.metrics && typeof repMonth.templated === 'string');

  fs.writeFileSync('/tmp/shapeday-e2e.json', JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`e2e: ${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

module.exports = { run };
