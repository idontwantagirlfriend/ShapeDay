/**
 * main — app entry. Single instance, tray, the 1 Hz tick that drives every
 * window, the standardized IPC surface, and overlay lifecycle.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { app, Tray, Menu, ipcMain, globalShortcut, nativeImage } = require('electron');

const Store = require('../core/store.cjs');
const { createState } = require('./state.cjs');
const windows = require('./windows.cjs');

const store = Store.open(path.join(app.getPath('userData'), 'shapeday.json'));

// Editable LLM prompts: bundled defaults seeded into the data dir once;
// from then on the user's files win (llm.cjs re-reads them per call).
const PROMPTS_DIR = path.join(app.getPath('userData'), 'prompts');
try {
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  for (const name of ['eta.txt', 'summary.txt']) {
    const dest = path.join(PROMPTS_DIR, name);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(__dirname, '..', '..', 'prompts', name), dest);
    }
  }
} catch (e) {
  console.error('[prompts] seeding failed:', e.message);
}

// onDirty: async LLM completions mutate state after the action returns —
// they re-pump so every window sees the update immediately.
const state = createState(store, { onDirty: () => pump(), promptsDir: PROMPTS_DIR });

let mainWin = null;
let barWin = null;
let toastWin = null;
let tintWin = null;
let tray = null;

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
function syncOverlay(snap) {
  if (!overlayEnabled() || !snap) {
    barWin?.hide();
    tintWin?.hide();
    return; // note: the break toast stays — it's functional, not decoration
  }
  if (barWin) {
    const inDay = snap.day && (snap.day.tasks.length > 0);
    if (inDay || snap.active) barWin.showInactive();
    else barWin.hide();
  }
  if (tintWin) {
    if (snap.overworkMin > 0) {
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
// Manual bar dragging — handled before the state dispatch because it runs at
// mouse-move frequency and must not trigger a state pump per event.
const barDrag = { active: false, x: 0, y: 0, mx: 0, my: 0 };
function handleBarDrag(p) {
  if (!barWin || barWin.isDestroyed()) return { ok: false };
  if (!barDrag.active) {
    const [x, y] = barWin.getPosition();
    barDrag.active = true;
    barDrag.x = x;
    barDrag.y = y;
    barDrag.mx = p.sx;
    barDrag.my = p.sy;
  }
  barWin.setPosition(Math.round(barDrag.x + (p.sx - barDrag.mx)), Math.round(barDrag.y + (p.sy - barDrag.my)));
  return { ok: true };
}

ipcMain.handle('shapeday:call', (_e, { kind, payload }) => {
  if (kind === 'focusMain') {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.show();
      mainWin.focus();
    }
    return { ok: true };
  }
  if (kind === 'bar:drag') {
    if (payload?.end) {
      barDrag.active = false;
      return { ok: true };
    }
    return handleBarDrag(payload || {});
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
  app.on('second-instance', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.show();
      mainWin.focus();
    }
  });

  app.whenReady().then(() => {
    mainWin = windows.createMainWindow();
    tintWin = windows.createTint(); // tint first → bar/toast stay above it
    barWin = windows.createBar();
    toastWin = windows.createToast();

    tray = new Tray(trayIcon());
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show ShapeDay', click: () => mainWin?.show() },
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
    tray.on('click', () => mainWin?.show());

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
    globalShortcut.unregisterAll();
    store.flush();
  });
}
