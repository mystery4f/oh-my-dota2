# oh-my-dota2 v3 — agent notes

Desktop companion for Dota 2: reads the chat through Dota 2 Game State Integration, translates it, and sends replies by
keystrokes/clipboard. No injection, no reading game memory.

Stack: electron-vite 3 + Electron 37 (Node 22.21 inside) + React 18 + TS strict + Tailwind 3.
Everything interesting lives in the main process: GSI chat intake, translation sessions, input bridge.

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
- `npx eslint .` — 0 errors expected; exactly 2 permanent `react-refresh` warnings (badge.tsx:31, button.tsx:41)
- Probes (run `taskkill /F /IM electron.exe` first — a leftover process holds the single-instance lock
  and the probe exits silently):
  `npx electron out/main/index.js --<probe>`
  - `--inplace-probe` resident input bridge ping
  - `--reply-latency-probe` reply translation latency after warm-up
  - `--chat-block-probe` the pure line rules: prefix split, translate-or-not, same-text, hero extraction
  - `--gsi-probe` Game State Integration listener: pure verdict cases + a real HTTP round trip (no game needed)
  - `--gsi-dump [seconds]` prints every field path Dota actually pushes (type/hits/sample) into `logs/gsi-frames.json`; stop the dev app first, the GSI port is single-owner
  - `--gsi-dump-report [file]` reads the summary the app writes while it plays (`logs/gsi-summary.json`)
    and prints a verdict: real match or training ground, whether `allplayers` arrives, which
    `event_type`s showed up. Read-only, so it works with the dev app running and right after a match.
  - `--match-report [logDir] [--since-min N]` folds one match out of the GSI log: unique lines vs raw frames (repeat median/max), channel mix, game-time window, plus a ledger coverage check naming the lines that never reached the pair table. Read-only, safe while playing; without `--since-min` it reports everything the logs still hold.
  - `--settings-persist-probe` panel choices survive a restart: sentinel round-trip per field, no cross-field clobber, partial/unknown-key files fall back per field, original file restored
  - `--sovits-refs-probe` the sovits reference library reader (`listSovitsRefs`) against temp fixtures: missing/non-array/malformed `refs.json` degrade to an empty list, missing audio and out-of-root paths are filtered, relative paths resolve under the library root, valid entries come back complete
  - `--overlay-geometry-probe` pure arithmetic of the overlay's own geometry (23 cases): min width/height lifted, a window dragged off either edge keeps 80 px reachable, moving translates as a whole, handles pin the right/left edge correctly, the width floor wins over the screen edge, snapping only when already within 24 px, and the collapsed icon (`miniGeometry`) staying on an unchanged display. It also pins the two rules that were broken twice: `shouldIgnoreMouse(locked, replyOpen)` (only locked-and-not-replying passes clicks, collapsing included) and `shouldAutoLock`. Re-run it before touching any of those three functions.
  - `--tts-offline-probe [voice]` synthesizes 3 Chinese lines through one of the three offline voices (`baker` | `xiao_ya` | `eula`, default `baker`) via a plain `node` child process and prints per-line ms/bytes, plus asserts speed changes the byte count. Baseline (warm p50): baker 90 ms, xiao_ya 111 ms, eula 362 ms; the gate is p50 < 1.5 s and the first line is reported separately as `coldMs` (1.5–5 s of worker spawn + engine load) — folding it into p50 makes the probe flap. Prerequisite: a real `node` on PATH — the sherpa addon throws `External buffers are not allowed` inside every Electron runtime, so there is no in-process fallback. `baker` is a matcha model: it needs the separate `vocos-22khz-univ.onnx` vocoder (`MODEL_FILES[id].vocoder`), and the model archive's `model.int8.onnx` is a 133-byte Git LFS pointer, not a model — pointing either at a missing file kills the child silently.
  - `--tts-bench [n]` (default 10) synthesizes n Chinese sentences through the Edge neural voice, prints `ok/failed/p50/min/max` ms and bytes, and asserts `pitchOk` (the same line at pitch 0.75 vs 1.25 must return a different byte count, otherwise the pitch slider is decorative). Baseline: 10/10, p50 ≈ 0.8–1.2 s. A 429/0-byte streak means the free endpoint is throttling; `ms≈0` means a local argument check rejected the request (pitch takes Hz, not percent).
  - `--tts-play-probe` the full speak delivery chain: pure decideSpeak cases (what to read, hero prefix, pending/symbol-only lines), engine propagation from settings through to the payload (`system`/`edge`/`offline` — losing the engine once made every offline WAV ship as `audio/mpeg` and play back silent while Edge kept working), then a hidden overlay window that really plays an Edge mp3 and, when the model is installed, an offline WAV, asserting `VOICE_PLAY_OK` for each. It also pins the own-line switch (`ttsReadOwn`): off (default) skips the player's own line, on reads it. Offline leg is skipped silently when the model is missing (CI has none).
  - `--translate-cache-probe` the translation ledger stores one pair per translation and answers in both directions (source→target and target→source), refuses to hand a Chinese answer to an English request, ignores tone on the reverse side, keeps the pre-recorded stats fields (direction/origin/length/word count/hits), and survives closing/reopening the sqlite file
  - `--input-probe` draft → translate → command text (sends no keys)

## Hotkeys

- `Alt+Shift+C` capture now (manual mode)
- `Alt+Shift+T` open the reply box
- `Alt+Shift+P` lock / unlock the overlay
- `Alt+Shift+B` collapse / expand the overlay to its 132x34 icon
- `Alt+Shift+O` show / hide the overlay
- `Alt+Shift+R` re-pick the chat region
- `Alt+Shift+V` hold to record voice (whisper.cpp)

## Environment constraints (China, Windows)

- npm: `--registry=https://registry.npmmirror.com`; Electron postinstall needs
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- Foreign sites only through proxy `http://mcr:4444`. `registry.npmmirror.com`, `hf-mirror.com`,
  `api.xiaomimimo.com`, `api.deepseek.com` are domestic — go direct.
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
- Never commit `.tmp/` or `.pi/`.

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

## Docs

- `docs/DESIGN.md` — routing decision (zero injection), M1–M4 scope
- `docs/PLAN.md` — plan of record; milestones carry checkboxes and evidence
- `docs/ACCEPTANCE.md` — manual acceptance checklist + troubleshooting table (Chinese)
- `docs/BENCH.md` — measured baselines and how to reproduce them
- `docs/NOTES.md` — detailed engineering notes: symptom → cause → fix (Chinese)
- `docs/VOICES.md` — the offline voice catalogue: where every model archive comes from, how the three layout families are loaded, measured sample rate/latency per model, and the traps (LFS-pointer .int8.onnx, 8 kHz models, non-linear speed)

## Commits

English Conventional Commits (`feat:` / `fix:` / `perf:` / `docs:` / `chore:`), author
`mystery4f <40482524+mystery4f@users.noreply.github.com>`.
