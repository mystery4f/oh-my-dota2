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
  - `--minimap-probe` minimap hero dots: cost per frame and correct clustering on a synthetic frame — accuracy stays unmeasured without labelled screenshots
  - `--error-log-probe` the local error list: what counts as one, how repeats merge, and the line the panel reads
  - `--shadow-voice-probe` the first-match shadow: it never speaks, it records what would have been said, and it ends after one match
  - `--speech-split-probe` both split strategies on the same line, no character ever lost, and the panel preview is the same function the pipeline uses
  - `--speak-mute-probe` muting one speaker by hero or seat name, without silencing anybody else, and the list survives a restart
  - `--provider-failure-probe` provider failures: timeout, rate limit, bad key and wrong model each get their own sentence and their own retry cadence
  - `--logs-isolation-probe` a probe process writes its logs to a temp dir, never into the user data directory
  - `--board-probe` the second-screen bar: six rows read off one snapshot, a dash instead of a guess, and an honest line when there is no snapshot at all
  - `--first-run-probe` the first-run checklist: six steps, what counts as evidence in each, and why the last one needs the real game
  - `--match-attribution-probe` which match a row belongs to: one archive per match, the live summary holding only the current one, null instead of a guessed id, and every synthetic row confined to a temp logs dir
  - `--hotword-candidates-probe` hotword candidates from corrections: only >=2-char diffs enter the pool, sorting by count, explicit merge, full table never silently drops
  - `--build-info-probe` build freshness (ticket 113): an unreadable artifact says so instead of claiming fresh, a packaged build only reports its time, and a source newer than the artifact by more than the 2 s slack is named stale with the one command that fixes it
  - `--settings-bundle-probe` the settings bundle (ticket 81): export writes settings plus the training index into one zip with every key field blanked out, import restores each setting but keeps the local API key and proxy, and a partial or mismatched archive is refused before a single field is written
  - `--clause-stream-bench` measures first-audio and total latency of clause streaming vs whole-sentence speech against a real provider (`BENCH_BASE_URL` / `BENCH_MODEL`), never in CI
  - `--clause-plan-probe` the clause-stream plan (ticket 71): the transcript is split into clauses, the first clause is translated and spoken before the rest, delivery keeps the original order even when a later clause translates faster, and a clause that fails translation or synthesis is skipped without touching the others
  - `--overlay-focus-probe` the summon panel keyboard focus (ticket 103): Tab/Shift+Tab only ever move between the tab ring (four tabs + close) and the current row ring — last row Tab returns to the first tab and the first row Shift+Tab returns to close — rows page ten at a time, Home/End reach the ends, and no input ever receives an out-of-range slot
  - `--interpret-leg-probe` the interpretation leg (ticket 128): an empty recognition or translation never reaches the game mic, the chosen game-mic device wins over the output device, the leg never presses the talk key and never replays the translation locally, and with the mode off the recorded chain meta is unchanged
  - `--interpret-listen-probe` can we hear the machine at all: loopback opens at 48 kHz, the track really carries sound, and GTCRN+VAD carve speech-sized segments
  - `--translate-accuracy-probe` runs the real provider over a fixed line set and reports per-line accuracy and latency
  - `--overlay-geometry-probe` pure arithmetic of the overlay's geometry, hint priority, state reduction and unread counting
  - `--overlay-a11y-probe` every overlay text pair clears AA against its own backdrop, the three font steps fit the minimum window, and no state is told apart by colour alone
  - `--hotkey-probe` the global-hotkey seam with zero window and zero game: accelerator round trip and collisions
  - `--download-probe` a download that drops mid-way resumes from the partial file, a source ignoring Range restarts clean, and a bad mirror falls through with the one actually used named in the log
  - `--vision-probe` look at the screen once: the payload is one message with the prompt and a data URL, a text-only model is refused with words, and no frame reaches the disk
  - `--helm-empty-probe` the cockpit head and channel lines: three empty states verbatim, every missing field its own dash, living written as 活着, and hotkeys read from the live table
  - `--speaker-channel-probe` the cockpit channel data: no chat means no channels, a new match clears them, and an unknown seat is never guessed
  - `--hold-watch-probe` the hold-to-talk chain in three layers: the resident script reports OK, HOLD edges are recorded once each, and a dead script surfaces as fallback instead of silence
  - `--voice-out-probe` the pure 声出 decision seam (`src/shared/voice-out.ts`) plus readiness reasons
  - `--voice-chain-probe` the 对讲 timing account (`src/shared/voice-timing.ts` + `chain-timing.ts`), zero network
  - `--log-bundle-probe` the diagnostic bundle (`src/shared/log-bundle.ts` + `services/zip.ts`): masking, manifest, missing files, byte-stable archive
  - `--dataset-health-probe` the pre-training dataset health check (`src/shared/train/dataset-health.ts` + `services/train/wav-facts.ts`): duplicate lines, takes that carry no speech, missing script lines, duration distribution
  - `--glossary-pack-probe` the swappable glossary pack (`src/shared/glossary-pack.ts` + `services/glossary-pack.ts`): a pack with a new hero maps both directions, a malformed pack falls back to the bundled table with the reason kept, and the active pack name is visible
  - `--overlay-digest-probe` the combat-digest line (`src/shared/overlay-digest.ts`): every fragment quoted from an existing chat row (nothing invented, no model call), intent-first pick in chronological order, and the setting that hides the rows
  - `--asr-routing-probe` the short/long ASR routing (`src/shared/asr-routing.ts`): short clips go to the fast engine (paraformer), long ones to the accurate one (qwen3), the rule can be switched off, and every switch is logged with its reason
  - `--translation-mark-probe` the translation spot-check account (`src/shared/translation-mark.ts`): unmarked or untranslated lines never become samples, a re-mark replaces the earlier verdict, tallies group by provider and model, and a failed mark still speaks (ticket 87)
  - `--match-snapshot-probe` the second-screen data layer (`src/shared/match-snapshot.ts`): a synthetic frame fills every field, a missing hero/items/abilities block reads as null without ever reaching the stall warning, and abilities keep levels only — never a cooldown (ticket 124b)
  - `--target-language-probe` the target language of one message (`src/shared/target-language.ts`): the direction picks exactly one code, an unknown code falls back to the default instead of reaching the prompt, and only a non-default target adds the one output-language line (ticket 120)
  - `--offline-status-probe` the offline voice model judged through a pure seam: three different missing reasons, and the four UI states each tied to one rule
  - `--asr-routing-wire-probe` the short/long switch really reaches routeAsrClip, and on a machine with both models it really changes the engine (SKIP names the missing one)
  - `--env-report-probe` the machine check: six rows in fixed order, missing device counts read unknown, and all three port owners verified on an injected high port
  - `--quick-phrases-probe` quick-phrase groups and variables (`src/shared/quick-phrases.ts`): a phrase with {hero}/{time}/{matchid} renders with the live match values, an empty group is hidden rather than shown as a shell, and an unknown placeholder is left alone so a typo stays visible (ticket 117)
  - `--provider-board-probe` the provider board (`src/shared/provider-metrics.ts`): one row per call, median latency rather than mean, failure kinds counted separately instead of merged, and an empty board says "nobody called a model" instead of 0% (ticket 114)
  - `--probe-catalog-probe` the probe list the panel may show (`src/shared/probe-catalog.ts`): it equals the registry, read-only and exclusive are split by the marker alone, every row carries the command that actually runs it, and none claims it runs in the panel (ticket 112)
  - `--replay-star-probe` the in-game star for the replay (`src/shared/replay-star.ts`): stars carry the match they were made in, survive the match boundary, one line starred twice counts once, and a match nobody starred reads empty rather than everything (ticket 118)
  - `--asr-switch-probe` switching the ASR engine does not rebuild the graph (`resources/asr-sherpa-worker.cjs` keeps two recognisers, #142): the first switch loads the second model once, every switch after that is a cache hit, and a third key evicts the least recently used one
  - `--mic-health-probe` the microphone health gate (`src/shared/mic-health.ts`): a dead or muted device is judged before the voice chain starts, a take with no frames never reaches ASR, and the level bar is a monotone RMS mapping
  - `--announce-probe` game-state announcements (src/shared/dota-announce.ts + src/main/services/voice/announce.ts): wisdom rune / Roshan window / stack and pull windows each fire exactly once per occurrence from the game clock alone, a switched-off trigger stays silent, and with the master switch off the voice pipeline is never called
  - `--patch-watch-probe` the patch watch (`src/shared/patch-watch.ts`): fields the game sends that we never read, declared fields that stopped arriving once the sample is big enough, heroes the glossary cannot translate, and event types without a branch — a healthy install writes nothing and the panel line names the field or hero
  - `--ft-audition-probe` the pre-promotion audition (`src/shared/train/audition.ts` + `src/main/services/train/audition.ts`): both models transcribe the identical held-out recordings, the pairs and CER are graded by one pure seam, and skipping the audition is recorded on the run row
  - `--dataset-version-probe` the dataset version (`src/shared/train/dataset-version.ts`): a set of recordings gets one content-derived version, the run row keeps the version it trained on even after later takes arrive, and a row that predates the column says so instead of guessing
  - `--voice-device-switch-probe` the speak-device hot switch (`src/shared/voice-device-switch.ts`): a device change takes effect between segments so the playing one is never truncated, and a device that fails hands the next segment to the one that actually worked, with one sentence said out loud
  - `--speech-rate-probe` the long-line speed rule (`src/shared/speech-rate.ts`): a line past the length threshold speaks faster up to one ceiling, a short line keeps the user rate untouched, and no input can land outside the engine-accepted range
  - `--half-duplex-probe` the half-duplex guard (`src/shared/half-duplex.ts` + `src/main/services/voice/half-duplex.ts`): while our own audio is playing, a captured utterance is dropped and counted instead of transcribed, so interpretation mode cannot feed its own output back into ASR
  - `--key-noun-probe` the post-translation key-noun check (`src/shared/key-nouns.ts`): hero and item names extracted from the source once before translating, flagged when the translation drops one — the method never rewrites the delivered text
  - `--translate-direction-probe` per-line translation direction (`src/shared/translate-direction.ts`): Han share decides zh-en vs en-zh, digits and punctuation stay out of the denominator, and a manual correction applies to that one line for the rest of the session
  - `--quality-report-probe` the weekly quality card (`src/shared/quality-report.ts`): guard counts read line for line off `logs/translate-guard.jsonl`, cache snapshots off `logs/translate-cache.jsonl`, no invented miss rate, and a missing log file reads as zero instead of an error
  - `--speech-queue-probe` the speech queue and barge-in stop (#88): a stop ends delivery at the current segment boundary, no later segment starts, the queue snapshot drops to zero, and the stop flag never sticks to the next utterance
  - `--asr-hotwords-probe` the pure hotword seam (`src/shared/asr-hotwords.ts`): parse, diff, merge, cap
  - `--provider-reasoning-probe` the pure 推理 toggle seam (`src/shared/provider-reasoning.ts`), zero network and zero model
  - `--zhipu-live-probe` runs the real wrapped pipeline (warm-up → durable session + ledger) against zhipu
  - `--train-probe` the pure training decision seam (`src/shared/train.ts`): mutexes, preflight, run state
  - `--train-queue-probe` the training queue (`src/shared/train/queue.ts`): three waiting runs execute in order, and cancelling a waiting entry never reaches the running run
  - `--disk-budget-probe` the pre-run disk budget (`src/shared/train/disk-budget.ts`): a short volume refuses with the measured numbers, an unmeasurable one is let through, and the estimate stays inside the stated band
  - `--train-failure-probe` the training failure diagnosis (`src/shared/train/failure-diagnosis.ts`): every known shape maps to its stage, and an unknown one keeps the raw tail instead of guessing
  - `--companion-profile-probe` the same-match companion profile (`src/shared/companion-profile.ts`): one player reuses their earlier rendering, a new player starts clean, and the profile is dropped at match end
  - `--momentum-probe` the momentum band (`src/shared/momentum.ts`): no wording reads as a probability, the hover row carries both inputs, and a frame without net worth renders nothing
  - `--endpoint-probe` the end-of-utterance window (`src/shared/endpoint.ts`): each preset cuts at its own silence window, a preset change applies on the next recording, and a breath shorter than the minimum voiced time never ends an utterance
  - `--voice-review-probe` the edited-transcript rule (`src/shared/voice-review.ts`): an edit is what gets translated and recorded as a correction pair, while an untouched or re-cleared line behaves exactly as before
  - `--latency-board-probe` the per-provider latency board (`src/shared/latency-board.ts`): P50/P95 recomputed from the recorded samples only, and a provider with no turns says so instead of showing 0 ms
  - `--report-image-probe` the per-match report image (`src/shared/match-report.ts` + `src/main/services/report/match-report.ts`): every number comes from logs/voice-chain.jsonl, and a match with no voice activity still renders a report that says so
  - `--interpret-switch-probe` the interpretation switch (`src/shared/interpret.ts`): off on a fresh install, one sentence naming Chinese-in/English-out/cable/local-echo, no audio file in logs, and disabling returns to the reply leg on the next utterance
  - `--asr-check-live-probe` runs the real model over the ledger recordings and prints the CER ranking split into train / eval
  - `--voice-runtime-probe` the voice runtime installer state (`src/main/services/voice/runtime.ts`) with temp fixtures
  - `--voice-worker-probe` the NDJSON resident-worker protocol harness (`src/main/services/voice/worker.ts`), zero models
  - `--asr-engines-probe` the ASR engine table plus the model registry: each row is self-consistent with the files on disk
  - `--inplace-guard-probe` the in-place send guards: composition text, empty draft, stale session
  - `--voice-pack-bundle-probe` the single-file voice pack: export→import round trip, and a pack missing its reference audio or prompt text is refused by name with nothing written
  - `--asr-swap-probe` diagnostic: prints the swap states and the steps a promote would take (`--asr-swap-apply` runs it)
<!-- probes:end -->

 Ticket 62 pins the inference-hold switch itself (`src/main/services/voice/sovits-server.ts`): `setInferenceHold`/`sovitsInferenceHeld` are idempotent booleans (repeated set or clear never stacks), a held `ensureSovitsServer` returns false logging `TTS_SOVITS_SERVER_HELD` **without touching the port or the engine-package dir** (so no spawn), and after one clear it walks the normal path again (injected `SovitsEnsureIo` port/home → `install-not-found`, since the probe must stay zero-process; the real spawn is manual acceptance). A source-text wiring pin also reads `src/main/services/train/manager.ts` and fails if either `setInferenceHold(true)` (start) or `setInferenceHold(false)` (finish) disappears — skipped, not failed, when `src/` is absent (installed build). Spawning a real task and stopping it mid-run is manual acceptance.  - `--inplace-guard-probe` the pure seam behind in-place send (`src/shared/inplace.ts`), zero game and zero input bridge: `pickInPlaceDraft` (fresh text wins, `NOCONTENT` + an orphaned draft from an interrupted run continues that sentence instead of reporting an empty chat box, other codes never borrow the orphan, blank text is `empty`, missing reason still says something human), `decideInPlaceDelivery` (cancelled abandons before anything else and never touches the box, empty translation restores the Chinese, `INPLACE_STALE_MS` = 20 s turns a late arrival into a restore with the seconds named, a hair under the threshold still sends, normal path sends the line verbatim), and `inplaceFailureLine` (prefix 「直发失败：」, says 「原文已放回聊天框」 only when it really was, clips a 200-char reason to under 80 chars). Pure only — the bridge's real behaviour (`enter:false` paste-without-Enter, `Ctrl+A`+`Delete` clearing the box during grab) and the timing gates are manual acceptance, listed as M8b in `docs/ACCEPTANCE.md`.

