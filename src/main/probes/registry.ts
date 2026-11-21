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
import { runDownloadProbe } from './download'
import { runHoldWatchProbe } from './hold-watch'
import { runVisionProbe } from './vision'
import { runHotkeyProbe } from './hotkeys'
import { runInPlaceGuardProbe } from './inplace-guard'
import { runMatchReportProbe } from './match-report'
import { runMatchAttributionProbe } from './match-attribution'
import { runHotwordCandidatesProbe } from './hotword-candidates'
import { runInterpretListenProbe } from './interpret-listen'
import { runInterpretLegProbe } from './interpret-leg'
import { runBuildInfoProbe } from './build-info'
import { runLogsIsolationProbe } from './logs-isolation'
import { runErrorLogProbe } from './error-log'
import { runOverlayGeometryProbe } from './overlay-geometry'
import { runOverlayA11yProbe } from './overlay-a11y'
import { runProviderReasoningProbe } from './provider-reasoning'
import { runSettingsPersistProbe } from './settings-persist'
import { runSovitsRefsProbe } from './sovits-refs'
import { runSovitsVoicepackProbe } from './sovits-voicepack'
import { runTrainProbe } from './train'
import { runAsrCheckLiveProbe } from './asr-check-live'
import { runTranslateAccuracyProbe } from './translate-accuracy'
import { runTranslateCacheProbe } from './translate-cache'
import { runMinimapProbe } from './minimap'
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
import { runGlossaryPackProbe } from './glossary-pack'
import { runMicHealthProbe } from './mic-health'
import { runOverlayDigestProbe } from './overlay-digest'
import { runKeyNounProbe } from './key-nouns'
import { runFtAuditionProbe } from './ft-audition'
import { runPatchWatchProbe } from './patch-watch'
import { runAsrRoutingProbe } from './asr-routing'
import { runAsrSwitchProbe } from './asr-switch'
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
   * 这个探针**必须碰用户的真日志/真数据**，所以 `probeRun` 不为它换临时目录。
   *
   * 默认（没有这一行）所有探针的 `logsDir()` 指向 `mkdtemp` 出来的临时目录：合成帧、
   * 假 matchid、假的对讲计时只落在临时目录里，跑完随进程消失。这条默认值是 #126 的
   * 结论——那之前探针真的把假 `gsi-summary.json` 留在用户数据里、把真实
   * `voice-chain.jsonl` 清空，下一局复盘读到的是探针的假局。
   *
   * 标这一位的只有三类：读上一局真日志（`--gsi-dump-report`、`--match-report`）、
   * 产出给人回放的产物（`--gsi-dump`、`--interpret-listen`）、读人手工放进去的素材
   * （`--minimap-probe`）。它们只读不写；写的那部分各自用 `mkdtemp`。
   */
  realLogs?: true
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
    realLogs: true,
    run: runGsiDumpProbe
  },
  {
    flag: '--gsi-dump-report',
    summary: 'reads the summary the app writes while it plays (`logs/gsi-summary.json`)',
    realLogs: true,
    run: runGsiFramesReportProbe
  },
  {
    flag: '--match-report',
    summary: 'folds one match out of the GSI log: unique lines vs raw frames, channel mix, game time',
    realLogs: true,
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
    flag: '--minimap-probe',
    ci: true,
    summary:
      'minimap hero dots: cost per frame and correct clustering on a synthetic frame — accuracy stays unmeasured without labelled screenshots',
    realLogs: true,
    run: runMinimapProbe
  },
  {
    flag: '--error-log-probe',
    ci: true,
    summary: 'the local error list: what counts as one, how repeats merge, and the line the panel reads',
    run: runErrorLogProbe
  },
  {
    flag: '--logs-isolation-probe',
    ci: true,
    summary: 'a probe process writes its logs to a temp dir, never into the user data directory',
    run: runLogsIsolationProbe
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
    flag: '--build-info-probe',
    ci: true,
    summary:
      'build freshness (ticket 113): an unreadable artifact says so instead of claiming fresh, a packaged build only reports its time, and a source newer than the artifact by more than the 2 s slack is named stale with the one command that fixes it',
    run: runBuildInfoProbe
  },
  {
    flag: '--interpret-leg-probe',
    ci: true,
    summary:
      'the interpretation leg (ticket 128): an empty recognition or translation never reaches the game mic, the chosen game-mic device wins over the output device, the leg never presses the talk key and never replays the translation locally, and with the mode off the recorded chain meta is unchanged',
    run: runInterpretLegProbe
  },
  {
    flag: '--interpret-listen-probe',
    summary:
      'can we hear the machine at all: loopback opens at 48 kHz, the track really carries sound, and GTCRN+VAD carve speech-sized segments',
    realLogs: true,
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
    flag: '--overlay-a11y-probe',
    ci: true,
    summary: 'every overlay text pair clears AA against its own backdrop, the three font steps fit the minimum window, and no state is told apart by colour alone',
    run: runOverlayA11yProbe
  },
  {
    flag: '--hotkey-probe',
    summary: 'the global-hotkey seam with zero window and zero game: accelerator round trip and collisions',
    run: runHotkeyProbe
  },
  {
    flag: '--download-probe',
    ci: true,
    summary: 'a download that drops mid-way resumes from the partial file, a source ignoring Range restarts clean, and a bad mirror falls through with the one actually used named in the log',
    run: runDownloadProbe
  },
  {
    flag: '--vision-probe',
    summary: 'look at the screen once: the payload is one message with the prompt and a data URL, a text-only model is refused with words, and no frame reaches the disk',
    run: runVisionProbe
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
    flag: '--glossary-pack-probe',
    ci: true,
    summary:
      'the swappable glossary pack (`src/shared/glossary-pack.ts` + `services/glossary-pack.ts`): a pack with a new hero maps both directions, a malformed pack falls back to the bundled table with the reason kept, and the active pack name is visible',
    run: runGlossaryPackProbe
  },
  {
    flag: '--overlay-digest-probe',
    ci: true,
    summary:
      'the combat-digest line (`src/shared/overlay-digest.ts`): every fragment quoted from an existing chat row (nothing invented, no model call), intent-first pick in chronological order, and the setting that hides the rows',
    run: runOverlayDigestProbe
  },
  {
    flag: '--asr-routing-probe',
    ci: true,
    summary:
      'the short/long ASR routing (`src/shared/asr-routing.ts`): short clips go to the fast engine (paraformer), long ones to the accurate one (qwen3), the rule can be switched off, and every switch is logged with its reason',
    run: runAsrRoutingProbe
  },
  {
    flag: '--asr-switch-probe',
    summary:
      'switching the ASR engine does not rebuild the graph (`resources/asr-sherpa-worker.cjs` keeps two recognisers, #142): the first switch loads the second model once, every switch after that is a cache hit, and a third key evicts the least recently used one',
    run: runAsrSwitchProbe
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
    flag: '--patch-watch-probe',
    summary:
      'the patch watch (`src/shared/patch-watch.ts`): fields the game sends that we never read, declared fields that stopped arriving once the sample is big enough, heroes the glossary cannot translate, and event types without a branch — a healthy install writes nothing and the panel line names the field or hero',
    ci: true,
    run: runPatchWatchProbe
  },
  {
    flag: '--ft-audition-probe',
    summary:
      'the pre-promotion audition (`src/shared/train/audition.ts` + `src/main/services/train/audition.ts`): both models transcribe the identical held-out recordings, the pairs and CER are graded by one pure seam, and skipping the audition is recorded on the run row',
    ci: true,
    run: runFtAuditionProbe
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
