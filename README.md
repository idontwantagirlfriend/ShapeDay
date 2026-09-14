# ShapeDay

Plan. Visualize. Report. A tactile day-shape work tracker with overwork awareness. Local-first; nothing leaves the machine unless you configure an AI endpoint.

## Plan

- List tasks; each lands red with an ETA from **smart reading** (keyword buckets × personal bias factor). Switch to **AI estimation** in ⚙ to re-estimate via your endpoint; ± hand edits always win.
- Click the current task → **finished** (break proposed). Click another → it becomes current; the previous goes **on break** (paused, resumable, time kept). Right-click → **abort** (white); click a hung task to revive it to red.
- **Frontier rule** (auto-advance, default on): exactly one task in progress — the first after the last finished one, else the first in the list.
- Drag the row grip to reorder. Hover ✕ deletes. The **reflog** below the tools records additions, deletions and status changes.

## Visualize

- **Day**: burn-up across work hours — broken line between task start/end nodes, flat on breaks, dotted plan pace. Hover for progress at any moment. 50% self-evaluation prompt fires once.
- **Week**: column per day, tasks as blocks, overtime tinted darkest red.
- **Month**: calendar — green (overtime < 30 min), red (≥ 30 min), gray (no activity / future).
- Overwork also tints the screen: `#aed8fc` → `#db9696` → `#803d3a` at 30/60/120 min.

## Summarize

Day / week / 30-day metrics with either **templated text** (mustache, editable in settings) or **AI** issue pinpointing. Terse by contract.

Template arguments: `{{scope}} {{daysTracked}} {{tasksDone}} {{tasksTotal}} {{tasksHung}} {{plannedMin}} {{actualMin}} {{estBias}} {{overworkDays}} {{overworkMin}} {{breaks}} {{breakMin}} {{longestNoBreakMin}}`

## Overlay

Always-on-top bar (draggable, hand cursor, adjustable opacity), break toast with countdown, click-through overwork tint. Tray-resident; `Alt+Shift+O` toggles. Background image is customizable — cover-fit, ratio kept, under a readability scrim.

## AI (optional, opt-in per feature)

Any OpenAI-compatible `chat/completions` endpoint: Base URL + Model (+ key if required) in ⚙, Test button verifies. Prompts are editable files in the data dir's `prompts/` (re-read per call; unedited copies refresh from the bundled defaults):

- `prompts/eta.txt` — reply contract `{"tasks":[{"id","minutes"}]}`
- `prompts/summary.txt` — reply contract `{"recap","suggestions":[{"content","cite"}]}`; `{history_reports}` is filled with the past three days

## Data

One JSON file: `~/.config/ShapeDay/shapeday.json` (`%APPDATA%\ShapeDay\` on Windows). Holds the API key — never commit it. Installer updates in place and keep it.

## Develop & build

```bash
npm install
npm start        # run
npm test         # 43 unit tests
npm run test:e2e # 39-check driver through the real UI
npm run shot     # seed a demo day, screenshot every window
npm run assets   # normalize dropped-in icons/logos (assets/raw/)
npm run dist:win # Windows installer + portable exe
```

Windows targets cross-build from Linux (NSIS step needs wine). The exe is unsigned.
