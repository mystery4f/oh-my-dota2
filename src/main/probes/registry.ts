/**
 * 探针登记表：**唯一**的一份清单。
 *
 * 以前 `index.ts` 有 31 行 `if (process.argv.includes('--x-probe')) void runX()`，`docs/PROBES.md`
 * 是第二份手写清单，两边各漏各的（`--translate-accuracy-probe`、`--asr-swap-probe`、
 * `--voice-runtime-probe`、`--tts-voices-probe`、`--inplace-guard-probe` 都不在文档里）。
 * 现在新增探针只在表里加一行：分发、`--probes-md` 打印的目录、`check:probes` 的一致性检查都读这里。
 *
 * 一行 = 一个可执行探针。`flag` 必须以 `-probe` 结尾的，`probeRun` 才会把常驻接线（热键表、
 * 常驻桥、预热）整体跳过；`--tts-bench` 这类不是探针风格的命令也在表里，所以判定不靠后缀。
 */
import { runInPlaceProbe, runReplyLatencyProbe } from './latency'
import { runAnnounceProbe } from './announce'
import { runAsrEnginesProbe } from './asr-engines'
import { runAsrHotwordsProbe } from './asr-hotwords'
import { runAsrSwapProbe } from './asr-swap'
import { runChatBlockProbe } from './chat-block'
import { runDotaDisplayProbe } from './dota-display'
import { runGsiDumpProbe } from './gsi-dump'
import { runGsiProbe } from './gsi'
import { runGsiFramesReportProbe } from './gsi-frames-report'
import { runHoldWatchProbe } from './hold-watch'
import { runHotkeyProbe } from './hotkeys'
import { runInPlaceGuardProbe } from './inplace-guard'
import { runMatchReportProbe } from './match-report'
import { runMatchAttributionProbe } from './match-attribution'
import { runHotwordCandidatesProbe } from './hotword-candidates'
import { runInterpretListenProbe } from './interpret-listen'
import { runOverlayGeometryProbe } from './overlay-geometry'
import { runProviderReasoningProbe } from './provider-reasoning'
import { runSettingsPersistProbe } from './settings-persist'
import { runSovitsRefsProbe } from './sovits-refs'
import { runSovitsVoicepackProbe } from './sovits-voicepack'
import { runTrainProbe } from './train'
import { runAsrCheckLiveProbe } from './asr-check-live'
import { runTranslateAccuracyProbe } from './translate-accuracy'
import { runTranslateCacheProbe } from './translate-cache'
import { runTranslateGuardProbe } from './translate-guard'
import { runFirstRunProbe } from './first-run'
import { runTtsBenchProbe } from './tts-bench'
import { runTtsOfflineProbe } from './tts-offline'
import { runTtsPipelineProbe } from './tts-pipeline'
import { runTtsPlayProbe } from './tts-play'
import { runTtsVoicesProbe } from './tts-voices'
import { runVoiceChainProbe } from './voice-chain'
import { runLogBundleProbe } from './log-bundle'
import { runDatasetHealthProbe } from './dataset-health'
import { runMicHealthProbe } from './mic-health'
import { runOverlayDigestProbe } from './overlay-digest'
import { runKeyNounProbe } from './key-nouns'
import { runTranslateDirectionProbe } from './translate-direction'
import { runQualityReportProbe } from './quality-report'
import { runSpeechQueueProbe } from './speech-queue'
import { runVoiceOutProbe } from './voice-out'
import { runVoiceRuntimeProbe } from './voice-runtime'
import { runVoiceWorkerProbe } from './voice-worker'
import { runZhipuLiveProbe } from './zhipu-live'

export interface ProbeEntry {
  /** 命令行标志，例如 `--chat-block-probe`。 */
  flag: string
  /** 目录里的那一行说明（写进 `docs/PROBES.md`，英文与那份文档一致）。 */
  summary: string
  run: () => void | Promise<void>
  /**
   * 进 CI：标在「便宜、不碰硬件、不读用户数据」的探针上。
   *
   * 这份标记以前是 `ci.yml` 里的第三份手写清单（9 个 `npx electron …` 一行一个），
   * 和 `docs/PROBES.md` 一样会跟真表漂移；现在 CI 自己来问表（`--probes-ci`），
   * 加一个进 CI 的探针只改这一行。
   */
  ci?: true
}

