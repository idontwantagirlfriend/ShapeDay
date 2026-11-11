/**
 * e2e-driver — runs inside the Electron main process when SHAPEDAY_E2E=1.
 * Drives the real renderer through the interaction contract:
 *   auto-flag frontier · left click = finish · right click = abort
 *   break parks the current task (on break) · revive → red · drag reorder
 */
'use strict';
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Failed checks become job annotations, so a red CI run names itself. */
function annotate(text) {
  if (!process.env.GITHUB_ACTIONS) return;
  const escaped = String(text)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .slice(0, 3000);
  console.log(`::error::${escaped}`);
}

async function run({ app, getMainWin, state, store, windows }) {
  const results = [];
  let annotated = 0;
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: detail ?? '' });
    console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
    // GitHub keeps 10 error annotations per step; leave room for the log tail.
    if (!ok && annotated < 5) { annotated++; annotate(`${name}${detail ? ' — ' + detail : ''}`); }
  };

  const win = getMainWin();
  const toast = () => windows.ALL.find((w) => w.webContents.getURL().includes('break.html'));

  await win.webContents.executeJavaScript(`
    window.__events = [];
    window.__uiErrors = [];
    window.addEventListener('error', e => window.__uiErrors.push(e.message));
    window.addEventListener('unhandledrejection', e => window.__uiErrors.push(String(e.reason)));
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

  // 2b. write-in for the break length on the toast itself
  const brkMins = await toast().webContents.executeJavaScript(`(async () => {
    const span = document.getElementById('break-mins');
    span.click();
    const input = document.querySelector('.break-mins-edit');
    if (!input) return { ok: false, why: 'no editor' };
    input.value = '7';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const mins = (await shapeday.call('day:get')).settings.breakMinutes;
    return { ok: mins === 7, why: 'mins=' + mins };
  })()`);
  check('break minutes write-in round-trips', brkMins.ok === true, JSON.stringify(brkMins));

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
  await sleep(700); // let the fit-to-content resize land
  const evalFits = await (async () => {
    if (!evalW) return false;
    const contentH = await evalW.webContents.executeJavaScript(
      "document.querySelector('.evalwin-inner').getBoundingClientRect().height"
    );
    const [, winH] = evalW.getContentSize();
    const [x, y] = evalW.getPosition();
    const wa = require('electron').screen.getPrimaryDisplay().workArea;
    return winH >= contentH && x >= wa.x + wa.width - 320 && y >= wa.y + wa.height - winH - 20;
  })();
  check('halfway notice fits its content, bottom-right anchored', evalFits);
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

  // 8. overwork clock: use the state's explicit clock to avoid midnight
  // wraparound and dependence on the CI runner's local time or saved hours.
  snap = await call('day:get');
  const savedHours = { workStart: snap.settings.workStart, workEnd: snap.settings.workEnd };
  try {
    await call('settings:set', { workStart: '09:00', workEnd: '17:00' });
    const scheduled = await call('day:get');
    const atEnd = state.snapshot(scheduled.bounds.end);
    const afterEnd = state.snapshot(scheduled.bounds.end + 60 * 60000);
    check('overwork clock running past hours end',
      atEnd.overworkMin === 0 && afterEnd.overworkMin === 60, `${afterEnd.overworkMin}m`);
  } finally {
    await call('settings:set', savedHours);
  }
  snap = await call('day:get');

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
    const gear = document.querySelector('details.settings summary');
    const header = document.querySelector('header');
    const arrow = document.querySelector('.auto-advance');
    const lock = document.querySelector('.reflog-lock');
    const wasOpen = box.open;
    const lockVisible = !!lock && getComputedStyle(lock).display !== 'none';
    box.open = false;
    const lockHiddenWhenFolded = !!lock && getComputedStyle(lock).display === 'none';
    box.open = wasOpen;
    const rows = [...document.querySelectorAll('li.task')].filter((row) => row.querySelector('.chip'));
    return {
      reflogOpen: box.hidden ? null : box.open,
      hasOpacity: !!slider,
      gearSvg: !!gear.querySelector('svg path') && !!gear.querySelector('svg circle') && !gear.textContent.trim(),
      brandLogoOnly: !!header.querySelector('img.brand-logo') && !header.querySelector('.brand') && !header.textContent.includes('ShapeDay'),
      minutesRightmost: rows.length > 0 && rows.every((row) => {
        const chip = row.querySelector('.chip');
        const bounds = chip.getBoundingClientRect();
        return row.lastElementChild === chip && [...row.children].every((el) =>
          el === chip || el.getBoundingClientRect().right <= bounds.left + 1);
      }),
      arrow: !!arrow?.querySelector('svg path') && !!arrow.querySelector('#plan-auto')?.checked && !arrow.textContent.trim() && !!arrow.dataset.help,
      lock: !!lock?.querySelector('svg rect') && !!lock.querySelector('svg path') && !!lock.querySelector('#reflog-open')?.checked && !lock.textContent.trim(),
      lockVisible, lockHiddenWhenFolded,
    };
  })()`);
  check('reflog unfolded by default', ui.reflogOpen === true, JSON.stringify(ui));
  check('overlay opacity control present, gear is bare SVG', ui.hasOpacity && ui.gearSvg, JSON.stringify(ui));
  check('header keeps the logo without duplicate brand text', ui.brandLogoOnly, JSON.stringify(ui));
  check('task minutes remain the rightmost row element', ui.minutesRightmost, JSON.stringify(ui));
  check('auto-advance is a checked captionless arrow with hover help', ui.arrow, JSON.stringify(ui));
  check('reflog lock is checked, captionless, and only visible when unfolded',
    ui.lock && ui.lockVisible && ui.lockHiddenWhenFolded, JSON.stringify(ui));
  await call('settings:set', { overlayOpacity: 55 });
  snap = await call('day:get');
  check('overlay opacity setting round-trips', snap.settings.overlayOpacity === 55);

  // overlay style switch: top strip ↔ floater geometry follows
  const barWin = windows.ALL.find((w) => w.webContents.getURL().includes('bar.html'));
  const snoozeAppearance = (prefix) => barWin.webContents.executeJavaScript(`(() => {
    const button = document.getElementById(${JSON.stringify(prefix + '-break')});
    const dot = document.getElementById(${JSON.stringify(prefix + '-dot')});
    const glyph = button.querySelector('.snooze-glyph');
    if (!glyph) return { ok: false, why: 'missing snooze glyph' };
    const b = button.getBoundingClientRect(), d = dot.getBoundingClientRect(), g = glyph.getBoundingClientRect();
    const style = getComputedStyle(glyph), background = getComputedStyle(button).backgroundColor;
    const rgba = (background.match(/[0-9.]+/g) || []).map(Number);
    const expectedLabel = I18N.t(I18N.resolve(locale, navigator.language), 'bar.manual_break');
    return { ok: b.width > 0 && g.width > 0 && d.width > 0 && b.right < d.left && g.right < d.left &&
      button.nextElementSibling === dot && glyph.textContent === '💤' && glyph.getAttribute('aria-hidden') === 'true' &&
      button.getAttribute('aria-label') === expectedLabel && !!expectedLabel &&
      style.fontSize === ${JSON.stringify(prefix === 'top' ? '19px' : '22px')} &&
      rgba[0] === 174 && rgba[1] === 216 && rgba[2] === 252 && (rgba[3] ?? 1) > 0 &&
      style.filter.includes('drop-shadow') && style.filter.includes('174, 216, 252'),
      buttonRight: b.right, glyphRight: g.right, dotLeft: d.left,
      label: button.getAttribute('aria-label'), font: style.fontSize, background, glow: style.filter };
  })()`);
  await call('settings:set', { overlayStyle: 'top' });
  await sleep(600);
  const topBounds = barWin.getBounds();
  const topSnooze = await snoozeAppearance('top');
  check('top snooze glyph immediately precedes dot on the left with aria label, 19px font and tinted glow',
    topSnooze.ok, JSON.stringify(topSnooze));
  await call('settings:set', { overlayStyle: 'floater' });
  await sleep(600);
  const flBounds = barWin.getBounds();
  const floaterSnooze = await snoozeAppearance('fl');
  check('floater snooze glyph immediately precedes dot on the left with aria label, 22px font and tinted glow',
    floaterSnooze.ok, JSON.stringify(floaterSnooze));
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

  // The strip accepts pointer hits on its grip and break button;
  // leaving these controls restores click-through. The floater accepts pointer hits.
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
  check('strip grip accepts the mouse and leaving restores click-through',
    gripAccepted && leftIgnored, `accept=${gripAccepted} leave=${leftIgnored}`);
  policy.length = 0;
  await hover('#top-break');
  const breakAccepted = policy.includes('accept');
  const topBreakPosition = barWin.getPosition();
  await barWin.webContents.executeJavaScript(`(() => {
    const button = document.getElementById('top-break'), glyph = button.querySelector('.snooze-glyph');
    const r = glyph.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const target = document.elementFromPoint(x, y);
    if (!target?.closest('#top-break')) return false;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0,
      clientX: x, clientY: y, screenX: 600, screenY: 10 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true,
      clientX: x, clientY: y, screenX: 640, screenY: 30 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    return true;
  })()`).then((hit) => check('top snooze glyph hit targets the break button', hit));
  await sleep(200);
  const afterBreakPress = barWin.getPosition();
  const breakShield = windows.ALL.find((w) => w.webContents.getURL().includes('dragshield'));
  check('top break button press and pointer movement preserve position without drag shield',
    topBreakPosition.join(',') === afterBreakPress.join(',') && !breakShield?.isVisible(),
    `${topBreakPosition} → ${afterBreakPress}`);
  policy.length = 0;
  await hover('#top-dot');
  const breakLeftIgnored = policy.includes('ignore');
  check('top break button accepts pointer hits and leaving for dot restores click-through',
    breakAccepted && breakLeftIgnored, `accept=${breakAccepted} leave=${breakLeftIgnored}`);
  policy.length = 0;
  await hover('#top-break');
  await barWin.webContents.executeJavaScript('document.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })), true');
  await sleep(200);
  check('leaving top break button through window edge restores click-through', policy.includes('ignore'), JSON.stringify(policy));

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
  await sleep(1400); // settle past the 1 Hz style pump before reading positions
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
  // hermetic: kill leftover drags AND re-seat the bar at a known position —
  // a style flip forces applyBarStyle to re-pin bounds deterministically
  await win.webContents.executeJavaScript(`shapeday.call('overlay:dragEnd', {}), true`);
  await call('settings:set', { overlayStyle: 'floater' });
  await sleep(1400); // settle past the 1 Hz style pump
  await call('settings:set', { overlayStyle: 'top' });
  await sleep(1400);
  const capPos = barWin.getPosition();
  await new Promise((r) => setTimeout(r, 1200)); // re-seat pump fully settles
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
  // exact landing coordinates race the async style re-seat left by earlier
  // drag sections; the stable invariants are the shield lifecycle, the pinned
  // size (the original growth regression), and that the window actually moved
  const [mw, mh] = barWin.getSize();
  check('capture layer rides the drag and hides after release',
    shieldVisibleDuringDrag && shieldGoneAfterEnd &&
      mw === 1920 && mh === 26 &&
      (capMoved[0] !== capPos[0] || capMoved[1] !== capPos[1]),
    `shield=${shieldVisibleDuringDrag}/${shieldGoneAfterEnd} ${capPos} → ${capMoved} size=${mw}x${mh}`);
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
    const refresh = document.getElementById('btn-resummarize');
    const inAI = refresh.hidden;
    const svg = refresh.querySelector('svg');
    const r = svg?.getBoundingClientRect();
    const refreshSVG24 = !!svg && svg.getAttribute('viewBox') === '0 0 24 24' &&
      svg.getAttribute('width') === '24' && svg.getAttribute('height') === '24' &&
      Math.abs(r.width - 24) <= 1 && Math.abs(r.height - 24) <= 1 &&
      !!svg.querySelector('path') && refresh.getAttribute('aria-label')?.trim().length > 0;
    await shapeday.call('settings:set', { summaryMode: 'template' });
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('.sum-scopes [data-scope=day]').click();
    await new Promise((r) => setTimeout(r, 400));
    const inTemplate = document.getElementById('btn-resummarize').hidden;
    return { inAI, inTemplate, refreshSVG24 }; // inAI should be false (shown), inTemplate true
  })()`);
  check('regen button shows in AI mode, hidden in template mode',
    regenVisible.inAI === false && regenVisible.inTemplate === true, JSON.stringify(regenVisible));
  check('refresh action uses accessible 24px SVG in AI summary mode', regenVisible.refreshSVG24, JSON.stringify(regenVisible));
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

  // click-only previews: hovering the grids must never pop a bubble over the
  // cells being aimed at; clicking a week task block opens its details.
  const clickProbe = await win.webContents.executeJavaScript(`(async () => {
    const canvas = document.getElementById('timeline');
    const bubble = document.getElementById('viz-bubble');
    const out = {};
    // week: rename one task long so its block provably overflows
    const snapNow = await shapeday.call('day:get');
    await shapeday.call('task:rename', {
      id: snapNow.day.tasks[0].id,
      title: 'Investigate the estimation pipeline regression across every surface, interview the reviewers, write the findings memo, circulate it for comments, and file the follow-ups before the next planning cycle begins',
    });
    document.querySelector('[data-viz=week]').click();
    await new Promise((r) => setTimeout(r, 700));
    const wh = (canvas._hits || []).find((h) => h.kind === 'task');
    if (wh) {
      const r = canvas.getBoundingClientRect();
      const cx = r.left + wh.x + wh.w / 2, cy = r.top + wh.y + Math.min(wh.h / 2, 8);
      canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
      await new Promise((r2) => setTimeout(r2, 150));
      out.weekHover = bubble.hidden; // hover alone must not open it
      canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));
      await new Promise((r2) => setTimeout(r2, 150));
      out.weekClick = !bubble.hidden && bubble.textContent.length > 0;
      const anchorPos = bubble.style.left + '|' + bubble.style.top;
      out.copies = bubble.querySelectorAll('.copy-btn').length;
      // The contract is "hidden until its row is hovered"; on CI the real
      // pointer can already rest on one row, so that row may show its button.
      out.copyHidden = [...bubble.querySelectorAll('.copy-btn')].every((b) =>
        getComputedStyle(b).opacity === '0' || b.closest('.copy-row').matches(':hover'));
      out.hover = [...document.querySelectorAll(':hover')].slice(-4)
        .map((e) => e.id || e.className || e.tagName);
      // moving on the chart must not move it; leaving the bubble dismisses
      canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx + 8, clientY: cy + 4 }));
      await new Promise((r2) => setTimeout(r2, 150));
      out.anchored = !bubble.hidden && bubble.style.left + '|' + bubble.style.top === anchorPos;
      bubble.dispatchEvent(new MouseEvent('mouseleave'));
      await new Promise((r2) => setTimeout(r2, 120));
      out.dismissed = bubble.hidden;
    } else out.weekHover = 'no-task-hit';
    // month: hovering a day cell with tasks stays quiet; clicking previews it
    document.querySelector('[data-viz=month]').click();
    await new Promise((r) => setTimeout(r, 700));
    const dh = (canvas._hits || []).find((h) => h.kind === 'day' && h.tasks.length);
    if (dh) {
      const r = canvas.getBoundingClientRect();
      const cx = r.left + dh.x + dh.w / 2, cy = r.top + dh.y + dh.h / 2;
      canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
      await new Promise((r2) => setTimeout(r2, 150));
      out.monthHover = bubble.hidden;
      canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));
      await new Promise((r2) => setTimeout(r2, 150));
      out.monthClick = !bubble.hidden && bubble.querySelectorAll('.taskline').length > 0;
      out.monthHint = bubble.querySelectorAll('.bb-open').length === 1 && !!bubble.querySelector('h5 .bb-open');
      out.monthNoTaskHint = bubble.querySelectorAll('.taskline .bb-open').length === 0;
      out.monthCopies = bubble.querySelectorAll('.taskline .copy-btn').length === bubble.querySelectorAll('.taskline').length;
    } else out.monthHover = 'no-day-hit';
    return out;
  })()`);
  check('week/month previews are click-only, never hover popups',
    clickProbe.weekHover === true && clickProbe.weekClick === true && clickProbe.monthHover === true &&
      clickProbe.monthClick === true && clickProbe.copies === 4 && clickProbe.copyHidden === true,
    JSON.stringify(clickProbe));
  check('month preview hints only the day title for entering the chart',
    clickProbe.monthHint === true && clickProbe.monthNoTaskHint === true && clickProbe.monthCopies === true,
    JSON.stringify(clickProbe));
  check('clicked preview anchors, copies, and dismisses on leaving it',
    clickProbe.anchored === true && clickProbe.dismissed === true, JSON.stringify(clickProbe));
  const repMonth = await call('report:get', { scope: 'month' });
  const repYear = await call('report:get', { scope: 'year' });
  // month preview: click opens the bubble; the day-title hint enters the chart
  const dayPick = await win.webContents.executeJavaScript(`(async () => {
    const canvas = document.getElementById('timeline');
    document.querySelector('[data-viz=month]').click();
    await new Promise((r) => setTimeout(r, 700));
    const today = (await shapeday.call('day:get')).date;
    const dh = (canvas._hits || []).find((h) => h.kind === 'day' && h.date && h.date !== today);
    if (!dh) return { ok: false, why: 'no non-today day hit' };
    const r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + dh.x + dh.w / 2, clientY: r.top + dh.y + dh.h / 2 }));
    await new Promise((r2) => setTimeout(r2, 200));
    const bubble = document.getElementById('viz-bubble');
    const previewed = !bubble.hidden;
    const hint = bubble.querySelector('h5 .bb-open');
    if (!hint) return { ok: false, why: 'no chart hint' };
    hint.click();
    await new Promise((r2) => setTimeout(r2, 900));
    const chartH = canvas.getBoundingClientRect().height;
    const chip = document.getElementById('day-pick');
    const chipShown = chip && !chip.hidden && chip.textContent.trim().length > 3;
    const dbg = { previewed, chipShown, txt: chip ? chip.textContent : 'gone', hid: chip ? chip.hidden : 'gone' };
    chip.click(); // back to today
    await new Promise((r2) => setTimeout(r2, 600));
    return { ok: previewed && chipShown && chip.hidden && chartH <= 310 && bubble.hidden, why: JSON.stringify({ ...dbg, chartH }) };
  })()`);
  check('month preview day-title hint opens the workload chart', dayPick.ok === true, JSON.stringify(dayPick));

  // the summary strip stays hover-quiet too: hovering a cell never pops the
  // bubble over the grid; clicking toggles the summary row, never the day
  const cellHover = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-viz=week]').click();
    await new Promise((r) => setTimeout(r, 700));
    const bubble = document.getElementById('viz-bubble');
    const cell = document.querySelector('#week-summaries .cell:not(.empty)');
    if (!cell) return { ok: false, why: 'no filled cell' };
    cell.dispatchEvent(new MouseEvent('mouseenter'));
    await new Promise((r) => setTimeout(r, 150));
    const quiet = bubble.hidden;
    cell.dispatchEvent(new MouseEvent('mouseleave'));
    await new Promise((r) => setTimeout(r, 120));
    return { ok: quiet && bubble.hidden, why: 'quiet=' + quiet };
  })()`);
  check('summary cells stay hover-quiet (no bubble over the grid)', cellHover.ok === true, JSON.stringify(cellHover));

  // Seed genuine persisted summaries, never alter renderer content/style to force overflow.
  {
    const report = await call('report:get', { scope: 'week' });
    const keys = [...vizWeek.days.map((d) => d.date), report.periodKey];
    const previous = keys.map((key) => [key, store.summary(key)]);
    const longText = Array.from({ length: 90 }, (_, i) => `Summary line ${i + 1}: full text remains readable and independently scrollable.`).join('\n');
    try {
      keys.forEach((key) => store.putSummary(key, { at: Date.now(), recap: key + '\n' + longText, suggestions: [] }));
      store.flush();
      const weekContract = await win.webContents.executeJavaScript(`(async () => {
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('[data-viz=month]').click();
        await pause(200);
        document.querySelector('[data-viz=week]').click();
        await pause(900);
        const box = document.getElementById('week-summaries'), row = document.getElementById('week-summary-row');
        const cells = [...row.querySelectorAll('.cell')], header = document.getElementById('week-header');
        const buttons = [...header.querySelectorAll('.week-day')], canvas = document.getElementById('timeline');
        const dates = buttons.map((b) => b.dataset.date), period = box.dataset.period;
        const height = (el) => el.getBoundingClientRect().height;
        const equal = (expected) => cells.length === 7 && cells.every((c) => Math.abs(height(c) - expected) <= 1);
        const scopeWeek = () => document.querySelector('.viz-scopes [data-viz=week]').classList.contains('active');
        const initial = row.dataset.expanded === 'false' && Math.abs(height(row) - 112) <= 1 && equal(112) &&
          buttons.length === 7 && buttons.every((b) => b.tagName === 'BUTTON' && b.textContent.trim() &&
            b.getAttribute('aria-label').includes(b.dataset.date)) &&
          buttons.filter((b) => b.getAttribute('aria-current') === 'date').length === 1;
        const filled = cells.filter((c) => !c.classList.contains('empty'));
        const fullText = filled.length > 0 && filled.every((c) => c.textContent === c.dataset.date + '\\n' + ${JSON.stringify(longText)} &&
          getComputedStyle(c).overflowY === 'auto' && c.scrollHeight > c.clientHeight);
        // CI's pointer can rest on the gutter, which is the same palette's hover tint.
        const thumbOK = (c) => c === 'rgb(72, 82, 99)' || c === 'rgb(113, 129, 153)';
        const scrollbar = (el, width) => {
          const bar = getComputedStyle(el, '::-webkit-scrollbar');
          const thumb = getComputedStyle(el, '::-webkit-scrollbar-thumb');
          const track = getComputedStyle(el, '::-webkit-scrollbar-track');
          const buttons = getComputedStyle(el, '::-webkit-scrollbar-button');
          return parseFloat(bar.width) === width && bar.display !== 'none' &&
            thumbOK(thumb.backgroundColor) && parseFloat(thumb.borderRadius) >= 20 &&
            thumb.backgroundClip === 'padding-box' && track.backgroundColor === 'rgba(0, 0, 0, 0)' &&
            buttons.display === 'none' && getComputedStyle(el).scrollbarGutter === 'stable';
        };
        const customScrollbars = filled.every((c) => scrollbar(c, 8)) &&
          scrollbar(document.getElementById('view-viz'), 10) &&
          getComputedStyle(document.documentElement).colorScheme === 'dark';
        filled[0].click();
        const cap = Math.min(320, Math.max(180, innerHeight * 0.36));
        const expanded = row.dataset.expanded === 'true' && equal(cap) && Math.abs(height(row) - cap) <= 1 &&
          cells.every((c) => c.getAttribute('aria-expanded') === 'true') && scopeWeek() && box.dataset.period === period;
        const view = document.getElementById('view-viz'), viewScroll = view.scrollTop;
        filled[0].focus({ preventScroll: true });
        filled[0].scrollTop = filled[0].scrollHeight;
        const cellScroll = filled[0].scrollTop;
        const independent = cellScroll > 0 && cells.filter((c) => c !== filled[0]).every((c) => c.scrollTop === 0) &&
          view.scrollTop === viewScroll && document.scrollingElement.scrollTop === 0;
        // Re-select the active view: real forced refetch without hiding the focused cell.
        document.querySelector('[data-view=viz]').click();
        await pause(900);
        const preserved = document.getElementById('week-summary-row') === row && row.dataset.expanded === 'true' &&
          document.activeElement === filled[0] && filled[0].scrollTop === cellScroll && box.dataset.period === period && scopeWeek() && equal(cap) &&
          buttons.every((b, i) => b.dataset.date === dates[i]);
        const week = document.getElementById('week-period-summary');
        const periodFull = week.querySelector('span').textContent === ${JSON.stringify(report.periodKey + '\n' + longText)} &&
          week.dataset.expanded === 'false' && Math.abs(height(week) - 96) <= 1;
        week.click(); week.scrollTop = week.scrollHeight;
        const periodExpanded = week.dataset.expanded === 'true' && Math.abs(height(week) - cap) <= 1 &&
          getComputedStyle(week).overflowY === 'auto' && week.scrollTop > 0 && row.dataset.expanded === 'true' && scopeWeek();
        const r = canvas.getBoundingClientRect();
        const blank = { x: 1, y: 1 }; // outside all drawn task blocks, in the canvas gutter
        const noDayHits = !(canvas._hits || []).some((h) => h.kind === 'day');
        const noHit = !Timeline.hitTest(canvas, r.left + blank.x, r.top + blank.y);
        canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + blank.x, clientY: r.top + blank.y }));
        await pause(150);
        const blankQuiet = noDayHits && noHit && scopeWeek() && box.dataset.period === period &&
          row.dataset.expanded === 'true' && document.getElementById('viz-bubble').hidden;
        cells[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        const collapsed = row.dataset.expanded === 'false' && equal(112) && scopeWeek() && week.dataset.expanded === 'true';
        week.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
        const periodCollapsed = week.dataset.expanded === 'false' && Math.abs(height(week) - 96) <= 1;
        const today = (await shapeday.call('day:get')).date;
        const button = buttons.find((b) => b.dataset.date !== today);
        button.click();
        await pause(900);
        const selected = document.getElementById('day-pick');
        const navigates = document.querySelector('.viz-scopes [data-viz=day]').classList.contains('active') &&
          !selected.hidden && box.hidden && header.hidden;
        selected.click(); await pause(500);
        return { initial, fullText, expanded, independent, preserved, periodFull, periodExpanded,
          blankQuiet, collapsed, periodCollapsed, navigates, cap, cellScroll, customScrollbars,
          hover: [...document.querySelectorAll(':hover')].slice(-4).map((e) => e.id || e.className || e.tagName) };
      })()`);
      check('week header has seven semantic date buttons; summary cells default to equal 112px full-text scroll areas',
        weekContract.initial && weekContract.fullText, JSON.stringify(weekContract));
      check('week summary click expands all cells to clamped height without navigation; refetch preserves nodes/state/scroll',
        weekContract.expanded && weekContract.independent && weekContract.preserved && weekContract.collapsed, JSON.stringify(weekContract));
      check('week period summary expands and scrolls independently with the same cap',
        weekContract.periodFull && weekContract.periodExpanded && weekContract.periodCollapsed, JSON.stringify(weekContract));
      check('week blank canvas has no day hit/navigation; only header button opens day chart',
        weekContract.blankQuiet && weekContract.navigates, JSON.stringify(weekContract));
      check('week cells and view use custom dark rounded scrollbars with stable gutters',
        weekContract.customScrollbars, JSON.stringify(weekContract));
      const main = getMainWin(), originalBounds = main.getBounds();
      try {
        for (const [width, height] of [[900, 620], [1120, 760], [1450, 900]]) {
          main.setSize(width, height); // native main-process resize, never CSS/DOM viewport emulation
          await sleep(350);
          const layout = await main.webContents.executeJavaScript(`(async () => {
            const pause = (ms) => new Promise((r) => setTimeout(r, ms));
            document.querySelector('[data-view=plan]').click();
            const settings = document.querySelector('details.settings'), summary = settings.querySelector('summary');
            if (settings.open) summary.click();
            await pause(100);
            const measure = () => {
              const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
              return { root: rect(document.getElementById('app')), list: rect(document.getElementById('task-list')),
                task: rect(document.querySelector('#task-list li.task')), entry: rect(document.getElementById('add-entry')) };
            };
            const baseline = measure();
            const rootFits = () => document.documentElement.scrollWidth <= innerWidth + 1 &&
              document.documentElement.scrollHeight <= innerHeight + 1 && document.body.scrollWidth <= innerWidth + 1 &&
              document.body.scrollHeight <= innerHeight + 1 && document.scrollingElement.scrollTop === 0 &&
              document.scrollingElement.scrollLeft === 0;
            summary.click(); await pause(150);
            const opened = measure(), pop = settings.querySelector('.settings-pop');
            const same = (a, b) => Object.keys(a).every((k) => Math.abs(a[k] - b[k]) <= 1);
            const stable = Object.keys(baseline).every((k) => same(baseline[k], opened[k]));
            const p = pop.getBoundingClientRect(), s = summary.getBoundingClientRect();
            const scrollStyle = getComputedStyle(pop, '::-webkit-scrollbar');
            const thumbStyle = getComputedStyle(pop, '::-webkit-scrollbar-thumb');
            // CI's pointer can rest on the gutter, which is the same palette's hover tint.
            const thumbOK = (c) => c === 'rgb(72, 82, 99)' || c === 'rgb(113, 129, 153)';
            const customScrollbars = parseFloat(scrollStyle.width) === 10 && scrollStyle.display !== 'none' &&
              thumbOK(thumbStyle.backgroundColor) && parseFloat(thumbStyle.borderRadius) >= 20 &&
              getComputedStyle(pop).scrollbarGutter === 'stable';
            const bounded = settings.open && p.left >= 0 && p.right <= innerWidth + 1 &&
              p.top >= s.bottom && p.bottom <= innerHeight - 8 && getComputedStyle(pop).overflowY === 'auto' &&
              pop.scrollWidth <= pop.clientWidth + 1;
            const controls = [...pop.querySelectorAll('input, select, textarea, button')];
            const reached = [];
            const view = document.getElementById('view-plan'), viewScroll = view.scrollTop;
            for (const control of controls) {
              control.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
              const c = control.getBoundingClientRect(), r = pop.getBoundingClientRect();
              reached.push(c.width > 0 && c.height > 0 && c.left >= r.left && c.right <= r.right &&
                c.top >= r.top && c.bottom <= r.bottom);
            }
            const ownScroll = (pop.scrollHeight <= pop.clientHeight + 1 || pop.scrollTop > 0) &&
              view.scrollTop === viewScroll && rootFits();
            const reachable = controls.length > 20 && reached.every(Boolean) &&
              controls.some((c) => c.id === 'set-start') && controls.some((c) => c.id === 'llm-test');
            summary.click(); await pause(100);
            const closed = measure();
            const closesStable = Object.keys(baseline).every((k) => same(baseline[k], closed[k])) && rootFits();
            document.querySelector('[data-view=viz]').click();
            document.querySelector('[data-viz=week]').click(); await pause(700);
            const row = document.getElementById('week-summary-row'), cells = [...row.querySelectorAll('.cell')];
            if (row.dataset.expanded === 'true') cells[0].click();
            const defaults = cells.every((c) => Math.abs(c.getBoundingClientRect().height - 112) <= 1);
            cells[0].click();
            const cap = Math.min(320, Math.max(180, innerHeight * 0.36));
            const capOK = row.dataset.expanded === 'true' && cells.length === 7 && cells.every((c) =>
              Math.abs(c.getBoundingClientRect().height - cap) <= 1 && getComputedStyle(c).overflowY === 'auto') &&
              Math.abs(row.getBoundingClientRect().height - cap) <= 1 && rootFits();
            const canvas = document.getElementById('timeline'), header = document.getElementById('week-header');
            const cr = canvas.getBoundingClientRect(), hr = header.getBoundingClientRect();
            const aligned = Math.abs(cr.width - hr.width) <= 1 && Math.abs(cr.left - hr.left) <= 1 &&
              Math.abs(canvas.width - canvas.clientWidth * devicePixelRatio) <= 1;
            return { stable, bounded, ownScroll, reachable, closesStable, defaults, capOK, aligned, customScrollbars,
              hover: [...document.querySelectorAll(':hover')].slice(-4).map((e) => e.id || e.className || e.tagName),
              scrollbarStyle: { width: scrollStyle.width, display: scrollStyle.display, color: thumbStyle.backgroundColor,
                radius: thumbStyle.borderRadius, gutter: getComputedStyle(pop).scrollbarGutter },
              viewport: [innerWidth, innerHeight], cap, baseline, opened, controls: controls.length,
              unreachable: controls.filter((c, i) => !reached[i]).map((c) => c.id) };
          })()`);
          check(`settings ${width}x${height}: opening/closing preserves root/task geometry without root scroll`,
            layout.stable && layout.closesStable, JSON.stringify(layout));
          check(`settings ${width}x${height}: bounded own scrolling reaches every control`,
            layout.bounded && layout.ownScroll && layout.reachable, JSON.stringify(layout));
          check(`settings ${width}x${height}: custom dark scrollbar preserves its reserved gutter`,
            layout.customScrollbars, JSON.stringify(layout));
          check(`week ${width}x${height}: equal 112px default, expanded 180/36vh/320 clamp and aligned canvas`,
            layout.defaults && layout.capOK && layout.aligned, JSON.stringify(layout));
        }
      } finally {
        main.setBounds(originalBounds);
        await sleep(350);
        await main.webContents.executeJavaScript(`(() => {
          const settings = document.querySelector('details.settings');
          if (settings.open) settings.querySelector('summary').click();
          document.querySelector('[data-view=viz]').click();
          document.querySelector('[data-viz=day]').click();
          return true;
        })()`);
      }
    } catch (e) {
      check('week summary/header UI contract completes', false, e.stack || String(e));
    } finally {
      previous.forEach(([key, summary]) => store.putSummary(key, summary));
      store.flush();
      await win.webContents.executeJavaScript(`document.querySelector('[data-viz=day]').click(), true`);
    }
  }

  // frozen hours: a past day's bounds survive a global work-end change. The
  // freeze only applies to days that actually lived under their hours, so a
  // fresh profile needs yesterday's record seeded first.
  {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const p = (x) => String(x).padStart(2, '0');
    const yKey = `${y.getFullYear()}-${p(y.getMonth() + 1)}-${p(y.getDate())}`;
    const own = { workStart: store.settings.workStart, workEnd: store.settings.workEnd };
    store.updateDay(yKey, (d) => { d.hours = d.hours || own; });
    store.flush();
  }
  const frozen = await win.webContents.executeJavaScript(`(async () => {
    const today = (await shapeday.call('day:get')).date;
    const y = new Date(today + 'T00:00:00'); y.setDate(y.getDate() - 1);
    const p = (x) => String(x).padStart(2, '0');
    const yKey = y.getFullYear() + '-' + p(y.getMonth() + 1) + '-' + p(y.getDate());
    const before = (await shapeday.call('viz:day', { date: yKey })).bounds;
    await shapeday.call('settings:set', { workEnd: '23:30' });
    const after = (await shapeday.call('viz:day', { date: yKey })).bounds;
    await shapeday.call('settings:set', { workEnd: '17:00' });
    return { ok: before.end === after.end, why: before.end + ' vs ' + after.end };
  })()`);
  check('past day keeps its work hours after a settings change', frozen.ok === true, frozen.why);

  // period arrows: month next re-centers the grid; day prev navigates
  const nav = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-view=viz]').click();
    document.querySelector('[data-viz=month]').click();
    await new Promise((r) => setTimeout(r, 700));
    const canvas = document.getElementById('timeline');
    const m0 = (canvas._hits || []).length;
    document.getElementById('viz-next').click();
    await new Promise((r) => setTimeout(r, 700));
    const month2 = await shapeday.call('viz:days', { scope: 'month', anchor: window.__navProbe });
    // verify via the rendered grid: hits should re-center (dates differ)
    const h0 = (canvas._hits || [])[0];
    const moved = !!(canvas._hits || []).length;
    document.getElementById('viz-prev').click();
    await new Promise((r) => setTimeout(r, 700));
    const back = (canvas._hits || []).length > 0;
    // day scope: prev shows the chip
    document.querySelector('[data-viz=day]').click();
    await new Promise((r) => setTimeout(r, 600));
    const before = document.getElementById('day-pick').hidden;
    document.getElementById('viz-prev').click();
    await new Promise((r) => setTimeout(r, 900));
    const chip = document.getElementById('day-pick');
    const chipShown = chip && !chip.hidden;
    document.getElementById('viz-next').click(); // back to today
    await new Promise((r) => setTimeout(r, 900));
    return { ok: moved && back && before && chipShown && chip.hidden, why: 'moved=' + moved + ' back=' + back + ' chip=' + chipShown };
  })()`);
  check('arrows step month and day periods', nav.ok === true, JSON.stringify(nav));

  // i18n: switch to zh-hans, tabs translate; back to auto restores English
  const i18n = await win.webContents.executeJavaScript(`(async () => {
    await shapeday.call('settings:set', { locale: 'zh-hans' });
    await new Promise((r) => setTimeout(r, 900));
    const zh = [...document.querySelectorAll('nav.tabs button')].map((b) => b.textContent);
    const ph = document.getElementById('add-input').placeholder;
    const legend = [...document.querySelectorAll('.legend span')].map((x) => x.textContent).join('|');
    const dayLabel = (document.querySelector('#week-summaries .cell .day-label') || {}).textContent || '';
    const stat = document.querySelector('#st-done') && document.querySelector('[data-i18n="viz.stats.done"]')?.textContent;
    const dateRow = document.getElementById('hd-day').textContent;
    await shapeday.call('settings:set', { locale: 'auto' });
    await new Promise((r) => setTimeout(r, 900));
    const en = [...document.querySelectorAll('nav.tabs button')].map((b) => b.textContent);
    return {
      ok: zh.join(',').includes('计划') && ph.includes('有什么') && en.join(',').includes('Plan') &&
        legend.includes('工作中') && stat === '任务完成数' && /[一二三四五六七]月|周/.test(dateRow) &&
        !dayLabel.includes('=>') && !dayLabel.includes('T('),
      why: zh.join('|') + ' / ' + ph + ' / ' + legend + ' / ' + dateRow,
    };
  })()`);
  check('locale switch translates the UI and restores', i18n.ok === true, JSON.stringify(i18n));

  check('month and year report scopes work',
    repMonth.metrics && repYear.metrics && typeof repMonth.templated === 'string');

  // Actual recurring UI + manual-break + historical-summary regressions.
  // Keep this isolated from the earlier workload and from tray restore below.
  {
    const before = await call('day:get');
    const savedDay = JSON.parse(JSON.stringify(before.day));
    const savedRules = JSON.parse(JSON.stringify(store.recurring));
    const savedSettings = {
      locale: before.settings.locale, autoAdvance: before.settings.autoAdvance,
      overlayStyle: before.settings.overlayStyle, overlayEnabled: before.settings.overlayEnabled,
      summaryMode: before.settings.summaryMode,
    };
    const yesterday = new Date(before.date + 'T00:00:00');
    yesterday.setDate(yesterday.getDate() - 1);
    const pad = (n) => String(n).padStart(2, '0');
    const pastDate = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;
    const savedPast = JSON.parse(JSON.stringify(store.day(pastDate)));
    // This date already exists from the frozen-hours regression above.
    const probeUI = (body) => win.webContents.executeJavaScript(`(async () => {
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (read, label) => {
        for (let i = 0; i < 80; i++) {
          const value = await read();
          if (value) return value;
          await pause(50);
        }
        throw new Error('Timed out: ' + label);
      };
      const visible = (el) => !!el && el.getClientRects().length > 0 &&
        getComputedStyle(el).visibility === 'visible' && getComputedStyle(el).opacity !== '0';
      ${body}
    })()`);
    try {
      await call('break:end');
      await call('break:respond', { accept: false });
      store.updateRecurring((rules) => rules.splice(0));
      await call('day:clear');
      await call('settings:set', {
        locale: 'en-us', autoAdvance: true, overlayStyle: 'top', overlayEnabled: true,
        summaryMode: 'template',
      });
      await sleep(1200);
      const helperProbe = await probeUI(`
        document.querySelector('[data-view=plan]').click();
        const input = document.getElementById('add-input');
        input.focus();
        input.value = 'Stretch each: ';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const tag = await waitFor(() => document.querySelector('#add-entry .each-tag'), 'auto inline tag');
        const frequency = tag.querySelector('.each-value');
        const helper = await waitFor(() => document.querySelector('.each-help:popover-open'), 'visible helper');
        const rect = (el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
        };
        const above = (a, b) => a.bottom <= b.top && a.left < b.right && a.right > b.left;
        const full = rect(helper), tagRect = rect(tag);
        const kbd = helper.querySelector('kbd');
        const bg = getComputedStyle(helper).backgroundColor;
        const alpha = Number(bg.match(/rgba\\([^)]*,\\s*([\\d.]+)\\)$/)?.[1]);
        const helperOpacity = Number(getComputedStyle(helper).opacity);
        const kbdStyle = getComputedStyle(kbd);
        const fullOK = visible(tag) && visible(helper) && document.activeElement === frequency &&
          input.value === 'Stretch' && frequency.value === '' && above(full, tagRect) && alpha === 0.5 &&
          helper.firstElementChild.textContent.includes('w|d|h|m|s|day|week') &&
          kbd.textContent === 'tab' && !helper.textContent.includes('[tab]') &&
          Number(kbdStyle.opacity) < helperOpacity && parseFloat(kbdStyle.borderTopWidth) > 0 &&
          parseFloat(kbdStyle.borderRadius) > 0 && visible(helper.querySelector('.each-help-more')) &&
          helper.textContent.includes('w = week; d = day; h = hour; m = min; s = sec') &&
          helper.textContent.includes('each: day') && helper.textContent.includes('each: 1d') &&
          helper.textContent.includes('each: week') && helper.textContent.includes('each: 1w');
        frequency.value = 'day';
        frequency.dispatchEvent(new Event('input', { bubbles: true }));
        const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        frequency.dispatchEvent(tab);
        await pause(100);
        const s = await shapeday.call('day:get');
        const confirmed = tab.defaultPrevented && tag.textContent === 'each: 1d' &&
          !tag.querySelector('input') && document.activeElement === document.querySelector('#add-entry .each-tail') &&
          !document.querySelector('.each-help:popover-open') && s.day.tasks.length === 0 && s.recurring.length === 0;
        return { fullOK, confirmed, alpha, full, tagRect, bg };
      `);
      check('recurring add input auto-tags with half-alpha helper above and outlined dim Tab',
        helperProbe.fullOK, JSON.stringify(helperProbe));
      check('recurring full-default helper Tab confirms token and focuses tail without adding task',
        helperProbe.confirmed, JSON.stringify(helperProbe));

      const addKeys = await probeUI(`
        const input = document.getElementById('add-input'), entry = document.getElementById('add-entry');
        const key = (el, name) => {
          const e = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
          el.dispatchEvent(e); return e.defaultPrevented;
        };
        let tag = entry.querySelector('.each-tag');
        tag.click();
        let field = tag.querySelector('input');
        field.value = '2h'; field.dispatchEvent(new Event('input', { bubbles: true }));
        const esc = key(field, 'Escape');
        const valid = esc && tag.textContent === 'each: 2h' && !tag.querySelector('input') &&
          document.activeElement === entry.querySelector('.each-tail') && !document.querySelector('.each-help:popover-open');
        tag.click(); field = tag.querySelector('input');
        field.value = 'nonsense'; field.dispatchEvent(new Event('input', { bubbles: true }));
        key(field, 'Escape');
        const restored = tag.textContent === 'each: 2h' && !tag.querySelector('input') &&
          document.activeElement === entry.querySelector('.each-tail') && !document.querySelector('.each-help:popover-open');
        const tail = entry.querySelector('.each-tail'); tail.value = 'after'; tail.setSelectionRange(0, 0);
        const tailRemoved = key(tail, 'Backspace') && !entry.querySelector('.each-tag') &&
          input.value === 'Stretch after' && document.activeElement === input && input.selectionStart === 'Stretch'.length;
        input.value = 'Stretch each: invalid'; input.dispatchEvent(new Event('input', { bubbles: true }));
        key(entry.querySelector('.each-value'), 'Escape');
        const invalid = !entry.querySelector('.each-tag') && input.value === 'Stretch' &&
          document.activeElement === input && !document.querySelector('.each-help:popover-open');
        input.value = 'Stretch each: day'; input.dispatchEvent(new Event('input', { bubbles: true }));
        field = entry.querySelector('.each-value'); field.setSelectionRange(0, 0);
        const caretRemoved = key(field, 'Backspace') && !entry.querySelector('.each-tag') && input.value === 'Stretch';
        input.value = 'Stretch each: day'; input.dispatchEvent(new Event('input', { bubbles: true }));
        key(entry.querySelector('.each-value'), 'Tab');
        tag = entry.querySelector('.each-tag'); tag.focus();
        const deleteRemoved = key(tag, 'Delete') && !entry.querySelector('.each-tag') && input.value === 'Stretch';
        input.value = 'Stretch each: day'; input.dispatchEvent(new Event('input', { bubbles: true }));
        field = entry.querySelector('.each-value'); field.select();
        const s = await shapeday.call('day:get');
        return { valid, restored, tailRemoved, invalid, caretRemoved, deleteRemoved,
          noSubmit: s.day.tasks.length === 0 && s.recurring.length === 0 };
      `);
      check('add Esc applies valid frequency and invalid Esc restores prior token without a focus trap',
        addKeys.valid && addKeys.restored && addKeys.invalid && addKeys.noSubmit, JSON.stringify(addKeys));
      check('add tail Backspace, tag Delete and frequency caret-zero Backspace remove token preserving text',
        addKeys.tailRemoved && addKeys.deleteRemoved && addKeys.caretRemoved, JSON.stringify(addKeys));
      // Native keyboard deletion exercises the browser default action, not a synthetic DOM mutation.
      win.focus();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
      const selectedDelete = await probeUI(`
        const entry = document.getElementById('add-entry');
        const field = await waitFor(() => entry.querySelector('.each-value')?.value === '' &&
          entry.querySelector('.each-value'), 'native Backspace clears selected frequency');
        const cleared = !!entry.querySelector('.each-tag') && document.activeElement === field;
        return { cleared, caret: field.selectionStart, end: field.selectionEnd };
      `);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
      const emptyDelete = await probeUI(`
        await waitFor(() => !document.querySelector('#add-entry .each-tag'), 'second Backspace deletes token');
        const input = document.getElementById('add-input');
        const removed = input.value === 'Stretch' && document.activeElement === input &&
          !document.querySelector('.each-help:popover-open');
        input.value = 'Stretch each: day'; input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#add-entry .each-value').dispatchEvent(new KeyboardEvent('keydown',
          { key: 'Tab', bubbles: true, cancelable: true }));
        return removed;
      `);
      check('selected frequency Backspace clears value first, next Backspace removes tag',
        selectedDelete.cleared && selectedDelete.caret === 0 && selectedDelete.end === 0 && emptyDelete,
        JSON.stringify(selectedDelete));

      const added = await probeUI(`
        document.querySelector('#add-entry .each-tag').click();
        const frequency = await waitFor(() => document.querySelector('#add-entry .each-value'), 'reopened add tag');
        frequency.value = '1h';
        frequency.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('add-btn').click();
        const s = await waitFor(async () => {
          const s = await shapeday.call('day:get');
          return s.day.tasks.length === 1 && s.recurring.length === 1 ? s : null;
        }, 'one recurring task');
        const row = await waitFor(() => [...document.querySelectorAll('#task-list li.task')]
          .find((r) => r.querySelector('.title')?.textContent === 'Stretch' && r.querySelector('.each-chip')), 'recurring row');
        const chip = row.querySelector('.each-chip'), minutes = row.querySelector('.chip');
        const cr = chip.getBoundingClientRect(), mr = minutes.getBoundingClientRect();
        const badge = document.getElementById('recurring-count');
        const rule = s.recurring[0], task = s.day.tasks[0];
        return { id: task.id, ruleId: rule.id, title: task.title,
          ok: task.title === 'Stretch' && task.recurringId === rule.id && rule.title === 'Stretch' &&
            rule.every === 1 && rule.unit === 'h' && visible(badge) && badge.textContent === '1' &&
            chip.textContent === 'each: 1h' && visible(row.querySelector('.mins')) &&
            cr.right <= mr.left + 1 && mr.left - cr.right <= 24 && row.lastElementChild === minutes &&
            !document.querySelector('#add-entry .each-tag'),
          chipRight: cr.right, minutesLeft: mr.left };
      `);
      check('recurring UI add persists clean title and one badge; frequency precedes rightmost minutes',
        added.ok, JSON.stringify(added));
      const edited = await probeUI(`
        const id = ${JSON.stringify(added.id)}, ruleId = ${JSON.stringify(added.ruleId)};
        document.querySelector('#task-list .each-chip').click();
        const input = await waitFor(() => document.querySelector('#task-list .each-chip .each-value'), 'chip editor');
        input.value = '2m';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        const s = await waitFor(async () => {
          const s = await shapeday.call('day:get');
          const r = s.recurring.find((r) => r.id === ruleId);
          return r?.every === 2 && r.unit === 'm' &&
            document.querySelector('#task-list .each-chip')?.textContent === 'each: 2m' &&
            !document.querySelector('#task-list .each-chip input') ? s : null;
        }, 'committed 2m chip');
        return { ok: s.day.tasks.find((t) => t.id === id)?.recurringId === ruleId &&
          s.day.tasks[0].title === 'Stretch', rule: s.recurring.find((r) => r.id === ruleId) };
      `);
      check('recurring frequency chip inline Enter persists 2m on the same rule', edited.ok, JSON.stringify(edited));
      const chipKeys = await probeUI(`
        const ruleId = ${JSON.stringify(added.ruleId)};
        const key = (el, name) => el.dispatchEvent(new KeyboardEvent('keydown',
          { key: name, bubbles: true, cancelable: true }));
        const readRule = async () => (await shapeday.call('day:get')).recurring.find((r) => r.id === ruleId);
        const original = await readRule();
        document.querySelector('#task-list .each-chip').click();
        let field = await waitFor(() => document.querySelector('#task-list .each-chip input'), 'invalid chip editor');
        field.value = 'invalid'; key(field, 'Escape');
        await waitFor(() => !document.querySelector('#task-list .each-chip input'), 'invalid Esc cancels chip');
        const canceled = JSON.stringify(await readRule()) === JSON.stringify(original) &&
          document.querySelector('#task-list .each-chip').textContent === 'each: 2m' &&
          !document.querySelector('.each-help:popover-open');
        const outcomes = [];
        for (const [name, value, every] of [['Escape', '3m', 3], ['Tab', '4m', 4]]) {
          document.querySelector('#task-list .each-chip').click();
          field = await waitFor(() => document.querySelector('#task-list .each-chip input'), 'valid chip editor');
          const full = visible(document.querySelector('.each-help:popover-open .each-help-more'));
          field.value = value; key(field, name);
          const r = await waitFor(async () => {
            const r = await readRule();
            return r?.every === every && r.unit === 'm' &&
              !document.querySelector('#task-list .each-chip input') ? r : null;
          }, name + ' persists chip');
          outcomes.push(full && r.id === ruleId && document.querySelector('#task-list .each-chip').textContent === 'each: ' + value &&
            !document.querySelector('.each-help:popover-open'));
        }
        // A no-op confirmation must not restart the offline interval anchor.
        const anchor = await readRule();
        document.querySelector('#task-list .each-chip').click();
        field = await waitFor(() => document.querySelector('#task-list .each-chip input'), 'no-op chip editor');
        key(field, 'Escape');
        await waitFor(() => !document.querySelector('#task-list .each-chip input'), 'no-op chip closed');
        const unchanged = await readRule();
        return { canceled, valid: outcomes.every(Boolean), anchorStable: anchor.nextAt === unchanged.nextAt &&
          anchor.nextDate === unchanged.nextDate, anchor, unchanged };
      `);
      check('saved each chip invalid Esc cancels; valid Esc/Tab persist and close full helper',
        chipKeys.canceled && chipKeys.valid, JSON.stringify(chipKeys));
      check('saved each chip no-op Esc preserves offline recurrence anchor', chipKeys.anchorStable, JSON.stringify(chipKeys));
      const descriptionKeys = await probeUI(`
        const id = ${JSON.stringify(added.id)}, ruleId = ${JSON.stringify(added.ruleId)};
        const outcomes = [];
        for (const [name, frequency, every] of [['Escape', '5h', 5], ['Tab', '6h', 6]]) {
          const prior = (await shapeday.call('day:get')).day.tasks.find((t) => t.id === id).title;
          document.querySelector('#task-list .title').click();
          const box = await waitFor(() => document.querySelector('#task-list .title-edit'), 'description editor');
          const draft = 'Description ' + name;
          box.value = draft + ' each: ' + frequency;
          box.dispatchEvent(new Event('input', { bubbles: true }));
          const tag = document.querySelector('#task-list .title-entry .each-tag');
          const full = visible(document.querySelector('.each-help:popover-open .each-help-more'));
          const e = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
          tag.querySelector('input').dispatchEvent(e);
          const s = await waitFor(async () => {
            const s = await shapeday.call('day:get'), r = s.recurring.find((r) => r.id === ruleId);
            return r?.every === every && r.unit === 'h' ? s : null;
          }, name + ' immediately persists frequency without title submission');
          const inline = e.defaultPrevented && full && box.isConnected && box.value === draft &&
            tag.textContent === 'each: ' + frequency && !tag.querySelector('input') &&
            document.activeElement === document.querySelector('#task-list .title-entry .each-tail') &&
            s.day.tasks.find((t) => t.id === id).title === prior && !document.querySelector('.each-help:popover-open');
          document.getElementById('add-input').focus();
          const committed = await waitFor(async () => {
            const s = await shapeday.call('day:get');
            return s.day.tasks.find((t) => t.id === id)?.title === draft &&
              !document.querySelector('#task-list .title-edit') ? s : null;
          }, 'blur commits description cleanly');
          const r = committed.recurring.find((r) => r.id === ruleId);
          outcomes.push({ name, inline, clean: r.title === draft && r.every === every && r.unit === 'h' &&
            document.querySelector('#task-list .each-chip').textContent === 'each: ' + frequency });
        }
        document.querySelector('#task-list .title').click();
        const box = await waitFor(() => document.querySelector('#task-list .title-edit'), 'full Enter title editor');
        box.value = 'Enter clean title each: week'; box.dispatchEvent(new Event('input', { bubbles: true }));
        const full = visible(document.querySelector('.each-help:popover-open .each-help-more'));
        document.querySelector('#task-list .title-entry .each-value').dispatchEvent(new KeyboardEvent('keydown',
          { key: 'Enter', bubbles: true, cancelable: true }));
        const s = await waitFor(async () => {
          const s = await shapeday.call('day:get');
          return s.day.tasks.find((t) => t.id === id)?.title === 'Enter clean title' &&
            !document.querySelector('#task-list .title-edit') ? s : null;
        }, 'full title Enter submits clean');
        const r = s.recurring.find((r) => r.id === ruleId);
        return { outcomes, enter: full && r.every === 1 && r.unit === 'w' && r.title === 'Enter clean title' &&
          s.day.tasks.length === 1 && !document.querySelector('#task-list .title .each-tag') &&
          !document.querySelector('.each-help:popover-open') };
      `);
      check('description Esc/Tab confirm inline, focus tail and persist shared frequency before clean blur',
        descriptionKeys.outcomes.every((r) => r.inline && r.clean), JSON.stringify(descriptionKeys));
      check('title full-form Enter remains compatible and submits a clean title', descriptionKeys.enter, JSON.stringify(descriptionKeys));
      const titleRegressions = await probeUI(`
        const key = (el, name) => el.dispatchEvent(new KeyboardEvent('keydown',
          { key: name, bubbles: true, cancelable: true }));
        const read = () => shapeday.call('day:get');
        const input = document.getElementById('add-input'), entry = document.getElementById('add-entry');
        const baseline = await read();
        const unchanged = (s, prior) => JSON.stringify(s.day.tasks) === JSON.stringify(prior.day.tasks) &&
          JSON.stringify(s.recurring) === JSON.stringify(prior.recurring);
        let id;
        const out = {};
        try {
          input.focus();
          input.value = 'Invalid add regression each: invalid';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          let field = await waitFor(() => entry.querySelector('.each-value'), 'invalid add frequency');
          key(field, 'Enter');
          await pause(200);
          out.invalidAddEnter = unchanged(await read(), baseline) && input.value === 'Invalid add regression' &&
            entry.querySelector('.each-value')?.value === 'invalid';
          key(input, 'Enter');
          await pause(200);
          out.invalidAddEnter = out.invalidAddEnter && unchanged(await read(), baseline);
          key(entry.querySelector('.each-value'), 'Escape');
          out.invalidAddEscape = unchanged(await read(), baseline) && !entry.querySelector('.each-tag') &&
            input.value === 'Invalid add regression' && document.activeElement === input &&
            !document.querySelector('.each-help:popover-open');
          addEditor.reset();

          const temporary = await shapeday.call('task:add', { title: 'Title regression each: week' });
          id = temporary.task.id;
          const row = () => document.querySelectorAll('#task-list li.task')[baseline.day.tasks.length];
          const edit = async (title, frequency) => {
            const r = await waitFor(row, 'temporary recurring row');
            r.querySelector('.title').click();
            const box = await waitFor(() => row()?.querySelector('.title-edit'), 'temporary title editor');
            box.value = title + ' each: ' + frequency;
            box.dispatchEvent(new Event('input', { bubbles: true }));
            await waitFor(() => row()?.querySelector('.title-entry .each-value'), 'temporary inline frequency');
            return box;
          };
          const committed = (title) => waitFor(async () => {
            const s = await read(), task = s.day.tasks.find((t) => t.id === id);
            return task?.title === title && !row()?.querySelector('.title-edit') ? s : null;
          }, 'temporary title committed: ' + title);

          let box = await edit('Confirmed Enter title', '2w');
          key(row().querySelector('.each-value'), 'Tab');
          const confirmed = await waitFor(async () => {
            const s = await read(), task = s.day.tasks.find((t) => t.id === id);
            const rule = s.recurring.find((r) => r.id === task?.recurringId);
            return rule?.every === 2 && rule.unit === 'w' && !row()?.querySelector('.each-tag input') ? s : null;
          }, 'confirmed temporary title tag');
          const ruleId = confirmed.day.tasks.find((t) => t.id === id).recurringId;
          box.focus();
          key(box, 'Enter');
          let s = await committed('Confirmed Enter title');
          let rule = s.recurring.find((r) => r.id === ruleId);
          out.confirmedTitleEnter = rule?.title === 'Confirmed Enter title' && rule.every === 2 && rule.unit === 'w' &&
            s.day.tasks.find((t) => t.id === id).recurringId === ruleId &&
            !row().querySelector('.each-value') && !document.querySelector('.each-help:popover-open');

          box = await edit('Escape saved title', '3w');
          key(row().querySelector('.each-value'), 'Tab');
          await waitFor(() => !row()?.querySelector('.each-tag input'), 'Esc title tag confirmed');
          box.focus();
          key(box, 'Escape');
          s = await committed('Escape saved title');
          rule = s.recurring.find((r) => r.id === ruleId);
          out.titleEscape = rule?.title === 'Escape saved title' && rule.every === 3 && rule.unit === 'w' &&
            s.day.tasks.find((t) => t.id === id).recurringId === ruleId;

          box = await edit('Escape saved title', '4w');
          key(row().querySelector('.each-value'), 'Tab');
          s = await waitFor(async () => {
            const s = await read(), rule = s.recurring.find((r) => r.id === ruleId);
            return rule?.every === 4 && rule.unit === 'w' && !row()?.querySelector('.each-tag input') ? s : null;
          }, 'inline Tab persists shared rule before removal');
          out.inlineTab = box.isConnected && s.day.tasks.find((t) => t.id === id).recurringId === ruleId &&
            document.activeElement === row().querySelector('.each-tail');
          const tail = row().querySelector('.each-tail');
          tail.value = ''; tail.setSelectionRange(0, 0);
          key(tail, 'Backspace');
          s = await waitFor(async () => {
            const s = await read();
            return !s.recurring.some((r) => r.id === ruleId) &&
              !s.day.tasks.some((t) => t.recurringId === ruleId) &&
              !row()?.querySelector('.each-tag, .each-chip') ? s : null;
          }, 'tail Backspace removes shared recurrence');
          out.tailStopsRecurring = !row().querySelector('.each-tag') && !row().querySelector('.each-chip') &&
            s.day.tasks.find((t) => t.id === id)?.title === 'Escape saved title';
          box.focus(); key(box, 'Escape');
          await committed('Escape saved title');

          // Start a fresh each token on the same temporary task for the invalid-title regression.
          box = await edit('Escape saved title', 'week');
          key(row().querySelector('.each-value'), 'Tab');
          const restored = await waitFor(async () => {
            const s = await read(), task = s.day.tasks.find((t) => t.id === id);
            const rule = s.recurring.find((r) => r.id === task?.recurringId);
            return rule?.every === 1 && rule.unit === 'w' && !row()?.querySelector('.each-tag input') ? s : null;
          }, 'fresh each token restores temporary recurrence');
          const restoredRuleId = restored.day.tasks.find((t) => t.id === id).recurringId;
          box.focus(); key(box, 'Escape');
          await committed('Escape saved title');
          const prior = await read();
          box = await edit('Invalid description draft', 'invalid');
          field = row().querySelector('.each-value');
          key(field, 'Enter');
          await pause(200);
          out.invalidDescriptionEnter = unchanged(await read(), prior) && box.isConnected &&
            box.value === 'Invalid description draft' && row().querySelector('.each-value')?.value === 'invalid';
          key(box, 'Enter');
          await pause(200);
          out.invalidDescriptionEnter = out.invalidDescriptionEnter && unchanged(await read(), prior) && box.isConnected;
          key(row().querySelector('.each-value'), 'Escape');
          await waitFor(() => !row()?.querySelector('.each-tag input'), 'invalid description Esc closes frequency');
          out.invalidDescriptionEscape = unchanged(await read(), prior) && box.isConnected &&
            row().querySelector('.each-tag')?.textContent === 'each: 1w' &&
            !document.querySelector('.each-help:popover-open');
          box.value = 'Escape saved title';
          box.dispatchEvent(new Event('input', { bubbles: true }));
          box.focus(); key(box, 'Escape');
          s = await committed('Escape saved title');
          rule = s.recurring.find((r) => r.id === restoredRuleId);
          out.invalidDescriptionEscape = out.invalidDescriptionEscape && rule?.title === 'Escape saved title' &&
            rule.every === 1 && rule.unit === 'w' && s.day.tasks.find((t) => t.id === id).recurringId === restoredRuleId;
          return out;
        } finally {
          addEditor.reset();
          if (id) {
            const s = await read(), task = s.day.tasks.find((t) => t.id === id);
            if (task?.recurringId) await shapeday.call('recurring:delete', { id: task.recurringId });
            await shapeday.call('task:delete', { id });
            await waitFor(() => !document.querySelector('#task-list .title-edit'), 'temporary editor cleaned up');
          }
          input.focus();
        }
      `);
      check('confirmed title tag Enter submits the clean title and closes the editor',
        titleRegressions.confirmedTitleEnter, JSON.stringify(titleRegressions));
      check('title Escape saves the valid clean title and shared recurrence',
        titleRegressions.titleEscape, JSON.stringify(titleRegressions));
      check('title inline Tab persists frequency; tail Backspace removes the shared rule and stops recurring',
        titleRegressions.inlineTab && titleRegressions.tailStopsRecurring, JSON.stringify(titleRegressions));
      check('invalid add Enter preserves tasks and rules; Escape cleans the input token',
        titleRegressions.invalidAddEnter && titleRegressions.invalidAddEscape, JSON.stringify(titleRegressions));
      check('invalid description Enter preserves title and recurrence; Escape safely restores and dismisses',
        titleRegressions.invalidDescriptionEnter && titleRegressions.invalidDescriptionEscape, JSON.stringify(titleRegressions));
      const renamed = await probeUI(`
        document.querySelector('#task-list .title').click();
        const input = await waitFor(() => document.querySelector('#task-list .title-edit'), 'title editor');
        input.value = 'New title each: day';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const tag = await waitFor(() => document.querySelector('#task-list .title-entry .each-tag'), 'title inline tag');
        await pause(1200); // a real snapshot tick must not destroy the focused inline tag
        const draftFocused = tag.isConnected && visible(tag) && document.activeElement === tag.querySelector('.each-value') &&
          input.value === 'New title' && tag.querySelector('.each-value')?.value === 'day' &&
          document.querySelector('#task-list .each-chip').textContent === 'each: 1d';
        tag.querySelector('.each-value').dispatchEvent(new KeyboardEvent('keydown',
          { key: 'Tab', bubbles: true, cancelable: true }));
        const confirmed = await waitFor(async () => {
          const s = await shapeday.call('day:get');
          return s.recurring.find((r) => r.id === ${JSON.stringify(added.ruleId)})?.unit === 'd' ? s : null;
        }, 'title Tab persists day rule before blur');
        const focused = draftFocused && tag.isConnected && !tag.querySelector('input') &&
          tag.textContent === 'each: 1d' && document.activeElement === document.querySelector('#task-list .each-tail') &&
          confirmed.day.tasks[0].title === 'Enter clean title';
        document.getElementById('add-input').focus(); // real focusout submits the clean title after tag confirmation
        const s = await waitFor(async () => {
          const s = await shapeday.call('day:get');
          return s.day.tasks[0]?.title === 'New title' && !document.querySelector('#task-list .title-edit') &&
            document.querySelector('#task-list .title')?.textContent === 'New title' ? s : null;
        }, 'blur commits clean title');
        const rule = s.recurring.find((r) => r.id === ${JSON.stringify(added.ruleId)});
        return { focused, clean: !document.querySelector('#task-list .title .each-tag') &&
          !s.day.tasks[0].title.includes('each:') && s.day.tasks[0].recurringId === rule?.id &&
          rule?.title === 'New title' && rule.every === 1 && rule.unit === 'd' &&
          document.querySelector('#task-list .each-chip').textContent === 'each: 1d', rule };
      `);
      check('recurring title draft survives ticks; Tab confirms day rule and focuses tail without submitting title', renamed.focused, JSON.stringify(renamed));
      check('recurring title blur strips inline tag and shares normalized d rule', renamed.clean, JSON.stringify(renamed));
      const panel = await probeUI(`
        const button = document.getElementById('btn-recurring');
        button.scrollIntoView({ block: 'center' });
        button.click();
        const panel = await waitFor(() => document.querySelector('#recurring-panel:popover-open'), 'clock panel');
        const b = button.getBoundingClientRect(), p = panel.getBoundingClientRect();
        return { ok: visible(panel) && p.height > 0 && p.top >= b.bottom && p.left >= b.left - 1 &&
          p.right > b.right && button.getAttribute('aria-expanded') === 'true' &&
          panel.querySelectorAll('li').length === 1 && panel.querySelector('li span').textContent === 'New title' &&
          panel.querySelector('.recurring-frequency').textContent === 'each: 1d',
          button: { left: b.left, right: b.right, top: b.top, bottom: b.bottom },
          panel: { left: p.left, right: p.right, top: p.top, bottom: p.bottom } };
      `);
      check('recurring clock opens compact panel right/below the actual button, never above', panel.ok, JSON.stringify(panel));
      const estimates = await probeUI(`
        const id = ${JSON.stringify(added.id)}, ruleId = ${JSON.stringify(added.ruleId)};
        const read = () => shapeday.call('day:get');
        const row = () => [...document.querySelectorAll('#recurring-list li[data-recurring-id]')]
          .find((r) => r.dataset.recurringId === ruleId);
        const open = () => !!document.querySelector('#recurring-panel:popover-open');
        const initial = await read();
        const task = initial.day.tasks.find((t) => t.id === id);
        const rule = initial.recurring.find((r) => r.id === ruleId);
        const original = task.estimateMin;
        const changed = [41, 43, 47].find((minutes) => minutes !== original && minutes !== rule.estimateMin);
        const label = row()?.querySelector('.recurring-minutes');
        const buttons = [...(row()?.querySelectorAll('button') || [])];
        const initialOK = label?.textContent === rule.estimateMin + 'm' && visible(label) &&
          buttons.length === 1 && buttons[0].textContent === '×';
        await shapeday.call('task:setEstimate', { id, minutes: changed });
        await pause(1200);
        const edited = await read();
        const isolated = edited.day.tasks.find((t) => t.id === id)?.estimateMin === changed &&
          JSON.stringify(edited.recurring.find((r) => r.id === ruleId)) === JSON.stringify(rule) &&
          row()?.querySelector('.recurring-minutes')?.textContent === rule.estimateMin + 'm' && open();
        row().querySelector('.recurring-minutes').click();
        const input = await waitFor(() => row()?.querySelector('.recurring-minutes-edit'), 'rule minutes editor');
        const seeded = input.value === String(rule.estimateMin) && document.activeElement === input;
        input.value = '17';
        await pause(1200);
        const tick = input.isConnected && row().querySelector('.recurring-minutes-edit') === input &&
          document.activeElement === input && input.value === '17' && open();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await waitFor(() => !row()?.querySelector('.recurring-minutes-edit') &&
          row()?.querySelector('.recurring-minutes')?.textContent === '17m', 'Enter renders 17m');
        const committed = await read(), updated = committed.recurring.find((r) => r.id === ruleId);
        return { initial: initialOK, isolated, tick: seeded && tick, original, changed, nextAt: rule.nextAt,
          enter: updated?.estimateMin === 17 && updated.nextAt === rule.nextAt && open() &&
            committed.day.tasks.find((t) => t.id === id)?.estimateMin === changed };
      `);
      check('recurring panel minutes display rule estimate with only remove button', estimates.initial, JSON.stringify(estimates));
      check('main task estimate edit preserves future rule and open recurring panel', estimates.isolated, JSON.stringify(estimates));
      check('recurring minutes editor keeps focused draft across snapshot ticks', estimates.tick, JSON.stringify(estimates));
      check('recurring minutes Enter saves 17m and preserves existing main estimate and nextAt', estimates.enter, JSON.stringify(estimates));
      store.flush();
      const persistedEstimates = JSON.parse(fs.readFileSync(require('path').join(app.getPath('userData'), 'shapeday.json'), 'utf8'));
      check('recurring:setEstimate persists 17m independently of existing main task',
        persistedEstimates.recurring.find((r) => r.id === added.ruleId)?.estimateMin === 17 &&
          persistedEstimates.recurring.find((r) => r.id === added.ruleId)?.nextAt === estimates.nextAt &&
          persistedEstimates.days[before.date]?.tasks.find((t) => t.id === added.id)?.estimateMin === estimates.changed);
      const estimateCommits = await probeUI(`
        const id = ${JSON.stringify(added.id)}, ruleId = ${JSON.stringify(added.ruleId)};
        const changed = ${JSON.stringify(estimates.changed)}, nextAt = ${JSON.stringify(estimates.nextAt ?? null)};
        const row = () => [...document.querySelectorAll('#recurring-list li[data-recurring-id]')]
          .find((r) => r.dataset.recurringId === ruleId);
        const panel = document.getElementById('recurring-panel'), button = document.getElementById('btn-recurring');
        const geometry = () => {
          const b = button.getBoundingClientRect(), p = panel.getBoundingClientRect(), r = row().getBoundingClientRect();
          const children = [...row().children].map((el) => el.getBoundingClientRect());
          return p.width <= 356 && p.height <= 100 && p.top >= b.bottom && p.left >= b.left - 1 &&
            p.right > b.right && p.right <= innerWidth && panel.scrollWidth <= panel.clientWidth &&
            row().scrollWidth <= row().clientWidth && children.every((c) => c.left >= r.left && c.right <= r.right + 1) &&
            children.every((c, i) => !i || children[i - 1].right <= c.left);
        };
        let geometryOK = geometry(), scheduleOK = true, mainOK = true;
        const edit = async (value, key, expected) => {
          row().querySelector('.recurring-minutes').click();
          const input = await waitFor(() => row()?.querySelector('.recurring-minutes-edit'), 'rule minutes input');
          input.value = value;
          geometryOK = geometryOK && geometry();
          if (key === 'blur') {
            const outside = document.getElementById('add-input');
            outside.focus(); // exercise the input's real blur handler before outside-click dismissal
            outside.click();
          } else input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
          await waitFor(() => !row()?.querySelector('.recurring-minutes-edit'), 'rule minutes editor closes');
          await pause(150);
          const s = await shapeday.call('day:get'), rule = s.recurring.find((r) => r.id === ruleId);
          scheduleOK = scheduleOK && (rule?.nextAt ?? null) === nextAt;
          mainOK = mainOK && s.day.tasks.find((t) => t.id === id)?.estimateMin === changed;
          return rule?.estimateMin === expected && row().querySelector('.recurring-minutes').textContent === expected + 'm' &&
            (key === 'blur' ? !panel.matches(':popover-open') && button.getAttribute('aria-expanded') === 'false' :
              panel.matches(':popover-open') && button.getAttribute('aria-expanded') === 'true');
        };
        const invalid = [];
        for (const value of ['', '0', '481', '-1', '2.5', 'abc']) {
          for (const key of ['Enter', 'Escape', 'Tab', 'blur']) {
            invalid.push({ value, key, ok: await edit(value, key, 17) });
            if (key === 'blur') button.click();
          }
        }
        const minimum = await edit('1', 'Enter', 1), maximum = await edit('480', 'Enter', 480);
        const escape = await edit('23', 'Escape', 23), tab = await edit('29', 'Tab', 29);
        const blur = await edit('31', 'blur', 31);
        button.click(); // leave the panel open for the existing outside-click/delete flow
        geometryOK = geometryOK && geometry();
        return { invalid, minimum, maximum, escape, tab, blur, geometry: geometryOK, schedule: scheduleOK, main: mainOK };
      `);
      check('recurring minutes invalid drafts cancel on Enter/Escape/Tab/blur',
        estimateCommits.invalid.every((r) => r.ok), JSON.stringify(estimateCommits.invalid));
      check('recurring minutes accepts whole-minute boundaries 1 and 480', estimateCommits.minimum && estimateCommits.maximum);
      check('recurring minutes Escape saves 23m and keeps panel open', estimateCommits.escape);
      check('recurring minutes Tab saves 29m and keeps panel open', estimateCommits.tab);
      check('recurring minutes outside blur saves 31m and closes panel', estimateCommits.blur);
      check('recurring minutes edits preserve main task estimate and nextAt', estimateCommits.main && estimateCommits.schedule);
      check('recurring minutes row stays compact without horizontal overflow right/below clock', estimateCommits.geometry);
      store.flush();
      const finalEstimates = JSON.parse(fs.readFileSync(require('path').join(app.getPath('userData'), 'shapeday.json'), 'utf8'));
      check('recurring minutes outside blur persists 31m with unchanged schedule and main task',
        finalEstimates.recurring.find((r) => r.id === added.ruleId)?.estimateMin === 31 &&
          finalEstimates.recurring.find((r) => r.id === added.ruleId)?.nextAt === estimates.nextAt &&
          finalEstimates.days[before.date]?.tasks.find((t) => t.id === added.id)?.estimateMin === estimates.changed);
      await call('task:setEstimate', { id: added.id, minutes: estimates.original });
      const restoredEstimate = await call('day:get');
      check('main estimate restored while future recurring estimate remains 31m',
        restoredEstimate.day.tasks.find((t) => t.id === added.id)?.estimateMin === estimates.original &&
          restoredEstimate.recurring.find((r) => r.id === added.ruleId)?.estimateMin === 31);
      const removed = await probeUI(`
        document.getElementById('add-input').click(); // this input stops bubbling, so dismissal must run in capture phase
        const button = document.getElementById('btn-recurring');
        const outside = !document.querySelector('#recurring-panel:popover-open') &&
          button.getAttribute('aria-expanded') === 'false';
        button.click();
        const remove = await waitFor(() => document.querySelector('#recurring-panel:popover-open li button'), 'rule delete button');
        remove.click();
        const s = await waitFor(async () => {
          const s = await shapeday.call('day:get');
          return !s.recurring.length && document.getElementById('recurring-count').hidden &&
            !document.querySelector('#task-list .each-chip') ? s : null;
        }, 'deleted rule removes chip and badge');
        return { outside, removed: s.day.tasks.length === 1 && s.day.tasks[0].id === ${JSON.stringify(added.id)} &&
          s.day.tasks[0].title === 'New title' && !s.day.tasks[0].recurringId &&
          !document.querySelector('#recurring-list li') };
      `);
      check('recurring panel collapses on outside click', removed.outside, JSON.stringify(removed));
      check('recurring UI delete stops rule and hides badge/chip without deleting task', removed.removed, JSON.stringify(removed));

      // Use the overlay's actual button and the toast's actual accept action.
      await win.webContents.executeJavaScript('window.__events = [], true');
      const manualBefore = await call('day:get');
      const overlay = windows.ALL.find((w) => w.webContents.getURL().includes('bar.html'));
      const pressed = await overlay.webContents.executeJavaScript(`(() => {
        const button = document.getElementById('top-break');
        const visible = !document.getElementById('topbar').hidden && button.getClientRects().length > 0 && !button.disabled;
        button.click();
        return visible;
      })()`);
      await sleep(500);
      const proposals = await win.webContents.executeJavaScript('window.__events.filter(e => e.type === "break-propose")');
      const notice = await toast().webContents.executeJavaScript(`(() => ({
        headline: document.getElementById('headline').textContent,
        sub: document.getElementById('sub').textContent,
        proposing: !document.getElementById('propose').hidden,
        expected: I18N.t('en-us', 'toast.manual'),
        done: I18N.t('en-us', 'toast.done'),
        expectedSub: I18N.t('en-us', 'toast.manual_text', { n: ${manualBefore.settings.breakMinutes} })
      }))()`);
      const proposed = await call('day:get');
      check('manual break overlay button sends manual proposal and non-Task-done toast',
        pressed && proposals.length === 1 && proposals[0].data?.manual === true && toast().isVisible() &&
          notice.proposing && notice.headline === notice.expected && notice.headline !== notice.done &&
          !/task done/i.test(notice.headline) && notice.sub === notice.expectedSub &&
          proposed.active?.id === manualBefore.active?.id && proposed.day.tasks[0].status === 'yellow',
        JSON.stringify({ proposals, notice }));
      await toast().webContents.executeJavaScript('document.getElementById("accept").click(), true');
      await sleep(500);
      const parked = await call('day:get');
      const parkedUI = await probeUI(`
        return !!(await waitFor(() => document.querySelector('#task-list li.task.paused') &&
          !document.querySelector('#task-list li.task.green'), 'paused row, no green'));
      `);
      check('manual break toast accept parks active task without marking it green',
        !!parked.break && !parked.active && parkedUI && parked.day.tasks[0].id === manualBefore.active?.id &&
          parked.day.tasks[0].status === 'paused' && !parked.day.tasks[0].finishedAt &&
          parked.day.tasks.every((t) => t.status !== 'green'), JSON.stringify(parked.day.tasks));
      await call('break:end');
      await call('break:respond', { accept: false });

      // Give yesterday a distinctive task to catch rendering snap.day instead of r.day.
      const historicalTitle = 'E2E historical summary only';
      const start = new Date(pastDate + 'T10:00:00').getTime();
      store.updateDay(pastDate, (d) => {
        d.tasks.push({ id: 'e2e-historical-summary', title: historicalTitle, status: 'green',
          estimateMin: 17, startedAt: start, finishedAt: start + 11 * 60000,
          worked: [{ start, end: start + 11 * 60000 }] });
      });
      const historical = await probeUI(`
        const today = ${JSON.stringify(before.date)}, yesterday = ${JSON.stringify(pastDate)};
        const title = ${JSON.stringify(historicalTitle)};
        document.querySelector('[data-view=sum]').click();
        document.querySelector('[data-scope=day]').click();
        const input = document.getElementById('sum-date'), next = document.getElementById('sum-next');
        input.value = today;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(() => document.querySelector('#sum-detail .day-table')?.textContent.includes('New title'), 'today detail');
        const initial = input.value === today && input.max === today && next.disabled;
        document.getElementById('sum-prev').click();
        await waitFor(() => document.querySelector('#sum-detail .day-table')?.textContent.includes(title), 'historical detail from r.day');
        const report = await shapeday.call('report:get', { scope: 'day', date: yesterday });
        const cells = [...document.querySelectorAll('#sum-detail .day-table tr')]
          .find((r) => r.firstElementChild?.textContent === title)?.querySelectorAll('td');
        const previous = input.value === yesterday && input.max === today && !next.disabled &&
          report.date === yesterday && report.day.tasks.some((t) => t.title === title) &&
          !document.getElementById('sum-detail').textContent.includes('New title') &&
          cells?.[2].textContent === '17m' && cells?.[3].textContent === '11m';
        next.click();
        await waitFor(() => document.querySelector('#sum-detail .day-table')?.textContent.includes('New title'), 'next restores today detail');
        const restored = input.value === today && next.disabled && !document.getElementById('sum-detail').textContent.includes(title);
        input.value = yesterday;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(() => document.getElementById('sum-detail').textContent.includes(title), 'date picker selects historical day');
        const picker = input.value === yesterday && !next.disabled;
        input.value = today;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(() => document.getElementById('sum-detail').textContent.includes('New title'), 'picker restores today');
        return { initial, previous, restored, picker, date: input.value, max: input.max };
      `);
      check('historical summary UI prev/next honors date value/max/today and renders selected r.day detail',
        historical.initial && historical.previous && historical.restored, JSON.stringify(historical));
      check('historical summary date picker selects a past day and returns to today', historical.picker, JSON.stringify(historical));
    } catch (e) {
      const errors = await win.webContents.executeJavaScript('JSON.stringify(window.__uiErrors)');
      check('recurring/manual-break/historical UI regression flow completes', false, (e.stack || String(e)) + ' renderer errors: ' + errors);
    } finally {
      // Dismiss editors/popovers before restoring the workload, even on assertion/setup failure.
      await win.webContents.executeJavaScript(`(() => {
        const editor = document.querySelector('.title-edit, .each-chip .each-value');
        editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.getElementById('add-input').focus();
        addEditor.reset(); // also removes any helper/tag left by an interrupted add flow
        const date = document.getElementById('sum-date');
        date.value = date.max;
        date.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('hd-day').click();
        document.querySelector('[data-view=plan]').click();
        return true;
      })()`);
      await call('break:end');
      await call('break:respond', { accept: false });
      store.updateRecurring((rules) => rules.splice(0, rules.length, ...savedRules));
      store.updateDay(before.date, (d) => {
        for (const key of Object.keys(d)) delete d[key];
        Object.assign(d, savedDay);
      });
      if (savedPast) store.updateDay(pastDate, (d) => {
        for (const key of Object.keys(d)) delete d[key];
        Object.assign(d, savedPast);
      });
      await call('settings:set', savedSettings);
      store.flush();
      await sleep(1200);
    }
  }

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

  const uiErrors = await win.webContents.executeJavaScript('window.__uiErrors || []');
  check('renderer completes interactions without uncaught errors', uiErrors.length === 0, JSON.stringify(uiErrors));
  fs.writeFileSync('/tmp/shapeday-e2e.json', JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`e2e: ${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

module.exports = { run, annotate };
