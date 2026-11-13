# Probes
CI runs the pure subset — `train`, `voice-out`, `voice-chain`, `tts-pipeline`, `sovits-refs`, `sovits-voicepack`, `chat-block`, `translate-cache`, `overlay-geometry` — in the `probes` job of `.github/workflows/ci.yml`. A probe added to that list must need no window, no network and no model; anything that does stays manual.

One probe per seam. Each runs as a plain Node program through Electron, needs no game, no window and no network unless the line says so; a probe prints PASS/FAIL lines and a summary count, exit code 0 only when every case passed.

Run one with:

```bash
taskkill /F /IM electron.exe   # a leftover process holds the single-instance lock and the probe exits silently
npx electron out/main/index.js --<probe-name>
```

 keeps the working rules; this file keeps the catalogue. Add a probe when a new pure seam appears, and update its line here instead of growing the agent notes.

## Catalogue

- Probes (run `taskkill /F /IM electron.exe` first — a leftover process holds the single-instance lock
  and the probe exits silently). A probe process must skip ambient wiring: no whole-table hotkey
  registration, no resident bridges, no timers — `installHotkeys` overwriting a probe's own watcher is
  how `--hold-watch-probe` failed its first run, so guard the entry with `if (!probeRun)`:
  `npx electron out/main/index.js --<probe>`
<!-- probes:start -->
  <!-- 这一段由 `npm run probes:doc` 生成，别手改；改表见 src/main/probes/registry.ts -->
  - `--inplace-probe` resident input bridge ping
  - `--reply-latency-probe` reply translation latency after warm-up
  - `--tts-bench` synthesizes Chinese sentences through the Edge voice, prints `ok/failed/p50/min/max` ms and bytes
  - `--tts-offline-probe` synthesizes 3 Chinese lines through one offline voice (`baker` | `xiao_ya` | `eula`)
  - `--tts-voices-probe` the offline voice catalogue: which archive each model comes from and that it loads
  - `--tts-pipeline-probe` the synthesis→delivery pipeline behind `speakPipeline` with fake injected engines
  - `--tts-play-probe` the full speak delivery chain: decideSpeak cases, engine propagation, cache and backlog
  - `--chat-block-probe` the pure line rules: `renderChatLine`/`withChatBody` round trip, translate-or-not, and the nickname regression
  - `--gsi-probe` Game State Integration listener: pure verdict cases + a real HTTP round trip (no game needed)
  - `--settings-persist-probe` panel choices survive a restart: sentinel round trip per field, no cross-field clobber
  - `--sovits-refs-probe` the sovits reference library reader (`listSovitsRefs`) against temp fixtures
  - `--sovits-voicepack-probe` the voice pack pipeline with zero network and zero engine: plan, install, state, delete
  - `--gsi-dump` prints every field path Dota actually pushes (type/hits/sample) into `logs/gsi-frames.json`
  - `--gsi-dump-report` reads the summary the app writes while it plays (`logs/gsi-summary.json`)
  - `--match-report` folds one match out of the GSI log: unique lines vs raw frames, channel mix, game time
  - `--translate-cache-probe` the translation ledger stores one pair per translation and answers in both directions
  - `--translate-accuracy-probe` runs the real provider over a fixed line set and reports per-line accuracy and latency
  - `--overlay-geometry-probe` 
  - `--hotkey-probe` the global-hotkey seam with zero window and zero game: accelerator round trip and collisions
  - `--hold-watch-probe` the hold-to-talk signal chain end to end with no window and no mic (F13 via the resident watcher)
  - `--voice-out-probe` the pure 声出 decision seam (`src/shared/voice-out.ts`) plus readiness reasons
  - `--voice-chain-probe` the 对讲 timing account (`src/shared/voice-timing.ts` + `chain-timing.ts`), zero network
  - `--asr-hotwords-probe` the pure hotword seam (`src/shared/asr-hotwords.ts`): parse, diff, merge, cap
  - `--provider-reasoning-probe` the pure 推理 toggle seam (`src/shared/provider-reasoning.ts`), zero network and zero model
  - `--zhipu-live-probe` runs the real wrapped pipeline (warm-up → durable session + ledger) against zhipu
  - `--train-probe` the pure training decision seam (`src/shared/train.ts`): mutexes, preflight, run state
  - `--voice-runtime-probe` the voice runtime installer state (`src/main/services/voice/runtime.ts`) with temp fixtures
  - `--voice-worker-probe` the NDJSON resident-worker protocol harness (`src/main/services/voice/worker.ts`), zero models
  - `--asr-engines-probe` the ASR engine table plus the model registry: each row is self-consistent with the files on disk
  - `--inplace-guard-probe` the in-place send guards: composition text, empty draft, stale session
  - `--asr-swap-probe` diagnostic: prints the swap states and the steps a promote would take (`--asr-swap-apply` runs it)
<!-- probes:end -->

 Ticket 62 pins the inference-hold switch itself (`src/main/services/voice/sovits-server.ts`): `setInferenceHold`/`sovitsInferenceHeld` are idempotent booleans (repeated set or clear never stacks), a held `ensureSovitsServer` returns false logging `TTS_SOVITS_SERVER_HELD` **without touching the port or the engine-package dir** (so no spawn), and after one clear it walks the normal path again (injected `SovitsEnsureIo` port/home → `install-not-found`, since the probe must stay zero-process; the real spawn is manual acceptance). A source-text wiring pin also reads `src/main/services/train/manager.ts` and fails if either `setInferenceHold(true)` (start) or `setInferenceHold(false)` (finish) disappears — skipped, not failed, when `src/` is absent (installed build). Spawning a real task and stopping it mid-run is manual acceptance.  - `--inplace-guard-probe` the pure seam behind in-place send (`src/shared/inplace.ts`), zero game and zero input bridge: `pickInPlaceDraft` (fresh text wins, `NOCONTENT` + an orphaned draft from an interrupted run continues that sentence instead of reporting an empty chat box, other codes never borrow the orphan, blank text is `empty`, missing reason still says something human), `decideInPlaceDelivery` (cancelled abandons before anything else and never touches the box, empty translation restores the Chinese, `INPLACE_STALE_MS` = 20 s turns a late arrival into a restore with the seconds named, a hair under the threshold still sends, normal path sends the line verbatim), and `inplaceFailureLine` (prefix 「直发失败：」, says 「原文已放回聊天框」 only when it really was, clips a 200-char reason to under 80 chars). Pure only — the bridge's real behaviour (`enter:false` paste-without-Enter, `Ctrl+A`+`Delete` clearing the box during grab) and the timing gates are manual acceptance, listed as M8b in `docs/ACCEPTANCE.md`.

