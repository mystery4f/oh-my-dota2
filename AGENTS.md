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
- Probes (run `taskkill /F /IM electron.exe` first — a leftover process holds the single-instance lock
  and the probe exits silently):
  `npx electron out/main/index.js --<probe>`
  - `--inplace-probe` resident input bridge ping
  - `--reply-latency-probe` reply translation latency after warm-up
  - `--chat-block-probe` the pure line rules: prefix split, translate-or-not, same-text, hero extraction, plus the announce effect boundary (settled leg announces through the injected `CaptureEffects`, translate leg untouched)
  - `--gsi-probe` Game State Integration listener: pure verdict cases + a real HTTP round trip (no game needed)
  - `--gsi-dump [seconds]` prints every field path Dota actually pushes (type/hits/sample) into `logs/gsi-frames.json`; stop the dev app first, the GSI port is single-owner
  - `--gsi-dump-report [file]` reads the summary the app writes while it plays (`logs/gsi-summary.json`)
    and prints a verdict: real match or training ground, whether `allplayers` arrives, which
    `event_type`s showed up. Read-only, so it works with the dev app running and right after a match.
  - `--match-report [logDir] [--since-min N]` folds one match out of the GSI log: unique lines vs raw frames (repeat median/max), channel mix, game-time window, plus a ledger coverage check naming the lines that never reached the pair table. Read-only, safe while playing; without `--since-min` it reports everything the logs still hold.
  - `--settings-persist-probe` panel choices survive a restart: sentinel round-trip per field, no cross-field clobber, partial/unknown-key files fall back per field, original file restored, plus the per-provider archives (`providerKeys`/`providerReasoning`): live-key drift adoption, legacy seeding, cross-provider deep-merge non-clobber
  - `--sovits-refs-probe` the sovits reference library reader (`listSovitsRefs`) against temp fixtures: missing/non-array/malformed `refs.json` degrade to an empty list, missing audio and out-of-root paths are filtered, relative paths resolve under the library root, valid entries come back complete. Entries may declare fine-tuned `gptWeights`/`sovitsWeights` (relative to the weights root): a declared-but-missing/traversing/half-specified weight file drops the whole entry, and without a weights root to verify against, weighted entries are excluded rather than trusted
  - `--sovits-voicepack-probe` the voice pack pipeline with zero network and zero engine: download plan (three files landing in refs/weights roots), install verdict is exact-byte (one byte short = not installed), refs.json merge (upsert by audio key, bad index restarts as empty), resumable download against a local HTTP source (200 full fetch, `bytes=N-` Range resume with content-range verified, size mismatch throws), and the weight-switch sequence against a fake api_v2: `/set_gpt_weights` then `/set_sovits_weights` with absolute `weights_path`, repeated same-voice calls are idempotently skipped, switching voices re-fires both, zero-shot entries send nothing. Remote-manifest layer: `voicepacks.json` parsing (strict schemaVersion, per-pack drop on bad path/bytes/fields, empty list = fallback to builtin), remote-over-builtin merge by id with the builtin default preserved when the remote has none, pack refs merge (same name OR same audio replaces, stale audio reported), stale-file cleanup after a version bump (old weights + `.part` die, current files and other voices' refs survive), and `resolveVoicePacks` against a local manifest server (remote wins, 404 falls back to builtin)
  - `--overlay-geometry-probe` pure arithmetic of the overlay's own geometry (18 geometry cases + 6 hint cases + 11 state-reduction cases): min width/height lifted, a window dragged off either edge keeps 80 px reachable, moving translates as a whole, handles pin the right/left edge correctly, the width floor wins over the screen edge, snapping only when already within 24 px, and the collapsed icon (`miniGeometry`) staying on an unchanged display. It also pins the two rules that were broken twice: `shouldIgnoreMouse(locked, replyOpen)` (only locked-and-not-replying passes clicks, collapsing included) and `shouldAutoLock`. The state cases enumerate every `reduceOverlay` event from `@shared/overlay-state` (collapse auto-locks, unlock arms idle re-lock, opacity clamp, same-hint no-broadcast, reply overrides click-through, collapsed drag moves only the remembered origin). The hint cases pin `captureHint`'s paused branch naming the currently configured toggle key (and admitting 「没绑键」 instead of inventing one). Re-run it before touching any of those functions or the reducer.
  - `--hotkey-probe` the global-hotkey seam with zero window and zero game: `parseAccelerator`/`normalizeAccelerator`/`formatAccelerator` round-trip (canonical Ctrl+Alt+Shift+Super order, aliases, `''` = 未绑定, a trailing `++` becoming `+Plus`), the recorder rule `chordFromKeyEvent` (bare letter/digit refused with a reason, bare F1–F12 accepted, modifier-only chord reported as pending), `findHotkeyConflicts` pairing two actions on one key and ignoring unbound rows, `normalizeHotkeyMap` falling back per action on garbage while keeping a deliberate empty string, and one real `globalShortcut` register/unregister round trip plus a knowingly illegal accelerator that must be rejected rather than throw.
  - `--tts-offline-probe [voice]` synthesizes 3 Chinese lines through one of the three offline voices (`baker` | `xiao_ya` | `eula`, default `baker`) via a plain `node` child process and prints per-line ms/bytes, plus asserts speed changes the byte count. Baseline (warm p50): baker 90 ms, xiao_ya 111 ms, eula 362 ms; the gate is p50 < 1.5 s and the first line is reported separately as `coldMs` (1.5–5 s of worker spawn + engine load) — folding it into p50 makes the probe flap. Prerequisite: a real `node` on PATH — the sherpa addon throws `External buffers are not allowed` inside every Electron runtime, so there is no in-process fallback. `baker` is a matcha model: it needs the separate `vocos-22khz-univ.onnx` vocoder (`MODEL_FILES[id].vocoder`), and the model archive's `model.int8.onnx` is a 133-byte Git LFS pointer, not a model — pointing either at a missing file kills the child silently.
  - `--tts-bench [n]` (default 10) synthesizes n Chinese sentences through the Edge neural voice, prints `ok/failed/p50/min/max` ms and bytes, and asserts `pitchOk` (the same line at pitch 0.75 vs 1.25 must return a different byte count, otherwise the pitch slider is decorative). Baseline: 10/10, p50 ≈ 0.8–1.2 s. A 429/0-byte streak means the free endpoint is throttling; `ms≈0` means a local argument check rejected the request (pitch takes Hz, not percent).
  - `--tts-pipeline-probe` the synthesis→delivery pipeline behind `speakPipeline` (`src/main/services/voice/speech-pipeline.ts`) with fake injected engines, zero network/GPU/window: split round-trip and hard slice, edge segments all start at call time yet deliver in original order even when synths complete out of order, all-fail still emits ordered empty segments + `synthFailed` (never falls back), offline ignores split and delivers one wav, stale offline skips inference entirely (gate-first), system carries no audio and is not a synth failure, GV lazy queue (queued job dropped by a newer arrival never synthesizes and settles immediately `{delivered:0}`, per-segment prefetch fills the gap, mid-job generation bump voids the rest with zero inference), lane FIFO (announce's eager-synth-at-enqueue + ordered delivery), GV synth null → empty segment + synthFailed.
  - `--tts-play-probe` the full speak delivery chain: pure decideSpeak cases (what to read, hero prefix, pending/symbol-only lines), engine propagation from settings through to the payload (`system`/`edge`/`offline` — losing the engine once made every offline WAV ship as `audio/mpeg` and play back silent while Edge kept working), then a hidden overlay window that really plays an Edge mp3 and, when the model is installed, an offline WAV, asserting `VOICE_PLAY_OK` for each. It also pins the own-line switch (`ttsReadOwn`): off (default) skips the player's own line, on reads it. Offline leg is skipped silently when the model is missing (CI has none).
  - `--translate-cache-probe` the translation ledger stores one pair per translation and answers in both directions (source→target and target→source), refuses to hand a Chinese answer to an English request, ignores tone on the reverse side, keeps the pre-recorded stats fields (direction/origin/length/word count/hits), and survives closing/reopening the sqlite file
  - `--voice-out-probe` the pure 声出 decision seam (`src/shared/voice-out.ts`): the fixed English test line is ASCII, `decideVoiceOutTest` (synthesis failed → no speak, plan carries the engine + voice + mime), engine selection `normalizeVoiceOutEngine`/`resolveVoiceOutSynth` (edge English placeholder by default, offline local voices, GV/SoVITS pack — voice left empty, weight switching stays in the existing voice-pack pipeline; garbage falls back per engine; synth language judged from the text), device routing `resolveOutputSink` (empty request = system default, match by deviceId then label, miss = fallback + hint), PTT timing `pttWindow`/`pttWatchdogMs` (audio +200 ms head +200 ms tail, watchdog ≥5 s), and speak-key mapping `normalizeSpeakKey`/`speakKeyVk` (F1–F12 → 0x70–0x7B, single alnum → ASCII). Ticket-05 one-shot chain decisions: `decideVoiceOutReply` (empty/blank recognition, translate-failed, empty translation → silent skip; non-empty translation → speak the trimmed text through the configured engine), `pickPlayableSegments` (failed segment synth skipped, order preserved, all-failed = whole line silent), `spokenStatusLine` (已播 green / ✕ reason red with fallback wording), and reply 分句 via `splitForSpeech` (English long reply: round-trip equality, per-segment cap, hard slice without punctuation). Pure only — zero network, zero game, zero driver; the physical VB-Cable/keystroke leg is manual acceptance.
  - `--asr-hotwords-probe` the pure hotword seam (`src/shared/asr-hotwords.ts`): `parseHotwords` (CJK comma/顿号/semicolon/space splits, dedupe, empty in → empty out), `extractHotwordDiff` (common prefix/suffix trim then punctuation split; ≥2-char pieces only — single-char corrections return [], capped at 8 per edit), `mergeHotwords` (append-only, no duplicates). Pure only — the engine-side hotwords effect is real-machine A/B acceptance.
  - `--provider-reasoning-probe` the pure "推理" toggle seam (`src/shared/provider-reasoning.ts`), zero network and zero model: `thinkingFormatFor` (MiMo/智谱 → zai `thinking.type`, DeepSeek → deepseek, OpenAI/custom → `reasoning_effort`, Ollama → none), `reasoningEnabled`/`thinkingLevelFor` (unset = off, on = medium), and `directReasoningParams` — the body patch the direct hedge path sends per provider (MiMo off keeps the measured `reasoning_effort:'none'` 7.4s→1.4s, 智谱 off sends `thinking:{type:'disabled'}`, DeepSeek/Ollama send nothing when off, OpenAI/custom send `reasoning_effort:'medium'` when on). Also pins that no preset declares reasoning (a preset switch must not silently turn thinking on), and the per-provider toggle memory: `healProviderReasoning` heals a declaring (synthetic) preset's stale stored value, custom providers keep theirs, MiMo→Zhipu→MiMo restores each provider's own toggle. Real effect on translation quality/latency is manual acceptance.
  - `--zhipu-live-probe [--model name]` runs the real wrapped pipeline (warm-up → durable session + ledger, `translateLine` / `translateReply`) against 智谱 BigModel and prints per-line latency plus the translations; the key comes only from the `ZHIPU_API_KEY` env var (probe prints its shape, never a character of it) and a missing key is a silent SKIP with exit 0. Measured on GLM-4-Flash-250414: warm 1.3 s, chat p50 ≈ 0.6 s, reply 0.9–1.0 s, `lastFallback: null` (all served by the session lane), and turning `provider.reasoning` on changes neither latency nor text — glm-4-flash accepts but ignores `thinking`.
  - `--train-probe` the pure training decision seam (`src/shared/train.ts`): `canStartTrain` mutex (preparing/running rejected, stopping rejected until drained, null/idle/done/failed/stopped free), `shouldPauseInference`/`shouldResumeInference` complementary per state (wired since T2: the train manager pauses the app-managed GV server at start via `pauseSovitsForTraining` and resumes at finish via `ensureSovitsServer`, external instances untouched; `TrainTaskInfo.inference` + `inferenceHoldLabel` carry the window's mutual-exclusion status), `deriveTrainPlan` (demo runs an inline node script; gv-gpt/gv-sovits run real training once the injected `gvResolved` carries the engine home/python/config file — s2 uses `--config`, s1 uses `--config_file`, both argv shapes pinned by the probe; asr-ft is real and needs the injected attachment, see below; unknown kind → demo), the GV config-build seam (T3, same file: `GV_VERSION_INFO` six-version table copied from upstream `config.py` with per-version weight roots, `buildS2TrainConfigData`/`buildS1TrainConfigData` patching the upstream `s2.json`/`s1longer*.yaml` templates exactly like webui's `open1Ba`/`open1Bb` (null when the template lacks key nodes), `judgeGvDataset` four-artifact readiness (phoneme table/semantic table/4-cnhubert/5-wav32k)), and `parseTrainProgress` priority (epoch a/b percent → tqdm percent bar → step a/b → bare percent → null for plain log lines), the #14 dataset-packing seam (`buildFtDatasetEntries` recorded lines-only, free groups skipped; `splitTrainEval` tail-2 holdout that keeps everything in train for tiny sets; `buildFtJsonlLine` emitting the `language Chinese<asr_text>` prefix), and the T4 progress seam (`buildFtGroupProgress` per-group done/total/durationMs/missing line numbers — free groups count T01.. until the chain breaks — feeding the window's always-on overview strip), the recording-policy seam (T4a: `advanceRecording` step machine (speech-seen → quiet-arm → quiet-stop vs maxMs cap, quiet wins on collision), `shouldKeepTake` (short/silent-take discards, duration judged first), `takeLineId`/`recordingKey` (Gxx-Lnn / Gxx-Tnn keys, same shape as the main-process `safeKeys` whitelist)), and the T5 fine-tune chain seams: `deriveTrainPlan` asr-ft now requires the injected `asrFt` attachment ("环境没就绪" when missing), `pickLastCheckpointName` (highest checkpoint-N), `asrFtSwapSteps` (rm-bak → bak-active → promote-next; empty without an export dir), `asrFtRollbackSteps` (rm-active → restore-bak; empty without a backup), `deriveAsrFtEnvGaps` naming each missing env item, plus the installer seams in `asr-ft-install.ts`: `planAsrFtInstallSteps` (five-stage fill-what's-missing plan, empty when the env is complete) and `pickLatestUvAsset` (version-number comparison, not string sort — 0.10.2 must beat 0.9.5). Pure only — spawning the demo task and stopping it mid-run is manual acceptance.
  - `--input-probe` draft → translate → command text (sends no keys)
  - `--inplace-guard-probe` the pure seam behind in-place send (`src/shared/inplace.ts`), zero game and zero input bridge: `pickInPlaceDraft` (fresh text wins, `NOCONTENT` + an orphaned draft from an interrupted run continues that sentence instead of reporting an empty chat box, other codes never borrow the orphan, blank text is `empty`, missing reason still says something human), `decideInPlaceDelivery` (cancelled abandons before anything else and never touches the box, empty translation restores the Chinese, `INPLACE_STALE_MS` = 20 s turns a late arrival into a restore with the seconds named, a hair under the threshold still sends, normal path sends the line verbatim), and `inplaceFailureLine` (prefix 「直发失败：」, says 「原文已放回聊天框」 only when it really was, clips a 200-char reason to under 80 chars). Pure only — the bridge's real behaviour (`enter:false` paste-without-Enter, `Ctrl+A`+`Delete` clearing the box during grab) and the timing gates are manual acceptance, listed as M8b in `docs/ACCEPTANCE.md`.

## Panel

The whole dashboard is `src/renderer/src/panel/`, and it is the only dashboard: the old
`App.tsx` (2234 lines, 6 tabs) is gone, along with `components/hotkey-card.tsx` and the
`ui/{badge,card,label,tabs,textarea}` pieces nothing else imported.

- `panel-app.tsx` — the shell: 38 px drag title bar + `Sidebar` + one scrolling `<main>`.
  Navigation is the sidebar alone (no tabs); `?s=<section>` deep-links a section, and
  `OMD2_QUERY=s=talk` injects that query in dev.
- `sections.ts` — the eight sections and their two sidebar groups. A page that exists in
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

Rules the layout encodes, not preferences: every setting has exactly one home; saving is
immediate, so there is no 保存 button anywhere (the flash says 已保存); a `StatusPill` is
only for state that can change (a static attribute such as 默认 is plain text); colour is
spent only on three things — selection, primary action, warning — so a page that looks
grey is the intended look. `docs/DESIGN-panel-v2.md` is the signed record; the
deliberate deviations are written down there (no extra token layer — the HSL variables in
`styles.css` already are one — and `rounded-lg` 8 px instead of the documented 10 px).

## Hotkeys

Every global hotkey is rebindable in the panel (`浮层与对局 → 热键`). The table lives in `settings.json` under
`hotkeys` (action id → canonical accelerator, `''` = unbound) and is served by `src/shared/hotkeys.ts`; registration
happens in `src/main/services/hotkeys.ts`, which unregisters everything and re-registers the whole table on every save.

- `overlayToggle` (default `Alt+Shift+O`) show / hide the overlay
- `overlayLock` (default `Alt+Shift+P`) lock / unlock the overlay
- `overlayCollapse` (default `Alt+Shift+B`) collapse / expand the overlay to its 132x34 icon
- `inplaceSend` (default `Alt+Shift+T`) send: inplace reads the game chat draft, translate, paste back and Enter;
  other send modes open the overlay reply box
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
- Foreign sites only through proxy `http://mcr:4444`. `registry.npmmirror.com`, `hf-mirror.com`,
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
  `asr-ft/` (ASR accent fine-tune recordings from the training window's recording panel:
  one wav per line, `Gxx/Gxx-Lnn.wav` (or `Gxx-Tnn.wav` for the free-speech group); the
  recording script ships as a bundled resource, `resources/asr-ft-script.md`),
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
