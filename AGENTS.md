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
  The section ids are the page names in `sections.ts`, not the file names: `?s=voice` is 音色训练 and
  `?s=asr` is 识别训练 (`?s=voice-train` silently lands on 总览). A full-page screenshot needs a
  1280x1700 viewport and `scale: 'css'`; without the resize playwright crops at its 720 px default
  and the 预检 rows look missing.
- `.githooks/pre-commit` runs `npm run typecheck` then `npm run lint` (the same two commands as CI).
  Enable once per clone: `git config core.hooksPath .githooks`; skip once with `git commit --no-verify`.
- Probes: the catalogue (one line per probe, what it pins) lives in `docs/PROBES.md` — read the matching line before touching that seam.
  `taskkill /F /IM electron.exe` first (a leftover process holds the single-instance lock and the probe exits silently — the tell is exit 0 after ~3 s with no `PASS` lines), then `npx electron out/main/index.js --<probe>`. `cmd /c "taskkill …"` is unreliable from bash (the quoting collapses and cmd just prints its banner); `powershell -NoProfile -Command "Stop-Process -Name electron -Force"` always works.


## Panel

The dashboard is `src/renderer/src/panel/` and it is the only one: `panel-app.tsx` shell +
`sections.ts` (ten sections; a forgotten `switch` case is a compile error) + `pages/*.tsx` +
`components/primitives.tsx` (the whole typography and spacing scale lives there). Navigation is
the sidebar alone; `?s=<section>` deep-links. Rules the layout encodes: every setting has one
home, saving is immediate so there is no 保存 button, `StatusPill` only for state that can change,
colour only for selection / primary action / warning. Full file inventory and the deliberate
deviations: `docs/DESIGN-panel-v2.md`, `docs/ARCH-notes.md`.

## Training (音色训练 / 识别训练)

Two sections, one shape: 数据 → 运行 → 产物; no training window, no `train:open` channel. A run is
`src/shared/train/run.ts` (one row in `userData/train/runs.db`, plus one `dataset_entries` row per
recorded take; metrics read back from the artifacts), the gate is `src/shared/train/preflight.ts`
(only `block` disables 开始训练), and mic capture stays in `panel/use-recorder.ts`. File list,
artifact paths and parser details: `docs/ARCH-notes.md`, `docs/PLAN-train-v3.md`.

## Hotkeys

Every global hotkey is rebindable in the panel (`浮层与对局 → 热键`). The table lives in `settings.json` under
`hotkeys` (action id → canonical accelerator, `''` = unbound) and is served by `src/shared/hotkeys.ts`; registration
happens in `src/main/services/hotkeys.ts`, which unregisters everything and re-registers the whole table on every save.

- `overlayToggle` (default `Alt+Shift+O`) show / hide the overlay
- `overlayLock` (default `Alt+Shift+P`) lock / unlock the overlay
- `overlayCollapse` (default `Alt+Shift+B`) collapse / expand the overlay to its 132x34 icon
- `inplaceSend` (default `Alt+Shift+T`) the only text out: reads the game chat draft (Chinese typed, not yet sent), translates, pastes back and presses Enter
- `overlayPanel` (default `Alt+Shift+H`) summon panel: the overlay temporarily becomes an interactive sheet (history 200 rows / quick phrases / AI suggestions, click a row to copy); pressing again or Esc closes it and restores click-through
- `voiceCapture` (default `Alt+Shift+V`) toggle record: speak Chinese → the active recognition model (`asrActiveModel`: Qwen3 or Paraformer) transcribes → translate → the reply
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
- sherpa ASR (two engines: `qwen3` and `paraformer`; SenseVoice removed) runs in a plain `node` child
  (`resources/asr-sherpa-worker.cjs`, request `{id, kind, wav, dir, hotwords}`) for the same
  sherpa reason as the TTS worker; the worker logs `ASR_SHERPA_*` markers, and `kind` comes from the
  engine table — the probe cross-checks the table against the worker's `ASR_KINDS` keys both ways.
  Qwen3 needs all three onnx files plus `tokenizer/` (vocab.json + merges.txt); paraformer needs
  `model.int8.onnx` + `tokens.txt`, emits no punctuation, and ignores hotwords (sherpa only does
  hotwords for transducer models).
  Hotwords (`asrHotwords` setting, comma-separated) are a constructor-time config — the worker's
  recognizer cache key includes them, so editing the list reloads the engine. Single-char
  corrections are never auto-added (noise); the correction loop only merges ≥2-char diffs.
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

## Agent skills

### Issue tracker

GitHub Issues (github.com/mystery4f/oh-my-dota2) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
