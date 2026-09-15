/**
 * main — app entry. Single instance, tray, the 1 Hz tick that drives every
 * window, the standardized IPC surface, and overlay lifecycle.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, Tray, Menu, ipcMain, globalShortcut, nativeImage, dialog } = require('electron');

const Store = require('../core/store.cjs');
const { createState } = require('./state.cjs');
const windows = require('./windows.cjs');

const store = Store.open(path.join(app.getPath('userData'), 'shapeday.json'));

// Editable LLM prompts. Bundled defaults (prompts/ in the package) seed the
// data dir; a data-dir copy that the user has NOT edited since seeding is
// refreshed whenever the bundled default changes, so prompt updates in the
// repo reach machines that were already seeded. An edited copy always wins.
// LEGACY_DEFAULTS fingerprints installs seeded before the marker existed.
const LEGACY_DEFAULTS = {
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
const PROMPTS_DIR = path.join(app.getPath('userData'), 'prompts');
try {
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  const markerPath = path.join(PROMPTS_DIR, '.seeded.json');
  let seeded = {};
  try {
    seeded = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    // first run, or unreadable marker: entries without records are checked
    // against LEGACY_DEFAULTS below before being treated as user-owned
  }
  const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const shaText = (t) => crypto.createHash('sha256').update(t).digest('hex');
  for (const name of ['eta.txt', 'daily_summary.txt', 'weekly_summary.txt', 'monthly_summary.txt', 'yearly_summary.txt']) {
    const base = name.replace('.txt', '');
    const dest = path.join(PROMPTS_DIR, name);
    const src = path.join(__dirname, '..', '..', 'prompts', name);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      seeded[name] = sha256(dest);
    } else {
      // pre-marker installs: recognize the verbatim legacy default (trailing
      // whitespace normalized — the seed copied files verbatim)
      const isLegacy =
        !seeded[name] &&
        LEGACY_DEFAULTS[base] != null &&
        fs.readFileSync(dest, 'utf8').trimEnd() === LEGACY_DEFAULTS[base].trimEnd();
      const known = seeded[name] ?? (isLegacy ? shaText(LEGACY_DEFAULTS[base].trimEnd()) : null);
      if (known && known === sha256(dest) && known !== sha256(src)) {
        fs.copyFileSync(src, dest); // untouched seed, bundled evolved: refresh
        seeded[name] = sha256(dest);
      } else if (!seeded[name]) {
        seeded[name] = sha256(dest); // user-owned or current: record it
      }
    }
  }
  fs.writeFileSync(markerPath, JSON.stringify(seeded, null, 2));
} catch (e) {
  console.error('[prompts] seeding failed:', e.message);
}

// onDirty: async LLM completions mutate state after the action returns —
// they re-pump so every window sees the update immediately.
const state = createState(store, {
  onDirty: () => pump(),
  promptsDir: PROMPTS_DIR,
  bundledPromptsDir: path.join(__dirname, '..', '..', 'prompts'),
});

let mainWin = null;
let barWin = null;
let toastWin = null;
let tintWin = null;
let dragShieldWin = null;
let tray = null;
let isQuitting = false;

/** Raise the fullscreen capture layer while any drag is in flight; the
 *  cursor can never leave it, so fast drags don't stutter and the mouseup
 *  is always delivered wherever the pointer ends up. */
function raiseDragShield() {
  if (!dragShieldWin || dragShieldWin.isDestroyed()) return;
  if (!dragShieldWin.isVisible()) {
    dragShieldWin.showInactive();
    dragShieldWin.moveTop();
  }
}
function lowerDragShield() {
  if (dragShieldWin && !dragShieldWin.isDestroyed() && dragShieldWin.isVisible()) dragShieldWin.hide();
}
function anyDragActive() {
  for (const d of overlayDrags.values()) if (d.active) return true;
  return false;
}

/** Show the main window, recreating it if it was destroyed (e.g. by a
 *  close that slipped past the hide-to-tray interception). */
function showMain() {
  if (!mainWin || mainWin.isDestroyed()) {
    mainWin = windows.createMainWindow();
    return;
  }
  mainWin.show();
  mainWin.focus();
}

function assetPath(rel) {
  return path.join(__dirname, '..', '..', 'assets', rel);
}

function trayIcon() {
  // Standardized slots produced by scripts/normalize-assets.mjs
  for (const p of ['tray.png', 'icon.png']) {
    try {
      const img = nativeImage.createFromPath(assetPath(p));
      if (!img.isEmpty()) return img;
    } catch {}
  }
  return nativeImage.createEmpty();
}

