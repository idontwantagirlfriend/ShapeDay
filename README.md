# ShapeDay

Plan. Visualize. Report.

A tactile day-shape work tracker built from `PROJECT.md`: you list what's due,
click tasks through their statuses, and the app records **when everything
starts and stops**. Those timestamps become the shape of your day — a burn-up
line across your work hours — and a work-health report at day, week and
30-day scope. Overwork past your hours tints the screen, escalating from
blue to the darkest red.

## The three phases

### Phase One — Plan
- Type a task, hit **List it**. Everything lands **red** (unfinished) with an
  instant ETA from **smart reading** (the local algorithm: keyword buckets ×
  your personal bias factor — see Settings to see which reading is active).
  Switch ETA estimation to **AI estimation** in ⚙ Settings and, with an
  endpoint configured, a debounced batch call re-estimates everything you
  haven't started or hand-edited — your ± overrides always win. Confirm with
  "Looks right".
- **Left click on the current task = finish** — one gesture marks it
  **green** and proposes a 10-minute break. **Left click on another task =
  switch to it**: it enters progress and the previous current is put **on
  break** with its registered time paused, resumable. Never more than one in
  progress. **Right click = abort** → **white** (hung). Right-click a green
  task to reopen it (which parks the current, same rule).
- **The frontier rule** (auto-advance, on by default): exactly one task is
  **in progress (yellow)** — the first item after the previous finished one,
  or the first in the list. It flags itself; finishing advances it.
- While a break runs, the current task goes **on break (paused, blue)** —
  its worked-time stamps never absorb the break — and resumes when the break
  ends. Displacing an in-progress task (manual mode) puts it on break too,
  with every worked minute kept.
- **Clicking a hung task revives it to red** — back to unfinished, not in
  progress. A task on break resumes the same way (click it current again).
- Drag the **⋮⋮ grip** on a task row's left edge to reorder the list; the
  frontier re-evaluates after the move.
- **Auto-advance off**: the classic two-step — click once → in progress,
  click again → finish.
- **↺ Reset statuses** keeps the titles and resets everything to red (the
  "I list. I reset the status." loop).
- The **reflog** below the tools row records every addition, deletion and
  status change of the day's tasks (diffed, so frontier auto-flagging and
  break parking are logged too). It's unfolded by default; the "always open"
  checkbox in its header sets that. Deleting is the hover-revealed ✕ on a row.

### Phase Two — Visualize
- The timeline is a burn-up: x = wall clock across your work hours,
  y = planned minutes delivered. Each task connects its **start and end nodes
  with a broken (dashed) line**; breaks and idle time flatten the line; the
  dotted line is the plan pace (workload spread evenly over the hours).
- Progress bar in the header; a **self-evaluation prompt fires once, at 50%**
  of the plan (ahead / on track / behind). Hover the chart for a crosshair
  showing delivered progress at any moment in time.
- **Overwork** area past work-end is tinted, escalating (also applied as a
  fullscreen tint):
  | overwork | color |
  |---|---|
  | < 30 min | blue `#aed8fc` (starts immediately after work hours end) |
  | 30–60 min | shifting towards red `#db9696` |
  | 60–120 min | redder |
  | 120 min + | stays in the darkest red `#803d3a` |

### Phase Three — Summarize
- Report at **day / week / past 30 days** scope: metrics (done, planned vs
  actual, estimation bias, overwork days, breaks, longest no-break stretch)
  and **pinpointed issues with one-line suggestions** — deliberately terse;
  the anti-goal is a verbose "intelligent memory".
- Two modes (⚙ Settings → Summarize): **templated text** (default) renders
  your own mustache template; **AI** has the model write the headline and the
  issue list from your metrics + doings list (max 4, one line each).
  Metrics always stay local; findings fall back to local rules when the AI
  is unreachable.

### Draw-over overlay (shipping)
- **Currently-on bar** — always on top: active task, elapsed, day progress,
  overwork clock. Drag it anywhere; click the title to open the app.
- **Break toast** — the 10-minute proposal, then a live countdown.
- **Tint** — a fullscreen, click-through, always-on-top layer that turns the
  screen the overwork color. Toggle overlays with the tray menu or
  `Alt+Shift+O`.
