/**
 * 首次上手检查：把「新用户从空数据目录到第一局」拆成六步，每步只给一句话证据。
 *
 * 为什么不是引导窗口：卡住人的从来不是点几个「下一步」，而是每一步没有可信证据。
 * 原来的「一键自检」只看捕获服务开没开——服务开着也证明不了 GSI 帧真的到过，
 * 于是用户以为配好了、进游戏发现一句话都没上屏。所以这里的每一行都必须能核对：
 * 路径、毫秒数、秒数、被占用的键名；写不出数字就写原因，不写「已配置」。
 *
 * 最后一步（gsi-frames）永远是「进游戏后点这里」：GSI 的 cfg 只在 Dota 启动时读，
 * 帧也只能由真游戏推过来，任何离线跑绿的验收都是假的。
 *
 * 纯函数，不碰 IO：凑输入是 `src/main/services/first-run.ts` 的事。
 */

export type FirstRunStepId = 'provider' | 'gsi-config' | 'gsi-frames' | 'asr-model' | 'hotkeys' | 'data-dir'

/** ok = 有证据；pending = 还差用户动手或等游戏；blocked = 卡住了，必须先修；unknown = 快照还没到。 */
export type FirstRunState = 'ok' | 'pending' | 'blocked' | 'unknown'

/** 该状态唯一的下一步：渲染层按下它要做的事，用联合类型钉住，别在面板里比对中文文案。 */
export type FirstRunAction = 'open-engine' | 'test-provider' | 'download-asr' | 'open-asr' | 'open-hotkeys'

export interface FirstRunStep {
  id: FirstRunStepId
  label: string
  state: FirstRunState
  /** 能核对的事实：路径 / 延迟 / 秒数 / 键名 / 失败原因。 */
  evidence: string
  /** ok 与 unknown 没有可做的动作。 */
  action: FirstRunAction | null
  /** 按钮上的字；action 为 null 时是空串。 */
  actionLabel: string
}

export interface FirstRunReport {
  steps: FirstRunStep[]
  /** 已经有证据的步数，面板显示「4/6」。 */
  done: number
  /** 还差几处，0 = 这条链能开局了。 */
  open: number
}

export interface ProviderProbe {
  providerId: string
  model: string
  ok: boolean
  message: string
  latencyMs?: number
}

export interface FirstRunInput {
  provider: {
    id: string
    model: string
    /** `provider.apiKey` 非空。空 key 时连测试都没意义，这是新用户的第一步。 */
    hasKey: boolean
    /** 最后一次真连的结果；没连过是 null。 */
    lastTest: ProviderProbe | null
  }
  gsi: {
    configPath: string | null
    configError: string | null
    lastAt: number | null
    gameState: string | null
  }
  asr: {
    ready: boolean
    downloading: boolean
    progress: number
    error: string | null
    dir: string
    /** 这份引擎的下载清单总字节；只能手动放置时为 null。 */
    expectedBytes: number | null
  }
  hotkeys: { rejected: { label: string; display: string }[]; total: number }
  dataDir: string | null
  now: number
}

/** 帧比这更久没来就当「现在没连上」：GSI 心跳 30 秒一次，两分钟足够判死。 */
const FRESH_FRAME_MS = 120_000

