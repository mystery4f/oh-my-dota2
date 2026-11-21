# oh-my-dota2 v3 — agent notes

Desktop companion for Dota 2: reads the chat through Dota 2 Game State Integration, translates it, and sends replies by
keystrokes/clipboard. No injection, no reading game memory.

Stack: electron-vite 3 + Electron 37 (Node 22.21 inside) + React 18 + TS strict + Tailwind 3.
Everything interesting lives in the main process: GSI chat intake, translation sessions, input bridge.

The speak side is one deep module: `src/main/services/voice/speech-pipeline.ts` (`speakPipeline`) owns split → synth →
ordered delivery for all three speak legs (announce / voice-out / preview) behind injectable engine adapters; drivers
(`speech.ts` announce, `voice-out.ts`, `tts.ts` preview) only decide what to speak and what to do with segments. Rule:
a synth failure skips that line — never fall back to another engine.
The IPC seam is one typed contract: `src/shared/ipc.ts` declares every channel once
(`ipcContract` + `voiceOutContract`); the renderer's `window.api`, the preload bridge
(`bindChannels` loop), and the main-process handler table (`MainHandlers`) are all derived
from it — adding a feature is contract line + handler line + call site, and a missed step
is a compile error, not a dead button. `deadChannelAudit` turns any orphan channel
constant into a compile error too.

The virtual-cable seam is two layers, never one: `src/main/services/voice/virtual-cable.ts` only answers "is the
driver there, are the endpoints there" (PowerShell over `MMDevices` + `Win32_SoundDevice` + SCM — never the
microphone, never a permission prompt; `execFile` is injectable so the probe feeds fake stdout), and
`judgeCableGap()` in `src/shared/voice-out.ts` turns {detection, currently chosen device, cable endpoint id} into one
sentence plus one button. Rules it encodes: a driver that is installed but whose endpoint has not appeared says
"restart once and retest" and offers no install button (installing again cannot help); a renderer whose device list
has not enumerated the endpoint yet says "retest" instead of offering a "use as output" button that would write an
empty deviceId; and a detection that failed says "could not check: reason" — never "driver missing". Every install
step is injectable and returns `step: 'page'|'download'|'extract'|'elevate'` plus a `VCABLE_INSTALL_FAILED` log line.
Probe install cases run in a temp dir on purpose: the real `data/vb-cable/` may already hold the setup exe, and
`existsSync` being true silently skips the download and extract legs.

The AI provider seam lives in `src/main/services/providers/`: `openai-compat.ts` declares
`ChatOptions`/`ChatMessage` (a `messages[]` array — there is no `system` field; system prompts
live in `SYSTEM_PROMPTS`) plus `chatCompletion` / `translateText`; the voice-chain summary type
is `VoiceChainSummary` in `src/shared/ipc.ts`. Read these shapes before calling the provider —
guessing the fields costs a rework round.
Provider failures are classified once, in `src/shared/provider-failure.ts` (`judgeProviderFailure`
→ `{kind, title, hint, retry, retryAfterMs}`): a thrown `ProviderRequestError` carries that object,
and `failureLine()` is the sentence the panel, the overlay hint and the log all print — never hand
a raw `模型服务返回 HTTP …` to a user, and never let one sentence cover auth, rate limit and timeout.
Retry cadence follows the class (auth/model-missing: `no`, so `durable-translator` keeps the direct
path for 30 s; timeout/network: back to the session after 1.5–2 s; 429: honour `Retry-After`).
## Commands

- `npm run dev` — dashboard with hot reload (app name `oh-my-dota2`)
- `npm run dev:stop` — kill every electron process (never touch dota2; the user plays with it open)
- `npm run dev:restart` — stop then dev, in one foreground process. Only main-process changes need this:
  renderer edits hot-reload on their own, and a settings/entry change that the watcher misses shows up as
  "the new option does nothing". When the old instance was started through a background task, kill that
  task first (`bg_kill`) instead of relying on `dev:stop`: killing electron underneath a tracked npm
  process ends it as "failed 4294967295", which reads like a real crash in the next session.
  `bg_kill` alone may not reap electron-vite within 4 s; follow it with `npm run dev:stop` when the
  old window is still alive, then check the process count before starting a new one
- `npm run build` — electron-vite build into `out/`
- `npx tsc --noEmit -p tsconfig.node.json --composite false` and the same with `tsconfig.web.json`
- `npx eslint .` — 0 errors expected; exactly 1 permanent `react-refresh` warning (button.tsx:41)
- `npm run check:shared` — rejects value-import cycles inside `src/shared/` (they pass typecheck and
  break at runtime in the renderer); `import type` edges are erased and ignored. Wired into `npm run lint`.
- `npm run check:docs` — every markdown under `docs/` must be listed in `docs/INDEX.md`, and every index
  reference must exist; a doc nobody indexes is a doc nobody reads. `scripts/check-index.mjs`, wired into `npm run lint`.
- `npm run check:pure` — assertions over `src/shared/` logic (grade distance, epoch maths) with no Electron:
  `node --experimental-strip-types`, plus `scripts/pure-resolve.mjs` for the extensionless relative imports
  Node's ESM resolver insists on. Anything with a side effect still belongs to a probe. Wired into `npm run lint`.
- `npm run panel:preview` — the dashboard in a plain browser at `localhost:5199`, no Electron and no
  game: `scripts/panel-preview.mts` serves `src/renderer/src/preview/api-stub.ts` as a fake `window.api`
  before the app boots. That stub is typed against `WindowApi`, so a renamed channel or a changed result
  shape breaks `npm run typecheck:web` instead of a click that does nothing; a channel with no stub logs
  its own name. `?s=<section>`, `?engine=sovits`, `?outEngine=sovits` put a page in the state you want to
  look at. Nothing imports the stub, so it never reaches `out/`. Playwright element screenshots time out
  here more often than page screenshots do, and a repeated identical URL may not reload — bump a `&n=`
  parameter.
  The section ids are the page names in `sections.ts`, not the file names: `?s=voice` is 音色训练 and
  `?s=asr` is 识别训练 (`?s=voice-train` silently lands on 总览). A full-page screenshot needs a
  1280x1700 viewport and `scale: 'css'`; without the resize playwright crops at its 720 px default
  and the 预检 rows look missing.
- `.githooks/pre-commit` runs `npm run typecheck` then `npm run lint` (the same two commands as CI).
  Enable once per clone: `git config core.hooksPath .githooks`; skip once with `git commit --no-verify`.
  Other worktrees live under `.dev-flow/` inside this repo, and eslint now ignores that path — a hook that
  fails on someone else's build output is a hook everybody skips.
- A probe must not assert a tight wall-clock number: the CI job runs every `ci: true` probe back to
  back on a shared runner, and two such probes here were green alone and red under load (the minimap
  frame budget measured 18.5 ms solo and 33.2 ms with 25 probes running; the download probe's
  truncated response sometimes rejected inside `fetch()` before a single byte reached `.part`).
  Assert the order of magnitude (10–200 ms, not 30 ms) and put the measured number in the JSON
  payload where a human reads it; make a flaky input deterministic instead of tolerating it — the
  download probe now stalls the response and relies on `stallMs` instead of lying about
  `content-length`, because Chromium sometimes rejects the latter outright.