- The app lives in the tray when closed; the overlay is the product.

## Run / build

```bash
npm install
npm start            # dev run
npm test             # 41 unit tests (core logic, LLM transport + prompts, modes, reflog)
npm run test:e2e     # 31-check end-to-end driver (runs the real UI)
npm run shot         # seed a demo day, screenshot every window → shots/
npm run assets       # (re)normalize assets — see below
npm run llm:smoke -- <baseUrl> <model> [apiKey]   # live-test the AI backend
npm run dist:win     # Windows NSIS installer + portable exe
npm run dist:linux   # AppImage
```

Cross-building Windows from Linux: the **portable exe builds with no extra
tooling** (`signAndEditExecutable: false` skips the exe resource editing that
needs wine). The **NSIS installer additionally needs wine** on Linux
(electron-builder bundles the Windows makensis); install it (`apt install
wine64`) or build on a Windows machine, where everything runs natively and the
exe also gets your icon embedded. The exe is unsigned — expect SmartScreen to
ask on first run.

**Installs & updates**: the Setup exe is an assisted wizard — you can pick the
installation directory (defaults to the per-user
`%LOCALAPPDATA%\Programs\ShapeDay`; on update it defaults to wherever the app
is already installed). Running it over an existing install upgrades in place:
shortcuts kept, `shapeday.json` untouched, "Run ShapeDay" checkbox on the
finish page. ShapeDay is tray-resident, so the installer closes the running
app itself first ([build/installer.nsh](build/installer.nsh)); at worst a
sub-second debounced write is lost, since every user action persists
immediately. Uninstalling does **not** delete your data
(`deleteAppDataOnUninstall: false`). Picking a protected directory
(e.g. `C:\Program Files`) will trigger a UAC prompt; user-writable dirs need
none.

Verify on a real Windows machine (60 seconds):

1. Run `ShapeDay-Setup` → choose a custom directory → app launches from
   there, shortcuts appear.
2. Put a task in the list (creates `%APPDATA%\ShapeDay\shapeday.json`), keep
   the app running in the tray.
3. Build/install a newer version (bump `version`, `npm run dist:win`) over
   it — the wizard defaults to the directory from step 1, the running app
   closes by itself, install completes, the app relaunches.
4. Check the task list survived; `Settings → Apps` shows one ShapeDay entry
   with the new version, not two.

(Executing the NSIS installer under wine was tried and is blocked by an
upstream installer/wine incompatibility — it exits 2 inside
electron-builder's own init before touching registry or disk, independent
of this app's configuration. Compile-level facts verified on Linux: the
update flags and the close-running-app hook are compiled into the Setup exe,
and the embedded uninstaller is present in the archive.)

## AI backend (optional, opt-in per feature)

Nothing is hardcoded and nothing leaves the machine until you both configure
an endpoint **and** pick AI for that feature. Modes in ⚙ Settings:

- **ETA estimation: Smart reading / AI estimation.** Smart reading is the
  local algorithm — keyword buckets, first match wins (email→10m …
  research→120m), × personal planning-fallacy factor (median actual/estimate
  of your completed tasks, needs ≥3, clamped ×0.75–2), rounded to 5-minute
  steps, 10–180. AI estimation replaces it for unstarted, un-hand-edited
  tasks after you list them.
- **Summarize: Templated text / AI.** Templated text renders your mustache
  template; AI writes the headline + issue list.

Any OpenAI-compatible **chat/completions** endpoint works — fill Base URL +
Model (+ API key if the provider needs one) and hit **Test**. The key lives
in the local `shapeday.json`.

**The prompts are yours to edit.** They are plain text files in the data
dir, seeded from bundled defaults on first run and re-read on every request
(edits apply on the next call, no restart):

- `prompts/eta.txt` — the ETA estimation system prompt
- `prompts/summary.txt` — the summary system prompt

