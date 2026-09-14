/**
 * windows — the draw-over layer.
 *   main  : the Plan / Visualize / Summarize app window
 *   bar   : always-on-top "currently-on" bar (task, elapsed, progress, overwork)
 *   toast : break proposal / break countdown
 *   tint  : fullscreen transparent click-through overwork tint
 */
'use strict';
const path = require('path');
const { BrowserWindow, screen } = require('electron');

const UI = (name) => path.join(__dirname, '..', 'ui', name);
const PRELOAD = path.join(__dirname, '..', 'preload.cjs');

const ALL = []; // every window we own

function track(win) {
  ALL.push(win);
  win.on('closed', () => {
    const i = ALL.indexOf(win);
    if (i >= 0) ALL.splice(i, 1);
  });
  // Overlay windows must survive renderer crashes (GPU glitches leave a
  // frozen frame with dead buttons — looks exactly like a hung toast).
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[windows] renderer gone (${details.reason}), reloading`, win.webContents.getURL());
    if (!win.isDestroyed()) win.webContents.reload();
  });
  return win;
}

function sendToAll(channel, payload) {
  for (const w of ALL) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function createMainWindow() {
  const win = track(
    new BrowserWindow({
      width: 1120,
      height: 760,
      minWidth: 900,
      minHeight: 620,
      backgroundColor: '#16181d',
      show: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
    })
  );
  win.removeMenu();
  win.loadFile(UI('index.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}

function createBar() {
  // the overarching strip: full work-area width, one narrow line at the top
  const { workArea } = screen.getPrimaryDisplay();
  const H = 26;
  const win = track(
    new BrowserWindow({
      width: workArea.width,
      height: H,
      x: workArea.x,
      y: workArea.y,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
    })
  );
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(UI('bar.html'));
  return win;
}

function createToast() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 380, H = 170;
  const win = track(
    new BrowserWindow({
      width: W,
      height: H,
      x: workArea.x + workArea.width - W - 16,
      y: workArea.y + workArea.height - H - 16,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true, // needs clicks for accept/skip
      show: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
    })
  );
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(UI('break.html'));
  return win;
}

function createTint() {
  const d = screen.getPrimaryDisplay();
  const win = track(
    new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      show: false,
      // Click-through in both directions: the tint must never eat input.
      acceptFirstMouse: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
    })
  );
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: false });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(UI('tint.html'));
  return win;
}

module.exports = { createMainWindow, createBar, createToast, createTint, sendToAll, ALL };
