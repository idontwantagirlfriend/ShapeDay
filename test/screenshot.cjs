/**
 * screenshot — runs in the main process when SHAPEDAY_SHOT=1.
 * Seeds a realistic demo day (finished tasks, taken break, active break,
 * one hung task, overwork past work-end), then captures every window to
 * shots/*.png so the visualization can be verified without a human.
 *
 *   SHAPEDAY_SHOT=1 electron . --no-sandbox
 */
'use strict';
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60000;

async function run({ app, getMainWin, store, state, windows }) {
  const OUT = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(OUT, { recursive: true });

  // A believable today, back-dated relative to now.
  const now = Date.now();
  const at = (hOffset, minOffset = 0) => now - hOffset * 3600000 - minOffset * MIN;
  store.updateDay(state.snapshot().date, (day) => {
    day.tasks = [
      {
        id: 'd1', title: 'Review inbox & reply', status: 'green', estimateMin: 20,
        createdAt: at(2, 30), startedAt: at(2, 5), finishedAt: at(1, 49), skippedAt: null,
        worked: [{ start: at(2, 5), end: at(1, 49) }],
      },
      {
        id: 'd2', title: 'Build timeline chart', status: 'green', estimateMin: 90,
        createdAt: at(2, 29), startedAt: at(1, 39), finishedAt: at(0, 12), skippedAt: null,
        worked: [{ start: at(1, 39), end: at(1, 12) }, { start: at(0, 52), end: at(0, 12) }],
      },
      {
        id: 'd3', title: 'Write launch email', status: 'red', estimateMin: 30,
        createdAt: at(2, 28), startedAt: null, finishedAt: null, skippedAt: null, worked: [],
      },
      {
        id: 'd4', title: 'Refactor store layer', status: 'white', estimateMin: 60,
        createdAt: at(2, 27), startedAt: null, finishedAt: null, skippedAt: at(1, 5), worked: [],
      },
    ];
    day.breaks = [
      { start: at(1, 49), plannedMin: 10, end: at(1, 39) },
      { start: now - 3 * MIN, plannedMin: 10, end: null }, // active break right now
    ];
    day.selfEval = { promptedAt: at(0, 30), response: 'on-track' };
    day.etaReviewed = true;
  });
  // Shove work-end 70 minutes into the past → live overwork tint.
  const past = new Date(now - 70 * MIN);
  const pad = (n) => String(n).padStart(2, '0');
  store.setSettings({ workEnd: `${pad(past.getHours())}:${pad(past.getMinutes())}` });
  store.flush();

  const main = getMainWin();
  await sleep(1800); // let a couple of ticks propagate

  async function shot(win, name) {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    console.log(`📸 shots/${name}`);
  }

  // Plan view
  await main.webContents.executeJavaScript(`document.querySelector('[data-view=plan]').click(), true`);
  await sleep(300);
  await shot(main, 'plan.png');

  // Visualize view
  await main.webContents.executeJavaScript(`document.querySelector('[data-view=viz]').click(), true`);
  await sleep(500);
  await shot(main, 'visualize.png');

  // Summarize view
  await main.webContents.executeJavaScript(`document.querySelector('[data-view=sum]').click(), true`);
  await sleep(500);
  await shot(main, 'summarize.png');

  // Overlay windows: bar + tint
  for (const w of windows.ALL) {
    const url = w.webContents.getURL();
    if (url.includes('bar.html') && w.isVisible()) await shot(w, 'bar.png');
    if (url.includes('tint.html') && w.isVisible()) await shot(w, 'tint.png');
    if (url.includes('break.html')) {
      w.showInactive(); // active break countdown
      await sleep(400);
      await shot(w, 'break-toast.png');
    }
  }

  console.log('screenshot pass complete');
  app.exit(0);
}

module.exports = { run };
