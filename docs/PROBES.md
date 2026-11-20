# Probes
CI runs the subset whose row in `src/main/probes/registry.ts` carries `ci: true` — `npx electron out/main/index.js --probes-ci` prints those flags, and the `Pure probes` step of `.github/workflows/ci.yml` loops over them. A row earns the mark only if the probe needs no window, no network and no model; anything that does stays manual.

One probe per seam. Each runs as a plain Node program through Electron, needs no game, no window and no network unless the line says so; a probe prints PASS/FAIL lines and a summary count, and exits 0 only when every case passed *and* at least one case ran (`src/main/probes/harness.ts` owns that verdict, so an unconditional `app.exit(0)` is an eslint error inside `src/main/probes/`).

Run one with:

```bash
npm run probe -- --<probe-name>
```

The wrapper kills a leftover electron first (such a process holds the single-instance lock and the probe would exit silently) and hands back the probe's own exit code; `npm run probe:raw -- --<probe-name>` skips the convenience. `AGENTS.md` keeps the working rules; this file keeps the catalogue. Add a probe when a new pure seam appears — one row in the registry, then `npm run probes:doc`.


## Catalogue

- Probes (use `npm run probe -- --<probe>`: it clears the leftover electron that would otherwise hold
  the single-instance lock and make the probe exit silently). A probe process must skip ambient wiring: no whole-table hotkey
  registration, no resident bridges, no timers — `installHotkeys` overwriting a probe's own watcher is
  how `--hold-watch-probe` failed its first run, so guard the entry with `if (!probeRun)`.
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
  - `--dota-display-probe` reads Dota 2 `video.txt` and says whether the game is exclusive-fullscreen (nothing can draw over it)
  - `--gsi-probe` Game State Integration listener: pure verdict cases + a real HTTP round trip (no game needed)
  - `--settings-persist-probe` panel choices survive a restart: sentinel round trip per field, no cross-field clobber
  - `--sovits-refs-probe` the sovits reference library reader (`listSovitsRefs`) against temp fixtures
  - `--sovits-voicepack-probe` the voice pack pipeline with zero network and zero engine: plan, install, state, delete
  - `--gsi-dump` prints every field path Dota actually pushes (type/hits/sample) into `logs/gsi-frames.json`
  - `--gsi-dump-report` reads the summary the app writes while it plays (`logs/gsi-summary.json`)
  - `--match-report` folds one match out of the GSI log: unique lines vs raw frames, channel mix, game time
  - `--translate-cache-probe` the translation ledger stores one pair per translation and answers in both directions
  - `--translate-guard-probe` the fidelity guard telemetry: blocked / recovered / gaveUp counts, dirty jsonl lines, and one batched write
  - `--first-run-probe` the first-run checklist: six steps, what counts as evidence in each, and why the last one needs the real game
  - `--match-attribution-probe` which match a row belongs to: one archive per match, the live summary holding only the current one, null instead of a guessed id, and every synthetic row confined to a temp logs dir
  - `--hotword-candidates-probe` hotword candidates from corrections: only >=2-char diffs enter the pool, sorting by count, explicit merge, full table never silently drops
  - `--interpret-listen-probe` can we hear the machine at all: loopback opens at 48 kHz, the track really carries sound, and GTCRN+VAD carve speech-sized segments
  - `--translate-accuracy-probe` runs the real provider over a fixed line set and reports per-line accuracy and latency
  - `--overlay-geometry-probe` 
  - `--hotkey-probe` the global-hotkey seam with zero window and zero game: accelerator round trip and collisions
  - `--download-probe` a download that drops mid-way resumes from the partial file, a source ignoring Range restarts clean, and a bad mirror falls through with the one actually used named in the log
  - `--hold-watch-probe` the hold-to-talk chain in three layers: the resident script reports OK, HOLD edges are recorded once each, and a dead script surfaces as fallback instead of silence
  - `--voice-out-probe` the pure 声出 decision seam (`src/shared/voice-out.ts`) plus readiness reasons
  - `--voice-chain-probe` the 对讲 timing account (`src/shared/voice-timing.ts` + `chain-timing.ts`), zero network
  - `--log-bundle-probe` the diagnostic bundle (`src/shared/log-bundle.ts` + `services/zip.ts`): masking, manifest, missing files, byte-stable archive
  - `--dataset-health-probe` the pre-training dataset health check (`src/shared/train/dataset-health.ts` + `services/train/wav-facts.ts`): duplicate lines, takes that carry no speech, missing script lines, duration distribution
  - `--glossary-pack-probe` the swappable glossary pack (`src/shared/glossary-pack.ts` + `services/glossary-pack.ts`): a pack with a new hero maps both directions, a malformed pack falls back to the bundled table with the reason kept, and the active pack name is visible
  - `--overlay-digest-probe` the combat-digest line (`src/shared/overlay-digest.ts`): every fragment quoted from an existing chat row (nothing invented, no model call), intent-first pick in chronological order, and the setting that hides the rows
  - `--mic-health-probe` the microphone health gate (`src/shared/mic-health.ts`): a dead or muted device is judged before the voice chain starts, a take with no frames never reaches ASR, and the level bar is a monotone RMS mapping
  - `--announce-probe` game-state announcements (src/shared/dota-announce.ts + src/main/services/voice/announce.ts): wisdom rune / Roshan window / stack and pull windows each fire exactly once per occurrence from the game clock alone, a switched-off trigger stays silent, and with the master switch off the voice pipeline is never called
  - `--key-noun-probe` the post-translation key-noun check (`src/shared/key-nouns.ts`): hero and item names extracted from the source once before translating, flagged when the translation drops one — the method never rewrites the delivered text
  - `--translate-direction-probe` per-line translation direction (`src/shared/translate-direction.ts`): Han share decides zh-en vs en-zh, digits and punctuation stay out of the denominator, and a manual correction applies to that one line for the rest of the session
  - `--quality-report-probe` the weekly quality card (`src/shared/quality-report.ts`): guard counts read line for line off `logs/translate-guard.jsonl`, cache snapshots off `logs/translate-cache.jsonl`, no invented miss rate, and a missing log file reads as zero instead of an error
  - `--speech-queue-probe` the speech queue and barge-in stop (#88): a stop ends delivery at the current segment boundary, no later segment starts, the queue snapshot drops to zero, and the stop flag never sticks to the next utterance
  - `--asr-hotwords-probe` the pure hotword seam (`src/shared/asr-hotwords.ts`): parse, diff, merge, cap
  - `--provider-reasoning-probe` the pure 推理 toggle seam (`src/shared/provider-reasoning.ts`), zero network and zero model
  - `--zhipu-live-probe` runs the real wrapped pipeline (warm-up → durable session + ledger) against zhipu
  - `--train-probe` the pure training decision seam (`src/shared/train.ts`): mutexes, preflight, run state
  - `--asr-check-live-probe` runs the real model over the ledger recordings and prints the CER ranking split into train / eval
  - `--voice-runtime-probe` the voice runtime installer state (`src/main/services/voice/runtime.ts`) with temp fixtures
  - `--voice-worker-probe` the NDJSON resident-worker protocol harness (`src/main/services/voice/worker.ts`), zero models
  - `--asr-engines-probe` the ASR engine table plus the model registry: each row is self-consistent with the files on disk
  - `--inplace-guard-probe` the in-place send guards: composition text, empty draft, stale session
  - `--asr-swap-probe` diagnostic: prints the swap states and the steps a promote would take (`--asr-swap-apply` runs it)
<!-- probes:end -->

 Ticket 62 pins the inference-hold switch itself (`src/main/services/voice/sovits-server.ts`): `setInferenceHold`/`sovitsInferenceHeld` are idempotent booleans (repeated set or clear never stacks), a held `ensureSovitsServer` returns false logging `TTS_SOVITS_SERVER_HELD` **without touching the port or the engine-package dir** (so no spawn), and after one clear it walks the normal path again (injected `SovitsEnsureIo` port/home → `install-not-found`, since the probe must stay zero-process; the real spawn is manual acceptance). A source-text wiring pin also reads `src/main/services/train/manager.ts` and fails if either `setInferenceHold(true)` (start) or `setInferenceHold(false)` (finish) disappears — skipped, not failed, when `src/` is absent (installed build). Spawning a real task and stopping it mid-run is manual acceptance.  - `--inplace-guard-probe` the pure seam behind in-place send (`src/shared/inplace.ts`), zero game and zero input bridge: `pickInPlaceDraft` (fresh text wins, `NOCONTENT` + an orphaned draft from an interrupted run continues that sentence instead of reporting an empty chat box, other codes never borrow the orphan, blank text is `empty`, missing reason still says something human), `decideInPlaceDelivery` (cancelled abandons before anything else and never touches the box, empty translation restores the Chinese, `INPLACE_STALE_MS` = 20 s turns a late arrival into a restore with the seconds named, a hair under the threshold still sends, normal path sends the line verbatim), and `inplaceFailureLine` (prefix 「直发失败：」, says 「原文已放回聊天框」 only when it really was, clips a 200-char reason to under 80 chars). Pure only — the bridge's real behaviour (`enter:false` paste-without-Enter, `Ctrl+A`+`Delete` clearing the box during grab) and the timing gates are manual acceptance, listed as M8b in `docs/ACCEPTANCE.md`.

