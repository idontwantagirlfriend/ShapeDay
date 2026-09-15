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
    overlayStyle: 'top', // persisted settings survive runs; pin the shape this flow expects
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

  // 1a. write-in editors: type an ETA and rename a headline
  const writeIn = await win.webContents.executeJavaScript(`(async () => {
    const call = (k, p) => shapeday.call(k, p);
    const row0 = document.querySelectorAll('li.task')[0];
    row0.querySelector('.mins').click();
    const minsInput = row0.querySelector('.mins-edit');
    minsInput.value = '45';
    minsInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const est = (await call('day:get')).day.tasks[0].estimateMin;
    const row1 = document.querySelectorAll('li.task')[1];
    row1.querySelector('.title').click();
    const titleBox = row1.querySelector('.title-edit');
    titleBox.value = 'Ship the timeline';
    titleBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const title = (await call('day:get')).day.tasks[1].title;
    return { est, title };
  })()`);
  check('ETA write-in commits a typed value', writeIn.est === 45, String(writeIn.est));
  check('headline write-in renames the task', writeIn.title === 'Ship the timeline', writeIn.title);

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

  // overlay progress is the CURRENT task's pace (worked ÷ its estimate), not
  // the day's workload: the day reads high here, the fresh current task ~0%
  await call('settings:set', { overlayStyle: 'top' });
  await sleep(1500);
  const barWinNow = windows.ALL.find((w) => w.webContents.getURL().includes('bar.html'));
  const stripPct = await barWinNow.webContents.executeJavaScript(
    `parseInt(document.getElementById('strip-fill').style.width, 10)`
  );
  const dayPct = Math.round(snap.progress.ratio * 100);
  check('overlay progress tracks the current task, not the day',
    stripPct <= 5 && dayPct > 20, `strip=${stripPct}% day=${dayPct}%`);
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
  // regression: the toast never scrolls — window height >= content height
  const toastW = toast();
  const fits = { ok: false };
  if (toastW) {
    const shown = await win.webContents.executeJavaScript('window.__events.some(e => e.type === "break-propose")');
    if (shown) {
      const contentH = await toastW.webContents.executeJavaScript('document.querySelector(".toast").scrollHeight');
      const [, winH] = toastW.getContentSize();
      fits.ok = winH >= contentH;
    }
  }
  check('break toast fits its content without scrolling', fits.ok);

  // regression: dragging the toast used to grow it (+2px per fit cycle,
  // measurement mirroring the 100vh shell). Size must be stable across
  // repeated fits AND a synthetic drag storm.
  const toastGrowth = await win.webContents.executeJavaScript('0').then(async () => {
    const t = toast();
    if (!t) return { ok: false, why: 'no toast window' };
    t.showInactive();
    // let the first legitimate fit-to-content converge, then measure
    await new Promise((r) => setTimeout(r, 800));
    const size0 = t.getSize().join('x');
    // simulate what dragging does: move events + a fit after each
    await t.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 12; i++) {
        await shapeday.call('overlay:drag', { sx: 600 + i, sy: 400 + i });
        await shapeday.call('overlay:drag', { end: true });
        // trigger the fit path the way show()/propose does
        document.dispatchEvent(new Event('x'));
        await new Promise((r) => setTimeout(r, 60));
      }
      // force repeated real fit cycles at the measured height: convergent
      const inner = document.querySelector('.toast-inner');
      const realH = Math.ceil(inner.getBoundingClientRect().height) + 2;
      for (let i = 0; i < 6; i++) {
        await shapeday.call('overlay:toastHeight', { h: realH });
      }
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const size1 = t.getSize().join('x');
    return { ok: size0 === size1, why: `${size0} -> ${size1}` };
  });
  check('toast size stable across drag + fit cycles', toastGrowth.ok, toastGrowth.why || '');

  // 4b. halfway notice is a drawover window: appears on prompt, hides on answer
  await sleep(300);
  const evalW = windows.ALL.find((w) => w.webContents.getURL().includes('eval.html'));
  check('halfway notice opens as a drawover window', evalW && evalW.isVisible());
  await call('eval:respond', { response: 'ahead' });
  await sleep(300);
  check('halfway notice hides once answered', evalW && !evalW.isVisible());

  // 5. finish the second → 100% → 50% self-eval prompt
  await call('task:click', { id: snap.day.tasks[1].id });
  await sleep(1300);
  ev = await win.webContents.executeJavaScript('window.__events.filter(e => e.type === "eval-prompt")');
  check('self-evaluation prompts on the current task\'s pacing', ev.length >= 1, `${ev.length} prompt(s)`);
  await call('eval:respond', { response: 'ahead' });
  await sleep(200);

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
  await call('settings:set', { overlayStyle: 'top' });
  await sleep(600);
  const topBounds = barWin.getBounds();
  await call('settings:set', { overlayStyle: 'floater' });
  await sleep(600);
  const flBounds = barWin.getBounds();
  check('overlay style switches strip → floater geometry',
    topBounds.width > 1000 && topBounds.height === 26 && flBounds.width === 460 && flBounds.height === 78,
    `${topBounds.width}x${topBounds.height} → ${flBounds.width}x${flBounds.height}`);
  const flShown = await barWin.webContents.executeJavaScript(`({
    top: getComputedStyle(document.getElementById('topbar')).display,
    fl: getComputedStyle(document.getElementById('floater')).display,
  })`);
  check('floater mode actually shows the floater (hidden wins over display)',
    flShown.top === 'none' && flShown.fl !== 'none', JSON.stringify(flShown));
  await call('settings:set', { overlayStyle: 'top' });
  await sleep(600);
  const backBounds = barWin.getBounds();
  check('overlay style returns to strip geometry', backBounds.width > 1000 && backBounds.height === 26);

  // tint strength: clamps + zero hides the tint window even in overwork
  await call('settings:set', { tintStrength: 999 });
  snap = await call('day:get');
  check('tint strength clamps to 0..200', snap.settings.tintStrength === 200, String(snap.settings.tintStrength));
  await call('settings:set', { tintStrength: 0 });
  await sleep(700);
  const tintHiddenAtZero = windows.ALL.find((w) => w.webContents.getURL().includes('tint.html'));
  check('tint hidden at strength 0 despite overwork', tintHiddenAtZero && !tintHiddenAtZero.isVisible());
  await call('settings:set', { tintStrength: 100 });
  const topShown = await barWin.webContents.executeJavaScript(`({
    top: getComputedStyle(document.getElementById('topbar')).display,
    fl: getComputedStyle(document.getElementById('floater')).display,
  })`);
  check('top mode actually shows the strip',
    topShown.top !== 'none' && topShown.fl === 'none', JSON.stringify(topShown));

  // overlay mouse policy: the strip is interactive only while the cursor is
  // over its grip, the floater never goes click-through
  const policy = [];
  const realIgnore = barWin.setIgnoreMouseEvents.bind(barWin);
  barWin.setIgnoreMouseEvents = (ignore, opts) => {
    policy.push(ignore ? 'ignore' : 'accept');
    return realIgnore(ignore, opts);
  };
  const hover = async (sel) => {
    await barWin.webContents.executeJavaScript(`(() => {
      const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }));
      return true;
    })()`);
    await sleep(200);
  };
  policy.length = 0;
  await hover('#strip-grip');
  const gripAccepted = policy.includes('accept');
  policy.length = 0;
  await barWin.webContents.executeJavaScript('document.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })), true');
  await sleep(200);
  const leftIgnored = policy.includes('ignore');
  check('strip accepts the mouse only while over the grip',
    gripAccepted && leftIgnored, `accept=${gripAccepted} leave=${leftIgnored}`);

  // floater: draggable from anywhere on the capsule, and stale interactivity
  // toggles must not turn it click-through
  await call('settings:set', { overlayStyle: 'floater' });
  await sleep(600);
  const flPos = barWin.getPosition();
  await barWin.webContents.executeJavaScript(`(() => {
    const fl = document.getElementById('floater');
    fl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, screenX: 640, screenY: 300 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 680, screenY: 330 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 720, screenY: 360 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  const flMoved = barWin.getPosition();
  check('floater drags from anywhere on the capsule',
    flMoved[0] === flPos[0] + 80 && flMoved[1] === flPos[1] + 60, `${flPos} → ${flMoved}`); // press-anchored: full cursor delta
  policy.length = 0;
  await barWin.webContents.executeJavaScript('shapeday.call("overlay:setInteractive", { on: false })');
  await sleep(200);
  check('floater ignores stale interactivity toggles',
    !policy.includes('ignore'), JSON.stringify(policy));

  // strip: still drags from the grip, but not from its background
  await call('settings:set', { overlayStyle: 'top' });
  await sleep(600);
  const topPos = barWin.getPosition();
  await barWin.webContents.executeJavaScript(`(() => {
    const g = document.getElementById('strip-grip');
    g.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, screenX: 800, screenY: 10 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 820, screenY: 20 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 840, screenY: 30 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  const topMoved = barWin.getPosition();
  check('strip still drags from the grip',
    topMoved[0] === topPos[0] + 40 && topMoved[1] === topPos[1] + 20, `${topPos} → ${topMoved}`); // press-anchored
  // capture-layer drag lifecycle: begin from the origin, moves arrive via
  // the shield path (fast drags can outrun the window — this must not stall)
  const shieldBefore = windows.ALL.filter((w) => w.webContents.getURL().includes('dragshield')).map((w) => w.isVisible());
  const capPos = barWin.getPosition();
  await barWin.webContents.executeJavaScript(`(() => {
    const g = document.getElementById('strip-grip');
    g.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, screenX: 500, screenY: 400 }));
    return true;
  })()`);
  await sleep(300); // shield raises on begin
  const shieldMid = windows.ALL.find((w) => w.webContents.getURL().includes('dragshield'));
  const shieldVisibleDuringDrag = shieldMid && shieldMid.isVisible();
  await win.webContents.executeJavaScript(`(async () => {
    // a far, fast drag entirely outside the strip window, via the capture path
    await shapeday.call('overlay:dragMove', { sx: 900, sy: 500 });
    await shapeday.call('overlay:dragMove', { sx: 1300, sy: 600 });
    return true;
  })()`);
  await sleep(300);
  const capMoved = barWin.getPosition();
  await win.webContents.executeJavaScript(`shapeday.call('overlay:dragEnd', {}), true`);
  await sleep(300);
  const shieldGoneAfterEnd = shieldMid && !shieldMid.isVisible();
  check('capture layer rides the drag and hides after release',
    shieldVisibleDuringDrag && shieldGoneAfterEnd &&
      capMoved[0] === capPos[0] + 800 && capMoved[1] === capPos[1] + 200,
    `shield=${shieldVisibleDuringDrag}/${shieldGoneAfterEnd} ${capPos} → ${capMoved}`);
  await call('settings:set', { overlayStyle: 'floater' });
  await sleep(400);
  await barWin.webContents.executeJavaScript(`(() => {
    document.getElementById('floater').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, screenX: 640, sy: 300 }));
    return true;
  })()`);
  await win.webContents.executeJavaScript(`shapeday.call('overlay:dragEnd', {}), true`);
  await sleep(200);

  const bgPos = barWin.getPosition();
  await barWin.webContents.executeJavaScript(`(() => {
    document.getElementById('top-headline').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, screenX: 300, screenY: 10 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 340, screenY: 30 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  const bgMoved = barWin.getPosition();
  check('strip background does not drag',
    bgMoved[0] === bgPos[0] && bgMoved[1] === bgPos[1], `${bgPos} → ${bgMoved}`);
  windows.applyBarStyle(barWin, 'top');

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
  let etaRequests = 0;
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
          // eta shape: 77 minutes on the first request, 88 afterwards —
          // distinguishes a scoped add-time refinement from a full-list sweep
          etaRequests += 1;
          const mins = etaRequests === 1 ? 77 : 88;
          const user = body.messages.find((m) => m.role === 'user');
          const ids = (JSON.parse(user.content).tasks || []).map((t) => t.id);
          content = JSON.stringify({ tasks: ids.map((id) => ({ id, minutes: mins })) });
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
  const aiCount = snap.day.tasks.filter((t) => t.estimateMin === 77 || t.estimateMin === 88).length;
  check('AI estimation applied through configured endpoint', aiCount >= 1, `${aiCount} task(s) at mock value`);
  check('AI refinement reopens the review after approval', snap.day.etaReviewed === false);

  // scoped estimation: adding a task refines ONLY that task (88), the
  // earlier tasks keep their first-pass estimates (77)
  await call('task:add', { title: 'Scoped estimation check' });
  await sleep(5000);
  snap = await call('day:get');
  const at88 = snap.day.tasks.filter((t) => t.estimateMin === 88);
  const at77 = snap.day.tasks.filter((t) => t.estimateMin === 77);
  check('add estimates only the new task',
    at88.length === 1 && at88[0].title === 'Scoped estimation check' && at77.length >= 1,
    `88s=${at88.length} 77s=${at77.length}`);
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

  // manual re-summarize: a second llm:report arrives for the same scope
  const beforeRep = evRep.length;
  await call('report:regen', { scope: 'day' });
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const n = await win.webContents.executeJavaScript('window.__events.filter(e => e.type === "llm:report").length');
    if (n > beforeRep) break;
  }
  const repEvents = await win.webContents.executeJavaScript('window.__events.filter(e => e.type === "llm:report").length');
  check('re-summarize regenerates the AI summary', repEvents > beforeRep);
  const regenVisible = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-view=sum]').click();
    await new Promise((r) => setTimeout(r, 400));
    const inAI = document.getElementById('btn-resummarize').hidden;
    await shapeday.call('settings:set', { summaryMode: 'template' });
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('.sum-scopes [data-scope=day]').click();
    await new Promise((r) => setTimeout(r, 400));
    const inTemplate = document.getElementById('btn-resummarize').hidden;
    return { inAI, inTemplate }; // inAI should be false (shown), inTemplate true
  })()`);
  check('regen button shows in AI mode, hidden in template mode',
    regenVisible.inAI === false && regenVisible.inTemplate === true, JSON.stringify(regenVisible));
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

  // tray-restore regression: closing must hide (not destroy) the window, and
  // showing it again must not throw "Object has been destroyed"
  const mainW = getMainWin();
  mainW.close(); // intercepted by hide-to-tray; never destroys
  await sleep(500);
  const hiddenNotDestroyed = !mainW.isVisible() && !mainW.isDestroyed();
  let restored = false;
  try {
    const barW = windows.ALL.find((w) => w.webContents.getURL().includes('bar.html'));
    await barW.webContents.executeJavaScript(`shapeday.call('focusMain'), true`);
    await sleep(500);
    const after = getMainWin(); // may be the hidden one shown, or a fresh one
    restored = !!after && !after.isDestroyed() && after.isVisible();
  } catch {
    restored = false;
  }
  check('close hides to tray; restore works without destroy', hiddenNotDestroyed && restored,
    `hidden=${hiddenNotDestroyed} restored=${restored}`);

  fs.writeFileSync('/tmp/shapeday-e2e.json', JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`e2e: ${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

module.exports = { run };