function overlayEnabled() {
  return store.settings.overlayEnabled !== false;
}

/** Show/hide overlay windows from the current snapshot. */
let lastBarStyle = null;

function syncOverlay(snap) {
  if (!overlayEnabled() || !snap) {
    barWin?.hide();
    tintWin?.hide();
    return; // note: the break toast stays — it's functional, not decoration
  }
  if (barWin) {
    const style = snap.settings.overlayStyle === 'floater' ? 'floater' : 'top';
    if (style !== lastBarStyle) {
      lastBarStyle = style;
      windows.applyBarStyle(barWin, style);
    }
    const inDay = snap.day && (snap.day.tasks.length > 0);
    if (inDay || snap.active) barWin.showInactive();
    else barWin.hide();
  }
  if (tintWin) {
    if (snap.overworkMin > 0 && (snap.settings.tintStrength ?? 100) > 0) {
      if (!tintWin.isVisible()) tintWin.showInactive();
      tintWin.moveTop();
    } else {
      tintWin.hide();
    }
  }
}

function pump() {
  const { snapshot: snap, events } = state.tick();
  windows.sendToAll('shapeday:tick', snap);
  for (const ev of events) {
    windows.sendToAll('shapeday:event', ev);
    if (ev.type === 'break-propose') {
      if (toastWin) {
        toastWin.showInactive();
        toastWin.moveTop();
      }
    }
    if (ev.type === 'break-over' || ev.type === 'break-skipped') {
      if (toastWin) toastWin.hide();
    }
  }
  syncOverlay(snap);
  tray?.setToolTip(
    snap.active ? `▶ ${snap.active.title}` : `ShapeDay — ${Math.round(snap.progress.ratio * 100)}%`
  );
}

// ---------- standardized IPC: one channel, kind-dispatched ----------
// Manual overlay dragging (top strip, break toast) — handled before the
// state dispatch because it runs at mouse-move frequency and must not
// trigger a state pump per event. The sender identifies the window.
const overlayDrags = new Map(); // webContents id -> {active, x, y, w, h, mx, my}
function handleOverlayDrag(senderId, target, p) {
  if (!target || target.isDestroyed()) return { ok: false };
  let drag = overlayDrags.get(senderId);
  if (!drag || !drag.active || p.begin) {
    // a press always re-anchors: a lost mouseup (click-through swallowing it)
    // must never leave a stale anchor steering the next drag
    const [x, y] = target.getPosition();
    const [w, h] = target.getSize();
    drag = { active: true, x, y, w, h, mx: p.sx, my: p.sy };
    overlayDrags.set(senderId, drag);
    raiseDragShield();
  }
  // setBounds (not setPosition): re-asserts the anchored size on every move,
  // so no external resize creep (OS DPI snapping, snap layouts, anything)
  // can accumulate while the window is being dragged
  target.setBounds({
    x: Math.round(drag.x + (p.sx - drag.mx)),
    y: Math.round(drag.y + (p.sy - drag.my)),
    width: drag.w,
    height: drag.h,
  });
  return { ok: true };
}