- Probes: the catalogue (one line per probe, what it pins) lives in `docs/PROBES.md` — read the matching line before touching that seam.
  Run one with `npm run probe -- --<probe>`: the wrapper kills the leftover electron that would otherwise hold the single-instance lock and make the probe exit silently (the tell is exit 0 after ~3 s with no `PASS` lines), refuses a flag that is not in the registry, and hands back the probe's own exit code (`npm run probe:raw` is the bare `electron out/main/index.js`). `cmd /c "taskkill …"` is unreliable from bash (the quoting collapses and cmd just prints its banner); `powershell -NoProfile -Command "Stop-Process -Name electron -Force"` always works.
  The list is generated: `src/main/probes/registry.ts` holds one row per probe (flag, summary, run fn) and `index.ts`
  dispatches from it — add a probe by adding a row, then `npm run probes:doc`; `npm run check:probes` (inside `lint`)
  fails when the catalogue drifts. CI reads the same table: a row marked `ci: true` is what the `Pure probes` job runs,
  and `npx electron out/main/index.js --probes-ci` prints those flags — never hand-write that list in the workflow again.
  `--hold-watch-probe` runs in three layers and prints SKIP for the one it cannot judge: the resident PowerShell
  really starts and reports `OK`; a fake child speaking the same `OK`/`HOLD 1`/`HOLD 0` protocol proves each edge is
  recorded once; a child that never starts proves the fallback surfaces with a reason. Injected `keybd_event` is
  skipped, not failed — this desktop drops it (in-process injection leaves `GetAsyncKeyState` at 0), so the probe never
  claims real keys were verified here.
  Exit codes and the flush-before-exit rule live in `src/main/probes/harness.ts`
  (`exitProbe` / `finishProbe` / `reportProbe`): never call `app.exit(0)` unconditionally — that is how a failed probe
  used to look green, and eslint now rejects `app.exit` / `process.exit` anywhere under `src/main/probes/`.
  A probe that hangs and a probe that threw look identical without help: the dispatcher prints `PROBE_START {flag,at,pid}`
  before `run()` (#158), a rejected run goes through `failProbe()` and prints `PROBE_THREW <flag> <message>`, and a probe
  that may wait forever calls `guardProbe(name)` so a 20 s stall becomes one SKIP plus exit 0 instead of a 400 s kill.
  Segment text inside a probe is always derived from `splitForSpeech(...)` — `segmentChars: 2` quietly became 10 when #85
  moved splitting into `src/shared/speech-split.ts`, and the stale gate keys threw in an async body where nothing heard it.

`--train-probe` pins the training decision seam: mutexes, preflight, run state, VRAM advisory
  (`judgeFtVram`/`ftVramNote` four-case), export completeness (`missingFtExportFiles` three-case),
  dataset split (`splitTrainEval` holds out the tail), and CER grading (cohorts never merged).

- The second-screen board (#124a) is a 320-wide frameless always-on-top window that reads only
  `window.api.matchSnapshot()` — the one summary the main process copies out of the GSI frame. It must never
  create a second GSI reader, and `src/main/windows/board.ts` must not import the overlay manager: "closing the
  board leaves the game untouched" is structural, not a condition. Missing blocks render `—` (never a guessed
  `Lv1`), and with no snapshot the whole bar says "先把 GSI 那条连通" instead of showing an empty shell. Its
  position lives in `settings.boardBounds`, deliberately not `overlayBoundsByDisplay`.
- `Row` has a `note` slot (#151): a long sentence belongs there, never in `children`. The control slot is
  `shrink-0` and the label column is `flex-1 min-w-0`, so a full sentence passed as a child takes its own width
  and squeezes the label to ~0 — Chinese then breaks one character per line (measured: 46 px tall, 21 lines at
  1280). `note` renders on its own full-width line under the control and wraps. Two call sites today: the virtual
  cable gap line and the interpretation chain line.
- Second screen (#124b) has ONE data source: `noteSnapshot(payload)` in `src/main/services/match-snapshot.ts` is
  fed by the same frame `src/main/services/gsi.ts` already parsed, and `currentSnapshot()` is what the window
  reads through `match:snapshot` — never a second GSI listener. `cfgBody` already requests hero/items/abilities
  (the 2026-10-25 "turn them all on" pass), so the cfg itself needs no change here; **any cfg change still means
  the user must restart Dota**, and that hint already lives on the library row. A missing block reads as `null` and
  must never reach the stall warning — `gsi-stall.ts` judges frames, not fields. `abilities` keeps levels only:
  cooldowns tick every frame and would turn the 5-second summary into noise.
## Panel

The dashboard is `src/renderer/src/panel/` and it is the only one: `panel-app.tsx` shell +
`sections.ts` (ten sections; a forgotten `switch` case is a compile error) + `pages/*.tsx` +
`components/primitives.tsx` (the whole typography and spacing scale lives there). Navigation is
the sidebar alone; `?s=<section>` deep-links. Rules the layout encodes: every setting has one
home, saving is immediate so there is no 保存 button, `StatusPill` only for state that can change,
colour only for selection / primary action / warning. Full file inventory and the deliberate
deviations: `docs/DESIGN-panel-v2.md`, `docs/ARCH-notes.md`.

## Training (音色训练 / 识别训练)

Two sections, two shapes. 音色训练 keeps 数据 → 运行 → 产物. 识别训练 is a left rail of four steps
(环境 / 数据 / 训练 / 现役) with one six-state headline above the selected step (缺环境 / 数据不足 /
可开训 / 训练中 / 现役 / 上次失败): the headline says where you are and carries that state's one primary
action, every other mutation lives in the step that owns it. Only the active engine is trainable
(`finetune` in the engine table), 全量 retrains from the base model over all data while 增量 continues from
the fine-tuned model over takes no run has consumed, training success promotes the model automatically
(`applyAsrFtModel` in the manager's terminal path), and 自定义录音 is just the `G99` script group — text
first, then record. No training window, no `train:open` channel. A run is
`src/shared/train/run.ts` (one row in `userData/train/runs.db`, plus one `dataset_entries` row per
recorded take; metrics read back from the artifacts), the gate is `src/shared/train/preflight.ts`
(only `block` disables 开始训练), and mic capture stays in `panel/use-recorder.ts`. File list,
artifact paths and parser details: `docs/ARCH-notes.md`, `docs/PLAN-train-v3.md`.
「测一遍」(全量识别比对 in the 数据 step) runs the active model over the ledger and ranks rows by CER —
`src/shared/train/cer.ts` owns `normalizeSpoken` / `spokenDistance` / `measureCer` / `rankByCer` /
`summarizeCer` (one place, so grading and CER cannot drift apart), and it reports three cohorts separately:
`train` (a fine-tune run consumed it — memory), `eval` (the held-out tail of `splitTrainEval` — generalisation),
`unknown` (no run_id). Never collapse them into one number. A corrected row is written back to the ledger
(`correctAsrCheckItem`, new revision) because that text is both the training label and the next answer key.
Every engine keeps a factory copy at `asr-models/<engine>-base/` (`docs/adr/asr-base-copy.md`): promotion only
rotates `<engine>` ↔ `<engine>.bak`, so after two promotions that copy is the only original left. It is written
once on first use (`ensureBaseCopy`, from the shipped model or the still-pristine active dir), verified against
the engine table's `requiredPaths`, and never repaired afterwards — a gap is only *reported* (`target.baseCopy`
in `asrFtStatus`, the 底模副本 row in the panel). 重置为底模 stages a copy into `.next` and runs the same
`asrFtSwapSteps`, which is why the previous weights end up in `.bak` instead of being deleted.


## Hotkeys

Every global hotkey is rebindable in the panel (`浮层与对局 → 热键`). The table lives in `settings.json` under
`hotkeys` (action id → canonical accelerator, `''` = unbound) and is served by `src/shared/hotkeys.ts`; registration
happens in `src/main/services/hotkeys.ts`, which unregisters everything and re-registers the whole table on every save.

- `overlayToggle` (default `Alt+Shift+O`) show / hide the overlay
- `overlayLock` (default `Alt+Shift+P`) lock / unlock the overlay
- `overlayCollapse` (default `Alt+Shift+B`) collapse / expand the overlay to its 132x34 icon
- `inplaceSend` (default `Alt+Shift+T`) the only text out: reads the game chat draft (Chinese typed, not yet sent), translates, pastes back and presses Enter
- `overlayPanel` (default `Alt+Shift+H`) summon panel: the overlay temporarily becomes an interactive sheet (history 200 rows / quick phrases / AI suggestions, click a row to copy); pressing again or Esc closes it and restores click-through
- `markGood` / `markBad` (default `Alt+Shift+M` / `Alt+Shift+N`, #87) mark the last translated overlay row as a good or
  bad translation and append `logs/translation-marks.jsonl` (source, translation, verdict, `matchid` from `liveMatchId()`
  or an explicit null, provider/model, whether the cache served it). `src/shared/translation-mark.ts` is the single
  account: untranslated rows never become samples, a re-mark replaces the earlier verdict by `entryId`, tallies group by
  provider × model. A hotkey never goes silent — no markable row still flashes why, and 0 marks reads as "还没标过",
  never as "all fine". This records *marked* samples only; never quote it as an overall accuracy number.
- A readiness warning must carry a way into the check (#140): `machineCheckOffer()` in `src/shared/env-report.ts`
  decides whether the「看这台机器」entry shows (only when something is actually not ready — a green-but-clickable button
  reads as "this fixes something"), and `openMachineCheck()` in `panel-app.tsx` navigates through the existing
  `select('overview')` + `?s=` deep link, then scrolls `#machine-check` into view one frame later because the overview
  is lazily rendered. The label lives once in `MACHINE_CHECK_LABEL`; a new alert spot calls that seam instead of
  hardcoding the words.
- Voice-capture three-state ring (#94): the stage line starts with a small ring in `src/renderer/src/overlay/voice-ring.tsx` — hollow=idle, filled=recording, waves=speaking; shapes differ so a grey screenshot still tells them apart. Recording/speaking truth lives once in `voice-ring-store.ts`; `voice-capture.ts` and `speech.ts` only call `setRingRecording`/`setRingSpeaking` (keep that, never revert to bare assignment — the ring and the speech queue both read it).
- `voiceCapture` (default `Alt+Shift+V`) record → speech chain: speak Chinese → the active recognition model (`asrActiveModel`:
  Qwen3 or Paraformer) transcribes → translate → the reply is spoken through voice-out. How it is pressed is
  `voiceCaptureMode` (`hold` by default; the panel's 热键 → 语音对讲怎么按): **hold** = recording runs while the chord is
  down and the chain fires on release, **toggle** = press to start, press again to trigger. `globalShortcut` only reports
  key DOWN, so hold mode does not use it: a resident `hotkey-hold.ps1` (bundled through `?raw`, deployed by `deployPsScript`) polls `GetAsyncKeyState` at
  40 ms (`src/main/services/input/hotkey-hold.ts`) and emits `HOLD 1` / `HOLD 0`; the watcher restarts 5× with 3 s backoff
  and falls back to a `globalShortcut` toggle when it gives up — the hotkey must never go silent. Never register both paths
  for `voiceCapture`: one press would start and stop in the same instant. Keyboard auto-repeat is debounced 500ms in
  `toggleVoiceCapture` (toggle mode only; the watcher emits one edge per physical press).
  Every outcome of that resident script is registered once in `src/main/services/input/hold-selftest.ts`
  (starting / resident / fallback + reason + the last 24 edges) and served to the panel through
  `hotkey:hold-selftest`; the panel's 热键 → 按住检测 row is the only place a user can tell "按下真的被听见" from
  "按住已经失效、现在是敲一下". A fallback state must say 按住不生效 and how to use 敲一下 — never "已恢复".

- Cockpit channel data (#160): `src/shared/speaker-channel.ts` is the only place that decides what a
  speaker channel is — labels come from the SEAT (`我` / `队友 2` / `对手 3`), never from a cached name or OCR,
  because a real match never delivers `allplayers` (measured: 3499 frames in match 9061130332, zero allplayers).
  Three empty states are part of the contract: no chat means an empty array (the UI writes 这局还没人说话, never ten
  grey channels), a `matchid` change clears the ledger, and an unknown own seat makes every channel `unknown` and
  says 认不出谁是谁 instead of guessing. The ledger (`src/main/services/voice/speaker-channels.ts`) is fed from
  `gsi.ts`, served through `voice:speaker-channels`, and `--speaker-channel-probe` pins all three rules.
- Per-speaker muting (#93): `src/shared/speak-mute.ts` owns identity extraction (hero short name plus the
  `[name]` segment of the display string), list normalisation and `isMuted()`. `speakSkipReason()` reports
  `muted-player`, never the global `mute` — the log must tell "this person is muted" from "reading is off".
  A missing identity is never a reason to mute; `own` lines are governed by `ttsReadOwn` alone.
- Sentence splitting (#85): `src/shared/speech-split.ts` is the only splitter —
  `splitForSpeech(text, maxChars, strategy)` with `punctuation` (default, punctuation-first) and
  `uniform` (fixed length). The panel's preview calls the SAME function, so a preview can never
  disagree with what the pipeline does; never re-implement the split at a call site. Both strategies
  must join back to the input byte for byte (a dropped punctuation mark is a different sentence).
- Shadow mode (#80): `src/shared/shadow-voice.ts` owns the three states and the one line the panel shows;
  `src/main/services/voice/shadow.ts` owns the ledger (`logs/shadow-voice.jsonl`) and the "has a match ended"
  question. `speakReply()` / `interpretSpeak()` return BEFORE queueing or synthesising while it is active —
  never implement it as a volume knob. It ends by itself once one match has been archived, so never add a
  manual "turn it off after the first match" chore, and never let the panel compute the state a second time.
Two actions may never share an accelerator — the panel refuses the whole table and marks both rows. A key another
program already owns is reported per row (`被占用`), never silently dropped: that is the only visible form of "I pressed
it and nothing happened". The overlay and the pause hint print key names from the live table
(`OverlayStatus.hotkeys`, `captureHint({ toggleKey })`), so no user-facing string may hardcode a shortcut.

## Environment constraints (China, Windows)

- npm: `--registry=https://registry.npmmirror.com`; Electron postinstall needs
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- Foreign sites only through proxy `http://mcr:4444`.
- `taskkill /F` under Git Bash eats `/F` as a path — run it as `cmd /c "taskkill /F /IM electron.exe"`.
- `registry.npmmirror.com`, `hf-mirror.com`,
  `api.xiaomimimo.com`, `api.deepseek.com`, `open.bigmodel.cn` are domestic — go direct.
- If `node_modules/electron/dist/electron.exe` is missing (silent postinstall failure), download
  `electron-v37.*-win32-x64.zip` from npmmirror and extract with `C:\Windows\System32\tar.exe`
  (Git Bash's tar is GNU tar and cannot read zips), then write `electron.exe` into
  `node_modules/electron/path.txt`.

## Where state lives

- Everything lives in a portable data directory owned by `applyPortableUserData()` in
  `src/main/services/data-dir.ts`, which repoints `userData` before `app.whenReady()`:
  - installed build: `<parent of install dir>/<install dir name>-data` — `G:\oh-my-dota2` →
    `G:\oh-my-dota2-data`. Sibling rather than inside, because the NSIS uninstaller wipes
    `$INSTDIR` wholesale; outside it, uninstalling cannot touch the data (see `build/installer.nsh`).
  - `npm run dev` and probes: the project-root `data/`.
  - falls back to `%APPDATA%` only when the target directory is not writable (e.g. Program Files).
  First run merges `settings.json` field by field and copies the ledger from the older locations
  (AppData, and the previous `<install dir>/data`), never overwriting what is already there.
- Translation sessions: `data/sessions/translator-<sha1(provider) 8>.sqlite` plus a
  sidecar `conversations-<hash>.json`. One file per provider, so probe/provider changes never poison
  the real history.
- Logs: `logs/inplace.log` (input bridge stages),
  `chat-inplace/` (deployed ps1), `console-send/`, `whisper/{bin,models}`, `tts-preview/`.
  `asr-models/` (every recognition model lives under here or `voice-runtime/models/`; which ones
  exist and which is active comes from the engine table in `src/shared/asr/engines.ts` plus the
  directory scan in `src/shared/asr/models.ts`, and `settings.asrActiveModel` pins one by id —
  adding an engine is one table row + one `ASR_KINDS` adapter in
  `resources/asr-sherpa-worker.cjs`, never a new branch per call site),
  `asr-ft/` (ASR accent fine-tune recordings from 识别训练's recording panel:
  one wav per line, `Gxx/Gxx-Lnn.wav` (or `Gxx-Tnn.wav` for the free-speech group); the
  recording script ships as a bundled resource, `resources/asr-ft-script.md`, and a
  `<userData>/asr-ft-script.md` copy overrides it in the same `## Gxx` shape; a broken
  custom file falls back to the bundled one with a panel warning, never a blank page),
  `train/runs.db` (训练记录 + 数据集账本, one SQLite file opened with the same built-in
  `node:sqlite` driver as the translation ledger: `runs` = one row per training attempt,
  `dataset_entries` = one row per recorded take revision with `run_id` NULL until a run trained
  it, capped at `TRAIN_RUN_KEEP` 200 newest runs — the only history of what was trained, with what
  data, and where the artifacts went; metrics are read back from the run's own
  `checkpoint-*/trainer_state.json` or GV `logs/<exp>/train.log`, copied onto the run row as
  `runs.metrics` for the panel while the artifact stays the trainer's own record),
  `asr-ft-runs/` (one `ft-<stamp>` dir per attempt, ~15 GB of weights each). A successful
  swap prunes every dir except the current run and the next incremental source
  (`pruneAsrFtRunDirs`, `docs/adr/asr-ft-run-retention.md`); the row keeps its metrics but
  loses `artifacts.runDir`. Nothing is deleted when the source cannot be computed),
  Nothing survives a kill either: `will-quit` calls `trainManagerIfStarted()?.shutdown()` (kill the
  process tree, write the run as failed) and `reconcileTrainState()` runs once at startup — a
  `running` row left by a hard kill becomes `failed`, and a `<model>.next` without any export
  artifact is a staging copy that gets deleted (`docs/adr/train-crash-reconcile.md`). The same ADR
  makes the repo the source of truth for the training scripts: `resolveAsrFtTrainRequest` copies
  `resources/asr-ft/*` into the env before every start, so a hand-edited env copy is overwritten),
  `train-runs/` (legacy archive: the pre-SQLite one-JSON-per-run files, imported once on first
  open of the database and never written again),
- Auto-capture telemetry: `logs/capture-ticks.jsonl`, one line per polling tick, hard-capped at 1 MB
  (truncated and rewritten past that). Fields worth reading: `act` = `ocr|same|gap|idle|error|busy`,
  `src` = `stream|sources`, `brk`/`rst` = new-match streak and reset, plus `grabMs`/`ocrMs`/`chg`/`fresh`/`streak`. It is the only way to tell
  "auto mode is quietly doing nothing" from "auto mode is working", so check it before trusting any
  claim about capture stability.
- GSI chat evidence: `logs/gsi-chat.jsonl`, one line per `chat_message` event Dota pushes
  (`at`/`channel`/`slot`/`name`/`own`/`gameTime`/`text`), hard-capped at 256 KB. Only exists once the cfg
  enables the `events` data block; it is how the "does GSI really carry chat text" claim gets
  checked against what is actually on screen.
  Dota pushes each chat message about 26 times in a row, so the writer keeps a bounded dedupe set
  keyed by game time + player + channel + slot + text.
- Voice reply timing: `logs/voice-chain.jsonl`, one line per 对讲 (`at`/`matchid`/`spoken`/`stage`/`engine`/`chars`/`segments`/`mic` +
  `asrMs`/`translateMs`/`firstAudioMs`/`playStartMs`/`speakMs`/`totalMs`), hard-capped at 256 KB through the same
  `appendCappedJsonl` the capped writer uses. A leg that was never measured is `null`, never 0; `totalMs` counts from the
  ASR start to the first sound, so it is the number the operator actually feels. The console twin is the
  `VOICE_CHAIN_TIMING` line; the overlay prints `已播 · 起播共 X` and the panel's 识别记录 row prints the full breakdown.
  `mic` is the input device that actually opened (`label|` plus the first 8 chars of the deviceId): the raw id is salted
  per origin, so it means nothing outside the app — read the label, not the id.
  `matchid` comes from `liveMatchId()` (`src/main/services/gsi-match.ts`): only a frame that arrived within the last 90 s
  counts, so a row written in the menu or after GSI died carries an explicit `null` — never a guessed id.
  Read it before claiming any leg is fast or slow — the ASR receipt in `chain-timing.ts` is single-use within 60 s.
- GSI frame summary: `logs/gsi-summary.json`, written by the app itself every 5 s while frames arrive
  (atomic replace, per-match reset when `map.matchid` changes, final flush on `POST_GAME`).
  A `map.matchid` change archives the previous match first to the per-match copy
  `logs/gsi-summary/<matchid>.json` — not only on `POST_GAME`, because a match can end without one
  (quick requeue, disconnect) — so the archive holds the whole evening while the live file always
  holds only the current match. The archive is pruned to the newest 20, and the current match is
  never deleted. It answers what the raw frame dump cannot: real match or training ground, whether
  `allplayers` is actually delivered, and which `event_type`s exist. It lives in the app rather than
  a probe because port 32123 is single-owner — a probe would force closing the app exactly while a
  real match is being observed.
- GSI 断流是诊断，不是自愈（`src/shared/gsi-stall.ts` + `gsi.ts` 的 `watchdogTick`）：Dota 只在启动时
  读一次 `gamestate_integration/*.cfg`，运行中的游戏任何进程内手段都重载不了它。所以超过 90 秒没帧且
  仍认为在打对局时，应用只做三件事——按当前端口重写一次 cfg（让「重启 Dota」真的能连上）、写一行
  `GSI_STALL_DIAG` 到 `logs/gsi-stall.jsonl`（cfg 在不在、端口是不是自己占着、静默多久、有没有重写）、
  在总览的「异常」组挂一条告警。**告警文案只许说「重启 Dota」**，任何「已恢复/已重连」的说法都是假的；
  断流判定会一直粘到下一帧到达为止，因为心跳超时之后 `live` 已经被清掉，光靠实时判定就再也算不出
  「刚才断过」。一次断流只诊断一次（`stallHandled`），探针用注入时钟推快，不真等 90 秒。
- Two parallel auto paths: `chatSource: 'ocr' | 'gsi'` picks where chat text comes from. `gsi` never
  never touches the screen and does not need a chat region; text arrives through
  `gsi.ts` → `pushChat` → `ChatCaptureService.pushMessages()`. `ocr` is the original polling loop.
  Manual mode always uses the snapshot path regardless of the setting.
- Multi-library Steam installs: `settings.gsiLibraryRoot` pins the chosen library root (empty = auto).
  The cfg is written into the chosen library only — a moved/renamed library reports `路径缺失`
  instead of silently redirecting to another library (`resolveGsiRoot`'s `missing` flag). Dota reads
  GSI config only at launch, so the panel says the game must restart after switching libraries.
- GSI config: the app writes `gamestate_integration_ohmydota2.cfg` into
  `<steam library>/steamapps/common/dota 2 beta/game/dota/cfg/gamestate_integration/` on startup (Steam
  path from `HKCU\Software\Valve\Steam` + `libraryfolders.vdf`). It points at `http://127.0.0.1:32123`;
  every tool gets its own cfg, so Logitech's `gamestate_integration_logitech.cfg` on 3002 keeps working.
  Our cfg enables `provider`/`map`/`player`/`events` — `events` is what makes in-game chat arrive as
  `payload.events[]` `chat_message` entries (11 = all, 12 = team). Dota 2 reads these cfg files only
  at launch — restart the game after the first write.

## Hard rules learned the hard way

- An external `RegisterHotKey` probe proves nothing about Electron's `globalShortcut`: both can hold the
  same accelerator, so a "free" answer is not evidence of a dead hotkey (this cost a whole debugging
  round: every probe said FREE while the app was happily toggling the overlay). Verify by effect — inject
  the accelerator (`SendKeys("%+o")`) and watch the visible outcome — or read the app's own
  `HOTKEY_REGISTER_FAIL` line.
- `data/settings.json` is rewritten by the app on every save, with normalization; a hand edit looks like
  it "reverts itself". Read it to learn the current values, change values through the panel.
- Every main build prints `BUILD_STAMP {at,bytes}` at startup. When a change seems to have no effect,
  compare that timestamp with `out/main/index.js` before debugging the code: a `bg_run` dev task dies
  together with electron, and the watcher stops rebuilding without any error.
- Game audio vanishing for a moment while the app talks is almost never the app: the speak key makes Dota
  open its own mic, and Dota ships `snd_mixahead 0.001` (a 1 ms audio buffer) in its own convar file. Panel
  `测试模式` (play only, no key press) is the one-click split — if that does not hitch, the pipeline is
  innocent. Fix lives in the game's `autoexec.cfg`; the detail and values are in `docs/NOTES.md`
  (「起播那一下游戏静音又掉帧」).

- Every download goes through `src/main/services/net/download.ts` — one entry (`downloadResumable`),
  one mirror table (`tryMirrors`), one probe (`--download-probe`). A new fetch call site that writes its own
  `.part` handling is the bug this file exists to prevent. When a mirror is used it logs `DOWNLOAD_MIRROR`
  with the prefix and candidate; when a server ignores `Range` the partial file is dropped, never appended to.
  A total failure throws `judgeDownloadFailure()`'s sentence (`src/shared/download-failure.ts`): connection-level
  errors read as 网络 (another mirror may help), status/size/hash errors as 源站 (no mirror will).
- Batch scripts that call an external API per item (LLM review, ASR, downloads) must give every
  request its own timeout plus retries and append results as they arrive. Bare `Promise.allSettled`
  hides one hung request: 80/1012 rows in 20 minutes (≈4 hours total) became ~40 rows/minute after
  `AbortSignal.timeout(180000)` + 3 retries + concurrency 8.

- `.ps1` files shipped into `userData` must be **pure ASCII**. PowerShell 5.1 decodes BOM-less files
  with the ANSI codepage; a Chinese comment can swallow the trailing newline and produce a parse
  error pointing at an unrelated line. Only `ocr-bridge.ps1` may keep Chinese, and it is deployed
  with a BOM.
- `SendInput`: per-character VK and mapped SCANCODE events both reach Dota 2; `KEYEVENTF_UNICODE` is
  dropped by SDL. Source 2 **console** ignores every form of paste (only logs
  `Unknown command: [`), while the **Panorama chat box** accepts injected `Ctrl+A` / `Ctrl+C` /
  `Ctrl+V` — do not generalize conclusions between the two.
- Keystroke timings for Panorama: hold 20 ms, gap 25 ms (~85 ms per combo) is reliable; tighter
  values drop keys. The grab path re-selects with slower timings when the first attempt yields
  nothing, and reports `retried` in the log.
- Resident PowerShell bridges are long-lived: on restart, `child.on('close'|'error')` must check
  `this.child !== child` before clearing state, otherwise the old process wipes the new reference.
- `node:sqlite` opened `readOnly` cannot see data still in `-wal`; stale main file + fresh
  `-wal`/`-shm` mtimes means the writes are there. Read without `readOnly` when inspecting.
- Screen capture: the resident `getUserMedia` stream is 12–20 ms per frame, but WGC fails with
  `E_FAIL` under exclusive fullscreen — the app starts with
  `--disable-features=AllowWgcScreenCapturer` so Chromium falls back to DXGI/GDI. Judging "it works"
  means the picture changes, not that the log is quiet. The `desktopCapturer.getSources` path
  (300–900 ms) stays as the automatic fallback.
- Regions are stored in DIP; multiply by `display.scaleFactor` before cropping a physical-pixel
  thumbnail. `desktopCapturer` thumbnails and `stream` frames are physical pixels.
- Translation sessions are keyed per (direction, tone, scope): `prod` for gameplay, `try` for the
  trial tab, `warm` for warm-up. Never let probe or trial traffic land in the `prod` slot — it becomes
  few-shot poison. A stalled turn must be aborted (`conversation.abort`) or the next submit queues
  behind it forever.
- Text edits here are performed through `pi.edit`/`pi.write`; any content containing backticks or
  template literals must go through the tool's `payloads` parameter. PowerShell one-liners in bash
  lose their `$variables` — write `.tmp/*.ps1` and run it with `-File`.
- hashline anchors belong to one file: reusing a `write` auto-read anchor while editing a different
  file lands the edit silently in the wrong place (an import once ended up inside a function body).
  `grep` the file you are about to edit and take the anchors from there; a single-line `replace`
  must repeat the whole original line or the surrounding lines duplicate.
- `eslint` allows exactly one warning (`--max-warnings 1`), so any non-component export in a `.tsx`
  file breaks the build: pure helpers (`runTone`, `formatDuration`, …) live in their own `.ts`
  module next to the component.
- Main-process errors: `src/main/services/error-log.ts` installs `uncaughtException` / `unhandledRejection`
  hooks before `app.whenReady()` and appends `{at, kind, message, stack, context}` to `logs/errors.jsonl`
  (256 KB cap, ring of 50 in memory); `src/shared/error-log.ts` owns what counts as one error and the single
  line the panel reads (关于 → 诊断 → 最近的错误). The hooks never swallow: Electron's own dialog still
  appears. Never let the recorder throw — a logging failure that propagates is a second incident. Renderer
  errors are not forwarded yet; that needs its own channel, not a wider hook.
- Provider board (#114): `chatCompletion()` records one line per call into `logs/provider-metrics.jsonl`
  (through `chatCompletionInner`, so the wrapper times the whole thing and classifies failures with
  `provider-failure.ts` — never a second classifier). `src/shared/provider-metrics.ts` owns the summary:
  median latency (a single timeout must not move it), failure kinds counted separately, and an empty
  board reads "nobody called a model" rather than 0% success, which looks like total outage.
- The 20-second recording cap is not "the user finished" (#97): when `RECORD_MAX_MS` fires the overlay
  stage says 等太久了，已停止 and the stop reason travels to main (`VoiceStopReason = 'release' |
  'silence' | 'timeout'`), which writes one `{"stage":"capture-stop","reason":"timeout"}` line into
  `logs/voice-chain.jsonl`. A cap that stops silently reads as "the key broke".
- Target language (#120): `src/shared/target-language.ts` decides the ONE language a line is translated
  into — `targetLang` for foreign lines (default 简体中文), `targetLang2` for Chinese lines (default
  English) — and an unknown code falls back to the default rather than reaching the prompt. Only a
  non-default target appends the single `Output language: …` line, so the default path is byte-for-byte
  the old prompt and one call still produces one line.
- Quick phrases (#117): `src/shared/quick-phrases.ts` owns groups, `{hero}`/`{time}`/`{matchid}`
  substitution and the rule that an empty group is hidden — not rendered as an empty shell. Placeholders
  it does not recognise (a typo like `{heor}`) stay verbatim, so the mistake is visible instead of being
  swallowed. Values come from the latest GSI frame (`src/main/services/voice/phrase-context.ts`, 90 s of
  staleness) — the previous match's hero must never fill this match's line.
- The panel shows the probe list, it does not run probes (#112): `src/shared/probe-catalog.ts` turns the
  registry into rows, splitting them by the `readOnly` marker alone, and every row carries the exact
  `npm run probe -- <flag>` command. A probe needs Electron's single-instance lock and calls `app.exit()`
  when it finishes, so running one from inside the app is impossible — no row may claim otherwise.
- Probes never write user data (default, not a habit): `src/main/index.ts` points `logsDir()` at a fresh
  `mkdtemp` dir whenever the process was started with a probe flag, so synthetic frames and fake matchids land in
  the temp dir and vanish. A probe that genuinely needs the user's own logs declares it in the registry row —
  `realLogs: true`, currently only the ones that read a finished match or produce something a human replays
  (`--gsi-dump-report`, `--match-report`, `--gsi-dump`, `--interpret-listen`, `--minimap-probe`) — and those must
  only read. Everything log-shaped therefore has to be derived from `logsDir()`, never from
  `join(app.getPath('userData'), 'logs', …)`; `--logs-isolation-probe` fails when that breaks, and the only real
  proof is a full CI-probe sweep leaving `sha1sum data/logs/*` unchanged.
- Replay stars (#118): `src/shared/replay-star.ts` is the one place that decides what a star is —
  a line with source and translation, stamped with `liveMatchId()` (null when no frame is live, never the
  previous match). `starsOf(stars, matchid)` reads ONE match and returns empty for a match nobody starred;
  never widen it to "all" for convenience. Repeat starring the same line counts once (later note wins).
  Storage: `logs/replay-stars.jsonl` through `appendCappedJsonl`; the hotkey `starLine` must always flash a
  sentence (a silent no-op reads as a broken key).
- Overlay readability (#100): font sizes and every text colour live in ONE table, `src/shared/overlay-a11y.ts`
  (`FONT_SCALE`, `OVERLAY_TEXT_PAIRS`, `OVERLAY_STATE_MARKS`); `src/renderer/src/overlay/overlay.css` may only use the four
  `--ov-fs-mini/small/body/title` variables switched by the root's `data-font` — `check:pure` fails on a literal `font-size` or on
  a pixel that disagrees with `overlayFontScale()`. The AA numbers the probe prints are measured against `ROW_BACKDROP` over
  black, which is NOT the same as "readable on any game frame": a bright scene is covered by `text-shadow` and cannot be
  computed offscreen, so never quote the ratio as proof of the latter. Any state a colour expresses must also carry a
  non-colour marker (`.spoken.ok` → `✓ `, `.spoken.err` → `✕ `, a hint → `⚠ `) — adding a colour without adding its pair to
  the table leaves that pair unchecked.
- Look-at-the-screen (#135): one hotkey, one frame, one answer in the summon panel's 看一眼 tab. Images travel as
  `data:image/png;base64,...` inside `ChatMessage.content` parts and never touch the disk or `logs/` — the probe asserts the
  logs listing is unchanged. Vision capability is a NAME heuristic (`isVisionModel` in `src/shared/vision.ts`), so the
  refusal text must be "换一个能看图的模型", never "this model can't take images". Three failures stay three sentences:
  model can't see / frame is empty / model didn't answer. Never poll or pre-capture: every shot is a billed call the
  user asked for by pressing the key.
- Per-display geometry (#101): `settings.overlayBoundsByDisplay` maps a display id to that screen's geometry (max 8,
  oldest dropped). `planBounds()` in `src/shared/display-geometry.ts` decides which one applies right now — a display
  still present gets its memory clamped into its own work area, a display that is gone sends the overlay back to the
  primary **fully inside** it (`fitInside`, not `clampGeometry`'s 80px grip: that grip is for a window the user dragged
  off-screen, while a vanished display is nobody's mistake). `overlay.ts` is the only place that translates
  `OverlayPersistPatch.overlayBounds` (a virtual key — the state machine must never learn display ids) into the map,
  and it listens to `display-added` / `display-removed` / `display-metrics-changed` to re-plan on the spot. Legacy
  `overlayBounds` migrates under `LEGACY_BOUNDS_KEY = 'previous'`, a key no display can match, so it lands on the
  primary by the same rule instead of needing its own migration branch.
- Overlay diagnostics: a locked overlay is click-through *and* content-protected, so it is absent from
  every screenshot and ignores the mouse. Never conclude "the overlay is not showing" from a desktop
  capture — read the panel badge or the `overlay:status` payload instead. Both rules are pure seams in
  `src/shared/overlay-geometry.ts`: `shouldIgnoreMouse(locked, panelOpen)` and
  `shouldProtectContent(locked, panelOpen)`. The summon panel (`Alt+Shift+H`) is the one state that must
  stay both clickable and capturable — otherwise the buttons you were called over to press do nothing.
  Pass no `forward` option: it forwards mouse-move messages to the page, so a locked overlay still
  lights its hover styles and looks clickable while clicks go to the game. Locked means invisible to
  the mouse — no highlight, no drag, no wheel; only the summon panel makes it clickable again.
- "The game covers the overlay" is almost never a z-order bug: exclusive fullscreen is a DXGI swapchain no
  window can draw over, and `setAlwaysOnTop` cannot fix it. Read the game's own
  `<steam>/userdata/<account>/570/local/cfg/video.txt` (`setting.fullscreen = 1`) — `--dota-display-probe`
  answers it in one command, and the panel's 浮层 → Dota 2 显示模式 row says it in Chinese
  (`src/shared/dota-video.ts`). 全屏窗口 is still a normal window, so the overlay works there.
- Hiding the overlay is not an A/B for "the overlay repaint is the cost": `startVoiceCapture()` and
  `toggleVoiceCapture()` both call `show()` when the window is hidden, so it reappears the moment you speak
  (`overlayCollapsed` is ignored by that path too — set it through the panel, then check the settings file).
  Collapse (`overlayCollapse`) is the variant that survives, because `show()` honours `s.collapsed`.
- Docs/notes edits: a heredoc or `node -e "..."` line carrying backticks gets those backticks executed
  by bash before the file is written; markdown table rows and inline code vanished that way twice.
  Use the file-edit tool for anything containing backticks, template literals or `$(...)`.
- Multi-line `node` scripts go to `.tmp/*.mjs` and run as `node .tmp/x.mjs` — never inline
  `node -e "…"` with nested quotes: the escaping accidents of one session produced a CRLF regex
  that silently matched nothing, a dump guard that never actually got inserted, and nine junk
  files at the repo root. If the script must verify it was written, grep the file after running it.
- TTS: never fall back to the system voice when synthesis fails — skip that line silently instead.
  Two voices trading places mid-match is the exact bug users report as "the voice suddenly sounds
  wrong". The free Edge endpoint needs a warm connection pool, one retry, and it returns 0 bytes
  instead of an error, so a byte-count check is the only reliable failure signal.
- sherpa ASR (two engines: `qwen3` and `paraformer`; SenseVoice removed) runs in a plain `node` child
  (`resources/asr-sherpa-worker.cjs`, request `{id, kind, wav, dir, hotwords}`) for the same
  sherpa reason as the TTS worker; the worker logs `ASR_SHERPA_*` markers, and `kind` comes from the
  engine table — the probe cross-checks the table against the worker's `ASR_KINDS` keys both ways.
  The worker keeps **two** recognisers (`MAX_RECOGNIZERS = 2`, an LRU `Map`, #142), because short/long
  routing switches engines per clip and one slot meant rebuilding the graph on every switch (measured
  13.2 s to qwen3, 6.5 s back). Two entries, not unlimited: the hotword string is part of the cache key,
  so editing hotwords mints a new graph each time. `ASR_SHERPA_LOAD|HIT|EVICT` shows who was rebuilt,
  served from cache, and dropped; the switch cost is memory for two int8 models, so any user-facing hint
  must say that instead of "a bit slower". `--asr-switch-probe` runs the real worker and is not in CI
  (needs both models on disk; SKIPs with the missing engine named).
  Qwen3 needs all three onnx files plus `tokenizer/` (vocab.json + merges.txt); paraformer needs
  `model.int8.onnx` + `tokens.txt`, emits no punctuation, and ignores hotwords (sherpa only does
  hotwords for transducer models).
  Hotwords (`asrHotwords` setting, comma-separated) are a constructor-time config — the worker's
  recognizer cache key includes them, so editing the list reloads the engine. Single-char
  corrections are never auto-added (noise); the correction loop only merges ≥2-char diffs.
  Correction samples feed a persistent candidate pool (`asr-hotword-candidates.json`) and the panel's
  热词候选 box — that box is the ONLY writer of `asrHotwords`, it writes once per confirm (one write =
  one recognizer reload), and a word it could not fit under `HOTWORD_LIMIT` must be listed, never
  dropped silently. After applying, the panel's own settings state must be refreshed (`onApplied`) or
  the next keystroke in the editor overwrites the words just merged.
- ASR fine-tune legs follow the same table: qwen3 trains with `qwen3_asr_sft.py` + the ONNX exporter,
  paraformer trains through `python -m funasr.bin.train` on `funasr-jsonl` data and exports through the
  bundled `resources/asr-ft-export-funasr.py` (export + quantize + sherpa metadata/tokens in one process).
  FunASR traps, all hit for real: `validate_interval` must equal `save_checkpoint_interval` (otherwise
  `KeyError: model.pt.ep<epoch>.<step>` on the first save, or `No checkpoints found for averaging` at the
  end when the val table names a file that was never written); `++init_param` must be the weights FILE,
  not the directory; and `--model` must be the BASE model id, never the run directory, because AutoModel
  then reads the training config and exports a half-initialized graph (955 → 625 initializers, garbage
  output). sherpa additionally needs metadata FunASR never writes (`vocab_size`, `lfr_window_size`,
  `lfr_window_shift`, `neg_mean`, `inv_stddev`, `model_type`) plus `tokens.txt` from the base model's
  `tokens.json` — without `vocab_size` it refuses to load the file at all. Both legs must be spawned with
  cwd set to the run/export directory — hydra creates `outputs/` in cwd.
- GV (GPT-SoVITS) fine-tune data prep resolves every wav by BASENAME ONLY inside the flat `inp_wav_dir`
  (`2-get-hubert-wav32k.py:116-118` strips the path, then joins it onto `inp_wav_dir`); files living in any
  other directory fail to load and the surrounding try/except swallows the error SILENTLY. The zh/en voice
  packs even share identical clip basenames. Rule: keep every dataset clip in ONE flat directory (prefix
  collisions, e.g. `en_`), and after prep always assert name2text == semantic == wav32k == cleaned-list
  count before training — a mismatch is data loss, not a formatting quirk (a half-English dataset once
  shipped invisibly).
- Retraining the same speaker overwrites same-named weight files in the package's `*_weights_v2/` dirs.
  Rename the previous generation first (e.g. `<name>-old<dataset>-e15.ckpt`); the app-side copy under
  `data/gpt-sovits/weights/<speaker>/` is the only other rollback.
- api_v2 `POST /tts` (v2pro package) takes JSON fields `ref_audio_path` / `prompt_text` / `prompt_lang` /
  `text` / `text_lang` — NOT the GET aliases `refer_wav_path`/`prompt_language`/`text_language`. POST the
  payload from a file (`curl --data-binary @file`); CJK text in CLI args dies on the codepage.
- Batch ASR outside the app (Qwen3 via `sherpa-onnx-node`): `require` must use the ABSOLUTE path into
  `<project>/node_modules/sherpa-onnx-node` when the script lives outside the project tree; load the engine
  once per process (~3 s/clip CPU warm vs ~10 s with cold load) and write resumable
  `path|speaker|LANG|text` lists.
- Never commit `.tmp/` or `.pi/`.
- Stage exactly the paths you touched: several pi sessions can share this worktree (intercom), and a plain
  `git add -A` sweeps someone else's half-finished refactor into your commit. Check `git status -s` for files you
  cannot explain before committing, and say so in the reply instead of silently including or reverting them.
- App-owned data — including non-dependency artifacts the app produces (recordings, exports, reports, logs) — stays inside the portable data directory (`userData`), never scattered onto other drives. Never hardcode external paths (`D:\work\...`) as runtime dependencies: the installed build's data lives in the `<install>-data` sibling directory, and a fresh install must work with zero external paths.
- Developer-only tooling (e.g. the `D:\work\ft-qwen3` fine-tune workspace: training env, cloned upstream repos, base model weights) stays outside the repo, and app code must have ZERO references to it — no hardcoded paths, no imports, no spawn targets, no "it exists on this machine" assumptions. Before an app feature can use something that lives in a developer workspace, copy it into the project first: bundled resource under `resources/`, or generated into `userData`.

## Shipping

`npm run pack:win` → `dist/oh-my-dota2-<version>-x64.exe` plus a portable zip, unsigned, so
SmartScreen warns on first run. Three workflows: `ci.yml` (typecheck + lint + build),
`nightly.yml` (prerelease; older nightlies deleted because one release is ~460 MB), `release.yml`
(a `v*` tag). `package.json` version is the single source of truth and the tag must match.
Auto-update is stable-channel only through `electron-updater` (`publish` in
`electron-builder.yml` writes `latest.yml`); nothing restarts on its own. Workflow details and the
Windows process-check trap: `docs/ARCH-notes.md`.

## Docs

- `docs/INDEX.md` — the index of every doc: what answers which question, plus status (current / draft / historical
  snapshot). Read it first when you do not know which file holds something. **Any new, renamed or retired doc must be
  registered here in the same change** — an unlisted doc is an invisible one.
- `docs/DESIGN.md` — routing decision (zero injection), M1–M4 scope
- `docs/PLAN.md` — plan of record; milestones carry checkboxes and evidence
- `docs/ACCEPTANCE.md` — manual acceptance checklist + troubleshooting table (Chinese)
- `docs/BENCH.md` — measured baselines and how to reproduce them
- `docs/NOTES.md` — detailed engineering notes: symptom → cause → fix (Chinese)
- `docs/VOICES.md` — the offline voice catalogue: where every model archive comes from, how the three layout families are loaded, measured sample rate/latency per model, and the traps (LFS-pointer .int8.onnx, 8 kHz models, non-linear speed)
- `docs/STANDARDS.md` — the anti-duplication standard: ask "how many places hold this knowledge" before writing, the
  three worked examples to copy (`shared/speech-plan.ts` plan value + engine table, `input/ps-runner.ts` one PowerShell
  run, `net/download.ts` mirror + resume), table-vs-branch rules, pure-seam/probe contract, "comments say why", and the
  panel-vs-main ownership rule. Read it before adding a branch that mirrors an existing one.
- `docs/ARCH-notes.md` — the detail that used to sit in this file: panel file inventory, training
  artifacts and parsers, shipping workflows, the Windows process-check trap. AGENTS.md keeps the
  rules; read this one before touching those areas.

## Commits

English Conventional Commits (`feat:` / `fix:` / `perf:` / `docs:` / `chore:`), author
`mystery4f <40482524+mystery4f@users.noreply.github.com>`.

## Version control: git only

`core.autocrlf` is `true` and a `.gitattributes` exists, so worktree files carry CRLF while the Git
blobs hold LF. jj compares raw bytes and ignores both settings, which is why a colocated `.jj` reports
every text file as modified while `git diff` is empty — the "jj drift" is structural, not a stale
snapshot. This repo therefore stays pure Git: never `jj git init` here. If a `.jj` shows up, delete it
(colocated jj stores its objects in `.git/objects`, so nothing else is lost) and commit with git,
staging exact paths. Nine git worktrees live under `.dev-flow/` and jj cannot operate inside them anyway.

## Agent skills

### Issue tracker

GitHub Issues (github.com/mystery4f/oh-my-dota2) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

Half-duplex guard (#163): the renderer only knows which leg is playing, so `resolvePlaybackLeg(leg, testMode)` in
`src/shared/half-duplex.ts` folds test mode to the `test` leg — borrowing `announce` there would silently invalidate the
"only count real announcements" ear check. `notePlayback()` without a measured duration opens no window, but writes one
`half-duplex-skip` line (with `stage` and `durationMs: null`) so "not guarded" is distinguishable from "nothing dropped";
that line is a trace, never counted in `total`/`dropped`.
Half-duplex guard: the playback window is reported from the renderer (`voice:playback`, sent from
`overlay/speech.ts` and `overlay/interpret-echo.ts` `onplaying`) because the announce leg plays its audio in the
window, not the main process — a guard that only `voice-out.ts` feeds stays blind during announcements, and that
blind spot is exactly what a probe on the seam cannot see. Every drop also writes a `half-duplex-drop` row into
`logs/voice-chain.jsonl` (console alone means "was it dropping tonight?" is unanswerable after the fact); the panel's
关于 → 诊断 row reads `voice:half-duplex`.
