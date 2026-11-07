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

The AI provider seam lives in `src/main/services/providers/`: `openai-compat.ts` declares
`ChatOptions`/`ChatMessage` (a `messages[]` array — there is no `system` field; system prompts
live in `SYSTEM_PROMPTS`) plus `chatCompletion` / `translateText`; the voice-chain summary type
is `VoiceChainSummary` in `src/shared/ipc.ts`. Read these shapes before calling the provider —
guessing the fields costs a rework round.
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
- `npm run panel:preview` — the dashboard in a plain browser at `localhost:5199`, no Electron and no
  game: `scripts/panel-preview.mts` serves `src/renderer/src/preview/api-stub.ts` as a fake `window.api`
  before the app boots. That stub is typed against `WindowApi`, so a renamed channel or a changed result
  shape breaks `npm run typecheck:web` instead of a click that does nothing; a channel with no stub logs
  its own name. `?s=<section>`, `?engine=sovits`, `?outEngine=sovits` put a page in the state you want to
  look at. Nothing imports the stub, so it never reaches `out/`. Playwright element screenshots time out
  here more often than page screenshots do, and a repeated identical URL may not reload — bump a `&n=`
  parameter.
- `.githooks/pre-commit` runs `npm run typecheck` then `npm run lint` (the same two commands as CI).
  Enable once per clone: `git config core.hooksPath .githooks`; skip once with `git commit --no-verify`.
- Probes: the catalogue (one line per probe, what it pins) lives in `docs/PROBES.md` — read the matching line before touching that seam.
  `taskkill /F /IM electron.exe` first (a leftover process holds the single-instance lock and the probe exits silently), then `npx electron out/main/index.js --<probe>`.


## Panel

The whole dashboard is `src/renderer/src/panel/`, and it is the only dashboard: the old
`App.tsx` (2234 lines, 6 tabs) is gone, along with `components/hotkey-card.tsx` and the
`ui/{badge,card,label,tabs,textarea}` pieces nothing else imported.

- `panel-app.tsx` — the shell: 38 px drag title bar + `Sidebar` + one scrolling `<main>`.
  Navigation is the sidebar alone (no tabs); `?s=<section>` deep-links a section, and
  `OMD2_QUERY=s=talk` injects that query in dev.
- `sections.ts` — the ten sections and their two sidebar groups (系统: 翻译引擎 / 音色训练 /
  识别训练 / 热键). A page that exists in
  the switch only through `default: { const unhandled: never = active }` means a forgotten
  case is a compile error, not a blank screen.
- `pages/*.tsx` — one file per section. A page returns `Panel` / `Group` / `Row` only; the
  shell renders the `<Section>` heading, so no page repeats its own title.
- `components/primitives.tsx` — the entire typography and spacing scale lives here
  (`Panel` 720 px column, `Group` as a `border-t` list, `Row` at `min-h-11`, `StatusPill`,
  `CollapsibleGroup`). Change a spacing decision here, not per page.
- `components/search.tsx` + `search-index.ts` — Ctrl+K. A hit navigates to its section and
  force-opens the collapsed group it lives in (`openCollapseGroup`), otherwise searching a
  hidden row looks broken.
- `collapse.ts` — group open/closed in `localStorage`, read through `useSyncExternalStore`;
  `defaultOpen` seeds the first visit and an explicit toggle wins afterwards.
- `use-voice-packs.ts` + `components/voice-pack-dialog.tsx` — the voice packs live in one
  `Modal`, opened from both 朗读 and 对讲 (「音色包…」), never inline in a page: install,
  progress, switching and GV server settings are all rare, and inlining them pushed the
  common rows down. `useVoicePacks(active)` is the only reader of that state, and `active`
  is false while the engine is not sovits, so a closed dialog makes no IPC calls.
  The dialog is the only place a pack is chosen: both engine rows (朗读 / 声出) show the active
  pack name plus the 音色包… button, so adding a loader means touching one component instead of
  two pages that would drift.

Rules the layout encodes, not preferences: every setting has exactly one home; saving is
immediate, so there is no 保存 button anywhere (the flash says 已保存); a `StatusPill` is
only for state that can change (a static attribute such as 默认 is plain text); colour is
spent only on three things — selection, primary action, warning — so a page that looks
grey is the intended look. `docs/DESIGN-panel-v2.md` is the signed record; the
deliberate deviations are written down there (no extra token layer — the HSL variables in
`styles.css` already are one — and `rounded-lg` 8 px instead of the documented 10 px).

## Training (音色训练 / 识别训练)

Two sections, one shape: 数据 → 运行 → 产物. There is no training window and no
`train:open` channel — the standalone BrowserWindow was deleted in v3.