export const PROBES: readonly ProbeEntry[] = [
  {
    flag: '--inplace-probe',
    summary: 'resident input bridge ping',
    run: runInPlaceProbe
  },
  {
    flag: '--reply-latency-probe',
    summary: 'reply translation latency after warm-up',
    run: runReplyLatencyProbe
  },
  {
    flag: '--tts-bench',
    summary:
      'synthesizes Chinese sentences through the Edge voice, prints `ok/failed/p50/min/max` ms and bytes',
    run: runTtsBenchProbe
  },
  {
    flag: '--tts-offline-probe',
    summary: 'synthesizes 3 Chinese lines through one offline voice (`baker` | `xiao_ya` | `eula`)',
    run: runTtsOfflineProbe
  },
  {
    flag: '--tts-voices-probe',
    summary: 'the offline voice catalogue: which archive each model comes from and that it loads',
    run: runTtsVoicesProbe
  },
  {
    flag: '--tts-pipeline-probe',
    ci: true,
    summary: 'the synthesis→delivery pipeline behind `speakPipeline` with fake injected engines',
    run: runTtsPipelineProbe
  },
  {
    flag: '--tts-play-probe',
    summary: 'the full speak delivery chain: decideSpeak cases, engine propagation, cache and backlog',
    run: runTtsPlayProbe
  },
  {
    flag: '--chat-block-probe',
    ci: true,
    summary:
      'the pure line rules: `renderChatLine`/`withChatBody` round trip, translate-or-not, and the nickname regression',
    run: runChatBlockProbe
  },
  {
    flag: '--dota-display-probe',
    summary:
      'reads Dota 2 `video.txt` and says whether the game is exclusive-fullscreen (nothing can draw over it)',
    run: runDotaDisplayProbe
  },
  {
    flag: '--gsi-probe',
    summary: 'Game State Integration listener: pure verdict cases + a real HTTP round trip (no game needed)',
    run: runGsiProbe
  },
  {
    flag: '--settings-persist-probe',
    summary: 'panel choices survive a restart: sentinel round trip per field, no cross-field clobber',
    run: runSettingsPersistProbe
  },
  {
    flag: '--sovits-refs-probe',
    ci: true,
    summary: 'the sovits reference library reader (`listSovitsRefs`) against temp fixtures',
    run: runSovitsRefsProbe
  },
  {
    flag: '--sovits-voicepack-probe',
    ci: true,
    summary: 'the voice pack pipeline with zero network and zero engine: plan, install, state, delete',
    run: runSovitsVoicepackProbe
  },
  {
    flag: '--gsi-dump',
    summary: 'prints every field path Dota actually pushes (type/hits/sample) into `logs/gsi-frames.json`',
    run: runGsiDumpProbe
  },
  {
    flag: '--gsi-dump-report',
    summary: 'reads the summary the app writes while it plays (`logs/gsi-summary.json`)',
    run: runGsiFramesReportProbe
  },
  {
    flag: '--match-report',
    summary: 'folds one match out of the GSI log: unique lines vs raw frames, channel mix, game time',
    run: runMatchReportProbe
  },
  {
    flag: '--translate-cache-probe',
    ci: true,
    summary: 'the translation ledger stores one pair per translation and answers in both directions',
    run: runTranslateCacheProbe
  },
  {
    flag: '--translate-guard-probe',
    ci: true,
    summary:
      'the fidelity guard telemetry: blocked / recovered / gaveUp counts, dirty jsonl lines, and one batched write',
    run: runTranslateGuardProbe
  },
  {
    flag: '--first-run-probe',
    ci: true,
    summary:
      'the first-run checklist: six steps, what counts as evidence in each, and why the last one needs the real game',
    run: runFirstRunProbe
  },
  {
    flag: '--match-attribution-probe',
    ci: true,
    summary:
      'which match a row belongs to: one archive per match, the live summary holding only the current one, null instead of a guessed id, and every synthetic row confined to a temp logs dir',
    run: runMatchAttributionProbe
  },
  {
    flag: '--hotword-candidates-probe',
    ci: true,
    summary:
      'hotword candidates from corrections: only >=2-char diffs enter the pool, sorting by count, explicit merge, full table never silently drops',
    run: runHotwordCandidatesProbe
  },
  {
    flag: '--interpret-listen-probe',
    summary:
      'can we hear the machine at all: loopback opens at 48 kHz, the track really carries sound, and GTCRN+VAD carve speech-sized segments',
    run: runInterpretListenProbe
  },
  {
    flag: '--translate-accuracy-probe',
    summary: 'runs the real provider over a fixed line set and reports per-line accuracy and latency',
    run: runTranslateAccuracyProbe
  },
  {
    flag: '--overlay-geometry-probe',
    ci: true,
    summary: "pure arithmetic of the overlay's geometry, hint priority, state reduction and unread counting",
    run: runOverlayGeometryProbe
  },
  {
    flag: '--hotkey-probe',
    summary: 'the global-hotkey seam with zero window and zero game: accelerator round trip and collisions',
    run: runHotkeyProbe
  },
  {
    flag: '--hold-watch-probe',
    summary: 'the hold-to-talk chain in three layers: the resident script reports OK, HOLD edges are recorded once each, and a dead script surfaces as fallback instead of silence',
    run: runHoldWatchProbe
  },
  {
    flag: '--voice-out-probe',
    ci: true,
    summary: 'the pure 声出 decision seam (`src/shared/voice-out.ts`) plus readiness reasons',
    run: runVoiceOutProbe
  },
  {
    flag: '--voice-chain-probe',
    ci: true,
    summary: 'the 对讲 timing account (`src/shared/voice-timing.ts` + `chain-timing.ts`), zero network',
    run: runVoiceChainProbe
  },
  {
    flag: '--log-bundle-probe',
    ci: true,
    summary:
      'the diagnostic bundle (`src/shared/log-bundle.ts` + `services/zip.ts`): masking, manifest, missing files, byte-stable archive',
    run: runLogBundleProbe
  },
  {
    flag: '--dataset-health-probe',
    ci: true,
    summary:
      'the pre-training dataset health check (`src/shared/train/dataset-health.ts` + `services/train/wav-facts.ts`): duplicate lines, takes that carry no speech, missing script lines, duration distribution',
    run: runDatasetHealthProbe
  },
  {
    flag: '--overlay-digest-probe',
    ci: true,
    summary:
      'the combat-digest line (`src/shared/overlay-digest.ts`): every fragment quoted from an existing chat row (nothing invented, no model call), intent-first pick in chronological order, and the setting that hides the rows',
    run: runOverlayDigestProbe
  },
  {
    flag: '--mic-health-probe',
    ci: true,
    summary:
      'the microphone health gate (`src/shared/mic-health.ts`): a dead or muted device is judged before the voice chain starts, a take with no frames never reaches ASR, and the level bar is a monotone RMS mapping',
    run: runMicHealthProbe
  },
  {
    flag: '--announce-probe',
    ci: true,
    summary:
      'game-state announcements (src/shared/dota-announce.ts + src/main/services/voice/announce.ts): wisdom rune / Roshan window / stack and pull windows each fire exactly once per occurrence from the game clock alone, a switched-off trigger stays silent, and with the master switch off the voice pipeline is never called',
    run: runAnnounceProbe
  },
  {
    flag: '--key-noun-probe',
    ci: true,
    summary:
      'the post-translation key-noun check (`src/shared/key-nouns.ts`): hero and item names extracted from the source once before translating, flagged when the translation drops one — the method never rewrites the delivered text',
    run: runKeyNounProbe
  },
  {
    flag: '--translate-direction-probe',
    ci: true,
    summary:
      'per-line translation direction (`src/shared/translate-direction.ts`): Han share decides zh-en vs en-zh, digits and punctuation stay out of the denominator, and a manual correction applies to that one line for the rest of the session',
    run: runTranslateDirectionProbe
  },
  {
    flag: '--quality-report-probe',
    ci: true,
    summary:
      'the weekly quality card (`src/shared/quality-report.ts`): guard counts read line for line off `logs/translate-guard.jsonl`, cache snapshots off `logs/translate-cache.jsonl`, no invented miss rate, and a missing log file reads as zero instead of an error',
    run: runQualityReportProbe
  },
  {
    flag: '--speech-queue-probe',
    ci: true,
    summary:
      'the speech queue and barge-in stop (#88): a stop ends delivery at the current segment boundary, no later segment starts, the queue snapshot drops to zero, and the stop flag never sticks to the next utterance',
    run: runSpeechQueueProbe
  },
  {
    flag: '--asr-hotwords-probe',
    summary: 'the pure hotword seam (`src/shared/asr-hotwords.ts`): parse, diff, merge, cap',
    run: runAsrHotwordsProbe
  },
  {
    flag: '--provider-reasoning-probe',
    summary: 'the pure 推理 toggle seam (`src/shared/provider-reasoning.ts`), zero network and zero model',
    run: runProviderReasoningProbe
  },
  {
    flag: '--zhipu-live-probe',
    summary: 'runs the real wrapped pipeline (warm-up → durable session + ledger) against zhipu',
    run: runZhipuLiveProbe
  },
  {
    flag: '--train-probe',
    ci: true,
    summary: 'the pure training decision seam (`src/shared/train.ts`): mutexes, preflight, run state',
    run: runTrainProbe
  },
  {
    flag: '--asr-check-live-probe',
    summary: 'runs the real model over the ledger recordings and prints the CER ranking split into train / eval',
    run: runAsrCheckLiveProbe
  },
  {
    flag: '--voice-runtime-probe',
    summary: 'the voice runtime installer state (`src/main/services/voice/runtime.ts`) with temp fixtures',
    run: runVoiceRuntimeProbe
  },
  {
    flag: '--voice-worker-probe',
    summary: 'the NDJSON resident-worker protocol harness (`src/main/services/voice/worker.ts`), zero models',
    run: runVoiceWorkerProbe
  },
  {
    flag: '--asr-engines-probe',
    summary: 'the ASR engine table plus the model registry: each row is self-consistent with the files on disk',
    run: runAsrEnginesProbe
  },
  {
    flag: '--inplace-guard-probe',
    summary: 'the in-place send guards: composition text, empty draft, stale session',
    run: runInPlaceGuardProbe
  },
  {
    flag: '--asr-swap-probe',
    summary: 'diagnostic: prints the swap states and the steps a promote would take (`--asr-swap-apply` runs it)',
    run: runAsrSwapProbe
  }
]

/** 目录正文：`docs/PROBES.md` 的清单段落由它生成，别处不再手写一份。 */
export function renderProbeCatalogue(): string {
  return PROBES.map((probe) => `- \`${probe.flag}\` ${probe.summary}`).join('\n')
}

/** CI 要跑的那几条：`--probes-ci` 打出来，工作流照着跑，不再自己维护一份清单。 */
export function ciProbeFlags(): string[] {
  return PROBES.filter((probe) => probe.ci === true).map((probe) => probe.flag)
}