ipcMain.handle('shapeday:call', async (_e, { kind, payload }) => {
  if (kind === 'focusMain') {
    showMain();
    return { ok: true };
  }
  if (kind === 'overlay:setInteractive') {
    // top strip: click-through until the renderer says the cursor hit the
    // grip. The floater is always interactive, so a toggle that was in flight
    // when the style changed must not make it click-through.
    if (barWin && !barWin.isDestroyed() && _e.sender === barWin.webContents) {
      if (lastBarStyle === 'floater') barWin.setIgnoreMouseEvents(false);
      else barWin.setIgnoreMouseEvents(!payload?.on, { forward: true });
    }
    return { ok: true };
  }
  if (kind === 'overlay:toastHeight') {
    // the toast sizes to its content; the bottom edge stays pinned.
    // Never resize mid-drag (setBounds would fight the drag's setPosition),
    // and ignore sub-2px churn so rounding can never accumulate.
    if (toastWin && !toastWin.isDestroyed() && _e.sender === toastWin.webContents) {
      const dragging = overlayDrags.get(_e.sender.id)?.active;
      const h = Math.max(120, Math.min(400, Math.round(Number(payload?.h) || 170)));
      const [x, y] = toastWin.getPosition();
      const [, oldH] = toastWin.getSize();
      if (!dragging && Math.abs(h - oldH) >= 2) {
        toastWin.setBounds({ x, y: y + (oldH - h), width: 380, height: h });
      }
    }
    return { ok: true };
  }
  if (kind === 'overlay:dragMove') {
    // moves arriving via the capture layer: steer every active drag
    for (const [senderId, drag] of overlayDrags) {
      if (!drag.active) continue;
      const target =
        barWin && !barWin.isDestroyed() && senderId === barWin.webContents.id
          ? barWin
          : toastWin && !toastWin.isDestroyed() && senderId === toastWin.webContents.id
            ? toastWin
            : null;
      if (target) handleOverlayDrag(senderId, target, { ...payload, begin: false });
    }
    return { ok: true };
  }
  if (kind === 'overlay:dragEnd') {
    for (const drag of overlayDrags.values()) drag.active = false;
    lowerDragShield();
    return { ok: true };
  }
  if (kind === 'overlay:drag') {
    const senderId = _e.sender.id;
    if (payload?.end) {
      const drag = overlayDrags.get(senderId);
      if (drag) drag.active = false;
      if (!anyDragActive()) lowerDragShield();
      return { ok: true };
    }
    const target =
      barWin && !barWin.isDestroyed() && _e.sender === barWin.webContents
        ? barWin
        : toastWin && !toastWin.isDestroyed() && _e.sender === toastWin.webContents
          ? toastWin
          : null;
    return handleOverlayDrag(senderId, target, payload || {});
  }
  if (kind === 'background:choose') {
    // native picker; cancel leaves the current background untouched
    const picked = await dialog.showOpenDialog(mainWin, {
      title: 'Choose a background image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
    });
    if (!picked.canceled && picked.filePaths[0]) {
      state.actions['settings:set']({ backgroundImage: picked.filePaths[0] });
      store.flush();
      pump();
      return { ok: true, path: picked.filePaths[0] };
    }
    return { ok: false, canceled: true };
  }
  const fn = state.actions[kind];
  if (typeof fn !== 'function') return { error: `unknown kind: ${kind}` };
  const out = fn(payload ?? {});
  store.flush();
  pump(); // every action is reflected immediately, not on the next second
  return out ?? { ok: true };
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());

  app.whenReady().then(() => {
    mainWin = windows.createMainWindow();
    // closing hides to tray: the window object survives, so tray-restore is
    // instant and nothing ever calls show() on a destroyed window
    mainWin.on('close', (e) => {
      if (!isQuitting) {
        e.preventDefault();
        mainWin.hide();
      }
    });
    tintWin = windows.createTint(); // tint first → bar/toast stay above it
    dragShieldWin = windows.createDragShield();
    barWin = windows.createBar();
    toastWin = windows.createToast();

    tray = new Tray(trayIcon());
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show ShapeDay', click: () => showMain() },
        {
          label: 'Overlay on/off',
          type: 'checkbox',
          checked: overlayEnabled(),
          click: (item) => {
            store.setSettings({ overlayEnabled: item.checked });
            pump();
          },
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ])
    );
    tray.setToolTip('ShapeDay');
    tray.on('click', () => showMain());

    globalShortcut.register('Alt+Shift+O', () => {
      store.setSettings({ overlayEnabled: !overlayEnabled() });
      pump();
    });

    pump();
    setInterval(pump, 1000);

    // Headless-ish end-to-end harness: SHAPEDAY_E2E=1 electron . --no-sandbox
    if (process.env.SHAPEDAY_E2E) {
      const { run } = require('../../test/e2e-driver.cjs');
      setTimeout(() => run({ app, getMainWin: () => mainWin, state, windows }).catch((e) => {
        console.error('e2e driver crashed:', e);
        app.exit(1);
      }), 800);
    }
    // Visual verification: SHAPEDAY_SHOT=1 electron . --no-sandbox → shots/
    if (process.env.SHAPEDAY_SHOT) {
      const { run } = require('../../test/screenshot.cjs');
      setTimeout(() => run({ app, getMainWin: () => mainWin, state, store, windows }).catch((e) => {
        console.error('screenshot driver crashed:', e);
        app.exit(1);
      }), 800);
    }
  });

  app.on('window-all-closed', () => {
    // Keep running in tray — the overlay IS the product.
  });

  app.on('before-quit', () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    store.flush();
  });
}