(`%APPDATA%\ShapeDay\prompts\` on Windows, `~/.config/ShapeDay/prompts/` on
Linux.) Delete a file and restart to restore its default. The only contract:
the model must reply with the JSON shape the file itself describes; output
is validated and clamped either way.

**Template arguments** (mustache variables — `{{name}}`, unknowns render
empty, no sections/partials):

| arg | meaning |
|---|---|
| `{{scope}}` | `day` / `week` / `30d` |
| `{{daysTracked}}` | days with any tasks |
| `{{tasksDone}}` `{{tasksTotal}}` `{{tasksHung}}` | task counts (hung = white) |
| `{{plannedMin}}` `{{actualMin}}` | planned vs worked time |
| `{{estBias}}` | median actual÷estimate (`—` until ≥2 done) |
| `{{overworkDays}}` `{{overworkMin}}` | overwork recurrence and total |
| `{{breaks}}` `{{breakMin}}` `{{longestNoBreakMin}}` | break behavior |

Default template:
`{{tasksDone}}/{{tasksTotal}} done · {{actualMin}} worked vs {{plannedMin}} planned · overwork {{overworkMin}} · {{breaks}} breaks`

Free, no-signup endpoints that work: try
[Kilo Code](https://api.kilo.ai/api/gateway) (`openrouter/free`, 200 req/h),
[LLM7.io](https://api.llm7.io/v1), or pick from
[awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis).
Live-check any endpoint with:

```bash
npm run llm:smoke -- <baseUrl> <model> [apiKey]
```

## Data

Everything is local: one JSON file, `~/.config/ShapeDay/shapeday.json`
(Windows: `%APPDATA%/ShapeDay`), atomic writes. Tasks carry
`startedAt/finishedAt/skippedAt` plus a `worked: [{start,end}]` segment list,
so time survives parking/reopening. Nothing but your configured LLM calls
(ETAs + summaries) ever leaves the machine.

## Assets (standardized)

Slots live in `assets/` and are **generated** — drop your art into
`assets/raw/` (any size, png/jpg/webp/bmp) named after the slot
(`icon*`, `logo*`, `tray*`) and run `npm run assets`:

| file | canonical size | budget |
|---|---|---|
| `assets/icon.png` | 512×512 | ≤ 96 KB |
| `assets/icon.ico` | 16–256 (7 sizes) | — |
| `assets/tray.png` | 32×32 | ≤ 8 KB |
| `assets/logo.png` | 512×512 | ≤ 64 KB |
| `assets/logo@2x.png` | 1024×1024 | ≤ 128 KB |

The normalizer letterboxes to the canonical size, strips metadata, and
downscales progressively until the file fits its budget; `assets/manifest.json`
records every generated file (bytes, origin). Until real art lands, quiet
placeholders keep the app building.

## API (standardized surface)

The renderer talks to the app exclusively through `window.shapeday`
(`src/preload.cjs`): `call(kind, payload)`, `onTick(cb)`, `onEvent(cb)`,
`focusMain()`. One IPC channel, kind-dispatched; a 1 Hz snapshot is pushed to
every window.

Kinds: `day:get`, `task:add`, `task:click`, `task:skip`, `task:reopen`, `task:move`, `task:delete`,
`task:setEstimate`, `day:resetStatuses`, `day:clear`, `day:reviewEtas`,
`break:respond`, `break:end`, `eval:respond`, `settings:set` (incl. the `llm`
patch: `{baseUrl, apiKey, model}`), `report:get` (response carries `llm` when
a cached AI summary exists), `llm:test`, `llm:refineEtas`.

Events: `break-propose`, `break-started`, `break-over`, `break-skipped`,
`eval-prompt`, `llm:etas` (estimates updated), `llm:report` (AI summary for a
scope), `llm:status` (backend errors, surfaced non-fatally).

Core logic is plain modules under `src/core/` (UMD: `require()` in the main
process, `<script>` in the renderer — no bundler anywhere):
`model.cjs` (status machine), `timeutil.cjs`, `estimator.cjs` (the ETA
"AI" — a pure `(title, history) → minutes` function with a learned personal
planning-fallacy factor; swap in an LLM by matching the signature),
`overwork.cjs` (tint curve), `advisor.cjs` (issue pinpointing).

## Notes

- Overwork tinting is wall-clock: the clock starts the moment work hours end,
  per spec, whether or not a task is active. The overlay toggle is the
  pressure valve.
- The tint covers the primary display.
- Work hours crossing midnight aren't supported; the end time clamps after
  the start.
