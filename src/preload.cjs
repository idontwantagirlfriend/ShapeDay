/**
 * preload — the entire renderer API surface, standardized as `window.shapeday`.
 * One invoke channel (`shapeday:call`, kind-dispatched) + two push channels
 * (`tick`, `event`). Renderer never touches Electron directly.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shapeday', {
  /** Call an app action. Kinds are documented in README (API section). */
  call: (kind, payload) => ipcRenderer.invoke('shapeday:call', { kind, payload }),

  /** Subscribe to the 1 Hz state snapshot. Returns an unsubscribe fn. */
  onTick: (cb) => {
    const h = (_e, snap) => cb(snap);
    ipcRenderer.on('shapeday:tick', h);
    return () => ipcRenderer.removeListener('shapeday:tick', h);
  },

  /** Subscribe to one-shot events: break-propose, break-over, eval-prompt. */
  onEvent: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on('shapeday:event', h);
    return () => ipcRenderer.removeListener('shapeday:event', h);
  },

  /** Ask the OS to focus the main window (used by overlay windows). */
  focusMain: () => ipcRenderer.invoke('shapeday:call', { kind: 'focusMain' }),
});
