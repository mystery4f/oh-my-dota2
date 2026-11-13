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
import { runAsrEnginesProbe } from './asr-engines'
import { runAsrHotwordsProbe } from './asr-hotwords'
import { runAsrSwapProbe } from './asr-swap'
import { runChatBlockProbe } from './chat-block'
import { runGsiDumpProbe } from './gsi-dump'
import { runGsiProbe } from './gsi'
import { runGsiFramesReportProbe } from './gsi-frames-report'
import { runHoldWatchProbe } from './hold-watch'
import { runHotkeyProbe } from './hotkeys'
import { runInPlaceGuardProbe } from './inplace-guard'
import { runMatchReportProbe } from './match-report'
import { runOverlayGeometryProbe } from './overlay-geometry'
import { runProviderReasoningProbe } from './provider-reasoning'
import { runSettingsPersistProbe } from './settings-persist'
import { runSovitsRefsProbe } from './sovits-refs'
import { runSovitsVoicepackProbe } from './sovits-voicepack'
import { runTrainProbe } from './train'
import { runTranslateAccuracyProbe } from './translate-accuracy'
import { runTranslateCacheProbe } from './translate-cache'
import { runTtsBenchProbe } from './tts-bench'
import { runTtsOfflineProbe } from './tts-offline'
import { runTtsPipelineProbe } from './tts-pipeline'
import { runTtsPlayProbe } from './tts-play'
import { runTtsVoicesProbe } from './tts-voices'
import { runVoiceChainProbe } from './voice-chain'
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
    summary:
      'the pure line rules: `renderChatLine`/`withChatBody` round trip, translate-or-not, and the nickname regression',
    run: runChatBlockProbe
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
    summary: 'the sovits reference library reader (`listSovitsRefs`) against temp fixtures',
    run: runSovitsRefsProbe
  },
  {
    flag: '--sovits-voicepack-probe',
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
    summary: 'the translation ledger stores one pair per translation and answers in both directions',
    run: runTranslateCacheProbe
  },
  {
    flag: '--translate-accuracy-probe',
    summary: 'runs the real provider over a fixed line set and reports per-line accuracy and latency',
    run: runTranslateAccuracyProbe
  },
  {
    flag: '--overlay-geometry-probe',
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
    summary: 'the hold-to-talk signal chain end to end with no window and no mic (F13 via the resident watcher)',
    run: runHoldWatchProbe
  },
  {
    flag: '--voice-out-probe',
    summary: 'the pure 声出 decision seam (`src/shared/voice-out.ts`) plus readiness reasons',
    run: runVoiceOutProbe
  },
  {
    flag: '--voice-chain-probe',
    summary: 'the 对讲 timing account (`src/shared/voice-timing.ts` + `chain-timing.ts`), zero network',
    run: runVoiceChainProbe
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
    summary: 'the pure training decision seam (`src/shared/train.ts`): mutexes, preflight, run state',
    run: runTrainProbe
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