- `src/shared/train/run.ts` is the run model: `TrainRunRecord` plus the builders
  (`buildTrainRun`, `finishTrainRun`) and metric parsers (`parseAsrTrainerState`,
  `parseGvTrainLog`, `compactMetricSeries`). One run = one JSON under
  `userData/train-runs/`, written atomically by `services/train/run-store.ts`; a run is
  history, the training process is `TrainTaskInfo` — never conflate them.
- Metrics are read back from the artifacts (ASR `checkpoint-*/trainer_state.json`,
  GV `logs/<exp>/train.log`), not duplicated into the record.
- `src/shared/train/preflight.ts` is the gate: `judgeAsrPreflight` / `judgeGvPreflight`
  return `PreflightItem[]` where only `block` disables 开始训练; `warn` explains risk.
  Add a new gate there, never inline in a page.
- `panel/use-recorder.ts` owns mic capture (getUserMedia → ScriptProcessor → rms →
  `advanceRecording` → `shouldKeepTake` → `encodeWav16k` → `ftRecSave`). Page-level
  components stay free of audio plumbing.
- `npm run build` must stay silent about the training pages: no inline colours, no
  custom font sizes, at most one primary button per screen.

## Hotkeys

Every global hotkey is rebindable in the panel (`浮层与对局 → 热键`). The table lives in `settings.json` under
`hotkeys` (action id → canonical accelerator, `''` = unbound) and is served by `src/shared/hotkeys.ts`; registration
happens in `src/main/services/hotkeys.ts`, which unregisters everything and re-registers the whole table on every save.

- `overlayToggle` (default `Alt+Shift+O`) show / hide the overlay
- `overlayLock` (default `Alt+Shift+P`) lock / unlock the overlay
- `overlayCollapse` (default `Alt+Shift+B`) collapse / expand the overlay to its 132x34 icon
- `inplaceSend` (default `Alt+Shift+T`) the only text out: reads the game chat draft (Chinese typed, not yet sent), translates, pastes back and presses Enter
- `overlayPanel` (default `Alt+Shift+H`) summon panel: the overlay temporarily becomes an interactive sheet (history 200 rows / quick phrases / AI suggestions, click a row to copy); pressing again or Esc closes it and restores click-through
- `voiceCapture` (default `Alt+Shift+V`) toggle record: speak Chinese → whisper.cpp transcribes → translate → the reply
  is spoken through voice-out (the panel 「说一句试试」 button runs the same chain; keyboard auto-repeat is debounced
  500ms in `toggleVoiceCapture`)

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
  `asr-models/` (Qwen3-ASR: the `sherpa-onnx-qwen3-asr-*.tar.bz2` the user drops here, extracted
  by the panel with the system tar.exe into `sherpa-onnx-qwen3-asr-*/`; SenseVoice was removed —
  engine is now whisper or qwen3 only),
  `asr-ft/` (ASR accent fine-tune recordings from 识别训练's recording panel:
  one wav per line, `Gxx/Gxx-Lnn.wav` (or `Gxx-Tnn.wav` for the free-speech group); the
  recording script ships as a bundled resource, `resources/asr-ft-script.md`),
  `train-runs/` (训练记录: one JSON per training run, atomic temp+rename, capped at
  `TRAIN_RUN_KEEP` 200 newest — the only history of what was trained, with what data,
  and where the artifacts went; metrics are read back from the run's own
  `checkpoint-*/trainer_state.json` or GV `logs/<exp>/train.log`, never stored twice),
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
- GSI frame summary: `logs/gsi-summary.json`, written by the app itself every 5 s while frames arrive
  (atomic replace, per-match reset when `map.matchid` changes, final flush on `POST_GAME`). It answers what
  the raw frame dump cannot: real match or training ground, whether `allplayers` is actually delivered, and
  which `event_type`s exist. It lives in the app rather than a probe because port 32123 is single-owner —
  a probe would force closing the app exactly while a real match is being observed.
- Two parallel auto paths: `chatSource: 'ocr' | 'gsi'` picks where chat text comes from. `gsi` never
  never touches the screen and does not need a chat region; text arrives through
  `gsi.ts` → `pushChat` → `ChatCaptureService.pushMessages()`. `ocr` is the original polling loop.
  Manual mode always uses the snapshot path regardless of the setting.