export function formatMegabytes(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`
}

function secondsAgo(at: number, now: number): number {
  return Math.max(0, Math.round((now - at) / 1000))
}

/** 「X 秒前」比时间戳好读，用户核对的是「刚才那一局」。 */
function agoText(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒前`
  const minutes = Math.round(ms / 60_000)
  return minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`
}

function judgeProvider(input: FirstRunInput): FirstRunStep {
  const { id, model, hasKey, lastTest } = input.provider
  const where = `${id} · ${model}`
  if (!hasKey)
    return {
      id: 'provider',
      label: '模型服务',
      state: 'blocked',
      evidence: `还没填 API Key（${where}）`,
      action: 'open-engine',
      actionLabel: '去填 Key'
    }
  // 测试记录要跟着当前供应商走：换过供应商或用旧记录充数，等于没测。
  const fresh = lastTest !== null && lastTest.providerId === id && lastTest.model === model
  if (!fresh)
    return {
      id: 'provider',
      label: '模型服务',
      state: 'pending',
      evidence: `Key 已填，还没真连过（${where}）`,
      action: 'test-provider',
      actionLabel: '真连一次'
    }
  if (!lastTest.ok)
    return {
      id: 'provider',
      label: '模型服务',
      state: 'blocked',
      evidence: `${lastTest.message}（${where}）`,
      action: 'test-provider',
      actionLabel: '再连一次'
    }
  const latency = lastTest.latencyMs === undefined ? '' : `${lastTest.latencyMs} ms · `
  return {
    id: 'provider',
    label: '模型服务',
    state: 'ok',
    evidence: `${latency}${where}`,
    action: null,
    actionLabel: ''
  }
}

function judgeGsiConfig(input: FirstRunInput): FirstRunStep {
  const { configPath, configError } = input.gsi
  if (configPath !== null)
    return {
      id: 'gsi-config',
      label: 'GSI 配置',
      state: 'ok',
      // 路径本身就是证据：多库/移动硬盘的用户要能看出写进了哪个 Steam 库。
      evidence: configPath,
      action: null,
      actionLabel: ''
    }
  if (configError !== null)
    return {
      id: 'gsi-config',
      label: 'GSI 配置',
      state: 'blocked',
      evidence: configError,
      action: null,
      actionLabel: ''
    }
  return {
    id: 'gsi-config',
    label: 'GSI 配置',
    state: 'unknown',
    evidence: '主进程还没试过写 cfg（GSI 未启动）',
    action: null,
    actionLabel: ''
  }
}

function judgeGsiFrames(input: FirstRunInput): FirstRunStep {
  const { lastAt, gameState } = input.gsi
  if (lastAt === null)
    return {
      id: 'gsi-frames',
      label: '游戏连上',
      state: 'pending',
      // 这句是整条链唯一不能离线验证的一步，文案要直接说清怎么办。
      evidence: 'Dota 还没推过帧：改过 cfg 必须重启游戏，进对局后回到这里',
      action: null,
      actionLabel: ''
    }
  const gap = input.now - lastAt
  if (gap > FRESH_FRAME_MS)
    return {
      id: 'gsi-frames',
      label: '游戏连上',
      state: 'pending',
      evidence: `最后一次推送在 ${agoText(gap)}，游戏当前没连上`,
      action: null,
      actionLabel: ''
    }
  return {
    id: 'gsi-frames',
    label: '游戏连上',
    state: 'ok',
    evidence: `${gameState ?? '无对局状态'} · ${secondsAgo(lastAt, input.now)} 秒前收到一帧`,
    action: null,
    actionLabel: ''
  }
}

function judgeAsrModel(input: FirstRunInput): FirstRunStep {
  const { ready, downloading, progress, error, dir, expectedBytes } = input.asr
  if (ready)
    return {
      id: 'asr-model',
      label: '识别模型',
      state: 'ok',
      evidence: dir,
      action: null,
      actionLabel: ''
    }
  if (downloading)
    return {
      id: 'asr-model',
      label: '识别模型',
      state: 'pending',
      evidence: `下载中 ${Math.round(progress * 100)}%${expectedBytes === null ? '' : ` · 共 ${formatMegabytes(expectedBytes)}`}`,
      action: null,
      actionLabel: ''
    }
  if (error !== null)
    return {
      id: 'asr-model',
      label: '识别模型',
      state: 'blocked',
      evidence: error,
      action: 'download-asr',
      actionLabel: '重试下载'
    }
  if (expectedBytes === null)
    return {
      id: 'asr-model',
      label: '识别模型',
      state: 'blocked',
      evidence: '这份引擎没有下载清单，只能手动放进 models 目录',
      action: 'open-asr',
      actionLabel: '看目录'
    }
  return {
    id: 'asr-model',
    label: '识别模型',
    state: 'pending',
    evidence: `还没下（${formatMegabytes(expectedBytes)}），对讲和直发要用它`,
    action: 'download-asr',
    actionLabel: '现在下'
  }
}

function judgeHotkeys(input: FirstRunInput): FirstRunStep {
  const { rejected, total } = input.hotkeys
  if (total === 0)
    return {
      id: 'hotkeys',
      label: '热键',
      state: 'unknown',
      evidence: '还没拿到热键表',
      action: null,
      actionLabel: ''
    }
  if (rejected.length > 0) {
    // 只报第一个：一行里塞五个键名没人读，用户先解决最影响操作的那个。
    const [first] = rejected
    const more = rejected.length > 1 ? ` 等 ${rejected.length} 个` : ''
    return {
      id: 'hotkeys',
      label: '热键',
      state: 'blocked',
      evidence: `${first.label} 的 ${first.display} 被别的程序占着${more}`,
      action: 'open-hotkeys',
      actionLabel: '换一个键'
    }
  }
  return {
    id: 'hotkeys',
    label: '热键',
    state: 'ok',
    evidence: `${total} 个动作都注册上了`,
    action: null,
    actionLabel: ''
  }
}

function judgeDataDir(input: FirstRunInput): FirstRunStep {
  if (input.dataDir === null)
    return {
      id: 'data-dir',
      label: '数据目录',
      state: 'unknown',
      evidence: '还没确定（用着 %APPDATA% 兜底）',
      action: null,
      actionLabel: ''
    }
  return {
    id: 'data-dir',
    label: '数据目录',
    state: 'ok',
    evidence: input.dataDir,
    action: null,
    actionLabel: ''
  }
}

/** 六步按「先修哪个」排序：没有 key 什么都跑不动，最后一步才是进游戏。 */
export function judgeFirstRun(input: FirstRunInput): FirstRunReport {
  const steps = [
    judgeProvider(input),
    judgeGsiConfig(input),
    judgeAsrModel(input),
    judgeHotkeys(input),
    judgeDataDir(input),
    judgeGsiFrames(input)
  ]
  return {
    steps,
    done: steps.filter((step) => step.state === 'ok').length,
    open: steps.filter((step) => step.state === 'pending' || step.state === 'blocked').length
  }
}
