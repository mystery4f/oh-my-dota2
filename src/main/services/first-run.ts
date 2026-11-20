import { ASR_ENGINE_LIST } from '@shared/asr/engines'
import { judgeFirstRun, type FirstRunReport, type ProviderProbe } from '@shared/first-run'
import { portableDataDir } from './data-dir'
import { gsiStatus } from './gsi'
import { hotkeysState } from './hotkeys'
import { loadSettings } from './settings'
import { activeAsrModel, asrStatus, engineSpecOf } from './voice/asr-model'

/**
 * 上手检查的输入凑齐处：判断本身在 `@shared/first-run` 的纯函数里，这里只负责
 * 「把这些模块的现状搬成六步的输入」。之所以不缓存：GSI 帧、下载进度、热键占用
 * 都是随时会变的，快照一缓存就变成「面板说要进游戏，其实早就进过了」。
 */

/**
 * 最后一次真连的结果。只由 `PROVIDER_TEST` 的成功/失败写入——
 * 「我明明填了 key」和「key 真能用」是两件事，这一步只认后者。
 */
let lastProbe: ProviderProbe | null = null

export function recordProviderProbe(
  provider: { id: string; model: string },
  result: { ok: boolean; message: string; latencyMs?: number }
): void {
  lastProbe = {
    providerId: provider.id,
    model: provider.model,
    ok: result.ok,
    message: result.message,
    latencyMs: result.latencyMs
  }
}

/** 探针/面板想看「最后一次真连」时用；测试用不着就别新增入口。 */
export function currentProviderProbe(): ProviderProbe | null {
  return lastProbe
}

/** 现役（或兜底）引擎的下载清单总字节；只能手动放置的引擎返回 null。 */
function expectedBytes(): number | null {
  const active = activeAsrModel()
  const spec = active !== null ? engineSpecOf(active) : ASR_ENGINE_LIST.find((item) => item.download !== null)
  const download = spec?.download ?? null
  if (download === null) return null
  return download.files.reduce((sum, file) => sum + file.bytes, 0)
}

export function firstRunReport(): FirstRunReport {
  const settings = loadSettings()
  const gsi = gsiStatus()
  const asr = asrStatus()
  const hotkeys = hotkeysState()
  return judgeFirstRun({
    provider: {
      id: settings.provider.id,
      model: settings.provider.model,
      // 空白 key 等于没填：粘贴时空格最容易混进来。
      hasKey: settings.provider.apiKey.trim() !== '',
      lastTest: lastProbe
    },
    gsi: {
      configPath: gsi.configPath,
      configError: gsi.configError,
      lastAt: gsi.lastAt,
      gameState: gsi.gameState
    },
    asr: {
      ready: asr.ready,
      downloading: asr.downloading,
      progress: asr.progress,
      error: asr.error,
      dir: asr.dir,
      expectedBytes: expectedBytes()
    },
    hotkeys: {
      rejected: hotkeys.actions
        .filter((action) => action.verdict === 'rejected')
        .map((action) => ({ label: action.label, display: action.display })),
      total: hotkeys.actions.length
    },
    dataDir: portableDataDir(),
    now: Date.now()
  })
}