- GSI config: the app writes `gamestate_integration_ohmydota2.cfg` into
  `<steam library>/steamapps/common/dota 2 beta/game/dota/cfg/gamestate_integration/` on startup (Steam
  path from `HKCU\Software\Valve\Steam` + `libraryfolders.vdf`). It points at `http://127.0.0.1:32123`;
  every tool gets its own cfg, so Logitech's `gamestate_integration_logitech.cfg` on 3002 keeps working.
  Our cfg enables `provider`/`map`/`player`/`events` — `events` is what makes in-game chat arrive as
  `payload.events[]` `chat_message` entries (11 = all, 12 = team). Dota 2 reads these cfg files only
  at launch — restart the game after the first write.

## Hard rules learned the hard way

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
- Overlay diagnostics: a locked overlay is click-through *and* content-protected, so it is absent from
  every screenshot and ignores the mouse. Never conclude "the overlay is not showing" from a desktop
  capture — read the panel badge or the `overlay:status` payload instead. Both rules (ignore clicks,
  content protection) come from one function, `shouldIgnoreMouse(locked, replyOpen)`.
- Docs/notes edits: a heredoc or `node -e "..."` line carrying backticks gets those backticks executed
  by bash before the file is written; markdown table rows and inline code vanished that way twice.
  Use the file-edit tool for anything containing backticks, template literals or `$(...)`.
- TTS: never fall back to the system voice when synthesis fails — skip that line silently instead.
  Two voices trading places mid-match is the exact bug users report as "the voice suddenly sounds
  wrong". The free Edge endpoint needs a warm connection pool, one retry, and it returns 0 bytes
  instead of an error, so a byte-count check is the only reliable failure signal.
- sherpa ASR (Qwen3 only; SenseVoice removed) runs in a plain `node` child
  (`resources/asr-sherpa-worker.cjs`, request `{id, wav, dir, hotwords}`) for the same
  sherpa reason as the TTS worker; the worker logs `ASR_SHERPA_*` markers.
  Qwen3 needs all three onnx files plus `tokenizer/` (vocab.json + merges.txt).
  Hotwords (`asrHotwords` setting, comma-separated) are a constructor-time config — the worker's
  recognizer cache key includes them, so editing the list reloads the engine. Single-char
  corrections are never auto-added (noise); the correction loop only merges ≥2-char diffs.
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
- App-owned data — including non-dependency artifacts the app produces (recordings, exports, reports, logs) — stays inside the portable data directory (`userData`), never scattered onto other drives. Never hardcode external paths (`D:\work\...`) as runtime dependencies: the installed build's data lives in the `<install>-data` sibling directory, and a fresh install must work with zero external paths.
- Developer-only tooling (e.g. the `D:\work\ft-qwen3` fine-tune workspace: training env, cloned upstream repos, base model weights) stays outside the repo, and app code must have ZERO references to it — no hardcoded paths, no imports, no spawn targets, no "it exists on this machine" assumptions. Before an app feature can use something that lives in a developer workspace, copy it into the project first: bundled resource under `resources/`, or generated into `userData`.

## Shipping

- `npm run pack:win` builds `out/` and then `electron-builder` produces `dist/oh-my-dota2-<version>-x64.exe`
  (NSIS installer) plus a portable `.zip`. Nothing is code-signed, so SmartScreen warns on first run.
- Three workflows: `ci.yml` (typecheck + lint + build on every push/PR), `nightly.yml` (every push to
  `main` packages a pre-release titled `Nightly <UTC timestamp>`; every older nightly is deleted, because
  one release is ~460 MB), `release.yml` (pushing a `v*` tag publishes a real release with generated notes).
- The version in `package.json` is the single source of truth; the tag must match it.
- In-app updates use `electron-updater` over the **stable** channel only (`allowPrerelease = false`) — a
  nightly must never install itself overnight. `publish` in `electron-builder.yml` is what writes
  `latest.yml` and `resources/app-update.yml`; remove it and auto-update silently stops finding releases.
- `startUpdateCheck()` fires 8 s after launch and only when `app.isPackaged`; the panel turns the button into
  “重启并更新” once `status === "ready"`. Nothing restarts on its own — killing the app mid-match is worse
  than shipping the update a day late.
- Windows process checks: `tasklist /FI ... | grep` goes through the localized console and lies — `tail -2` cut it to nothing twice in one session and made a running app look dead, so an install killed a live training run. Ask PowerShell for a count instead:
  `powershell -NoProfile -Command "(Get-Process oh-my-dota2 -ErrorAction SilentlyContinue | Measure-Object).Count"` (0 = not running; Electron leaves several processes, so any count > 0 means running).

## Docs

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

## Commits

English Conventional Commits (`feat:` / `fix:` / `perf:` / `docs:` / `chore:`), author
`mystery4f <40482524+mystery4f@users.noreply.github.com>`.

## Agent skills

### Issue tracker

GitHub Issues (github.com/mystery4f/oh-my-dota2) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
