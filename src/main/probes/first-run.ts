/**
 * 上手检查的纯判断缝：六步各自在什么输入下才算「有证据」，以及被卡住时那句话能不能核对。
 *
 * 这里钉住的不是 UI，而是口径——尤其是两条：
 * - 没填 key 和「填了 key 但真连失败」不是同一件事，用户要做的动作也不一样；
 * - 最后一步只有真游戏推过帧才算过，脚本给不了它一个假的通过（GSI 的 cfg 只在 Dota 启动时读）。
 *
 * 零网络、零窗口、零模型：输入全是构造的。
 */
import { exitProbe } from './harness'
import { judgeFirstRun, type FirstRunInput, type FirstRunStep } from '@shared/first-run'

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)

/** 一份「什么都配好了」的输入；每个用例只改自己要问的那一处。 */
function base(over: Partial<FirstRunInput> = {}): FirstRunInput {
  return {
    provider: {
      id: 'deepseek',
      model: 'deepseek-chat',
      hasKey: true,
      lastTest: { providerId: 'deepseek', model: 'deepseek-chat', ok: true, message: 'ok', latencyMs: 640 }
    },
    gsi: { configPath: 'D:\\Steam\\dota\\cfg\\gamestate_integration', configError: null, lastAt: NOW - 4000, gameState: 'GAME_IN_PROGRESS' },
    asr: { ready: true, downloading: false, progress: 0, error: null, dir: 'C:\\data\\asr-models\\paraformer', expectedBytes: 227_405_559 },
    hotkeys: { rejected: [], total: 8 },
    dataDir: 'C:\\data',
    now: NOW,
    ...over
  }
}

function step(input: FirstRunInput, id: FirstRunStep['id']): FirstRunStep {
  const found = judgeFirstRun(input).steps.find((item) => item.id === id)
  if (found === undefined) throw new Error(`missing step ${id}`)
  return found
}

export async function runFirstRunProbe(): Promise<void> {
  const checks: { name: string; ok: boolean; detail?: string }[] = []
  const add = (name: string, ok: boolean, detail?: string): void => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail })
  }

  // ---- 步序：最后一步必须是「进游戏」----
  const order = judgeFirstRun(base()).steps.map((item) => item.id).join(',')
  add('步序：模型 → GSI 配置 → 识别模型 → 热键 → 数据目录 → 游戏连上', order === 'provider,gsi-config,asr-model,hotkeys,data-dir,gsi-frames', order)

  // ---- 模型服务：空 key 与「填了但没测过」不是同一件事 ----
  const noKey = step(base({ provider: { id: 'deepseek', model: 'deepseek-chat', hasKey: false, lastTest: null } }), 'provider')
  add('没填 key：blocked 且动作是去填，不是去测', noKey.state === 'blocked' && noKey.action === 'open-engine', noKey.evidence)

  const untested = step(base({ provider: { ...base().provider, lastTest: null } }), 'provider')
  add('填了 key 没测过：pending + 真连一次', untested.state === 'pending' && untested.action === 'test-provider', untested.evidence)

  const stale = step(
    base({ provider: { ...base().provider, lastTest: { providerId: 'openai', model: 'gpt-4o-mini', ok: true, message: 'ok' } } }),
    'provider'
  )
  add('测试记录属于别的供应商：当作没测（换家了就要重测）', stale.state === 'pending' && stale.action === 'test-provider', stale.evidence)

  const failed = step(
    base({ provider: { ...base().provider, lastTest: { providerId: 'deepseek', model: 'deepseek-chat', ok: false, message: '401 无效 key' } } }),
    'provider'
  )
  add('真连失败：blocked 且证据就是失败原因', failed.state === 'blocked' && failed.evidence.includes('401'), failed.evidence)

  const okProvider = step(base(), 'provider')
  add('真连成功：证据带延迟（能核对的数字）', okProvider.state === 'ok' && okProvider.evidence.includes('640 ms'), okProvider.evidence)

  // ---- GSI 配置 ----
  const cfgOk = step(base(), 'gsi-config')
  add('cfg 写成功：证据就是那条路径', cfgOk.state === 'ok' && cfgOk.evidence.includes('gamestate_integration'), cfgOk.evidence)

  const cfgBad = step(base({ gsi: { ...base().gsi, configPath: null, configError: '没找到 Dota 2 安装目录' } }), 'gsi-config')
  add('cfg 写失败：blocked 且说清原因，不给假动作', cfgBad.state === 'blocked' && cfgBad.action === null && cfgBad.evidence.includes('没找到'), cfgBad.evidence)

  const cfgNever = step(base({ gsi: { ...base().gsi, configPath: null, configError: null } }), 'gsi-config')
  add('主进程还没试过写 cfg：unknown（不是「通过」）', cfgNever.state === 'unknown', cfgNever.evidence)

  // ---- 游戏连上：唯一不能离线伪造的一步 ----
  const noFrame = step(base({ gsi: { ...base().gsi, lastAt: null } }), 'gsi-frames')
  add('从没收到帧：pending，且证据里必须出现「重启游戏」', noFrame.state === 'pending' && noFrame.evidence.includes('重启游戏'), noFrame.evidence)

  const coldFrame = step(base({ gsi: { ...base().gsi, lastAt: NOW - 300_000 } }), 'gsi-frames')
  add('5 分钟前的帧：仍算没连上（游戏已退）', coldFrame.state === 'pending' && coldFrame.evidence.includes('5 分钟前'), coldFrame.evidence)

  const freshFrame = step(base(), 'gsi-frames')
  add('4 秒前的帧：ok，证据带对局状态与秒数', freshFrame.state === 'ok' && freshFrame.evidence.includes('GAME_IN_PROGRESS') && freshFrame.evidence.includes('4 秒前'), freshFrame.evidence)

  // ---- 识别模型 ----
  const notReady = step(base({ asr: { ...base().asr, ready: false } }), 'asr-model')
  add('模型没下：pending + 现在下，并给出体积', notReady.state === 'pending' && notReady.action === 'download-asr' && notReady.evidence.includes('MB'), notReady.evidence)

  const downloading = step(base({ asr: { ...base().asr, ready: false, downloading: true, progress: 0.42 } }), 'asr-model')
  add('下载中：pending 且不给按钮（点了也是同一个单飞闸门）', downloading.state === 'pending' && downloading.action === null, downloading.evidence)

  const dlError = step(base({ asr: { ...base().asr, ready: false, error: 'sha256 校验失败' } }), 'asr-model')
  add('下载失败：blocked + 重试', dlError.state === 'blocked' && dlError.action === 'download-asr', dlError.evidence)

  const manualOnly = step(base({ asr: { ...base().asr, ready: false, expectedBytes: null } }), 'asr-model')
  add('没有下载清单的引擎：blocked + 看目录（不假装能下）', manualOnly.state === 'blocked' && manualOnly.action === 'open-asr', manualOnly.evidence)

  const ready = step(base(), 'asr-model')
  add('模型就绪：证据是目录', ready.state === 'ok' && ready.evidence.endsWith('paraformer'), ready.evidence)

  // ---- 热键 ----
  const oneRejected = step(base({ hotkeys: { rejected: [{ label: '语音对讲', display: 'Alt+Shift+V' }], total: 8 } }), 'hotkeys')
  add('一个键被占：blocked，证据点名是哪个键', oneRejected.state === 'blocked' && oneRejected.evidence.includes('Alt+Shift+V'), oneRejected.evidence)

  const twoRejected = step(
    base({
      hotkeys: {
        rejected: [
          { label: '原地发送', display: 'Alt+Shift+T' },
          { label: '语音对讲', display: 'Alt+Shift+V' }
        ],
        total: 8
      }
    }),
    'hotkeys'
  )
  add('多个键被占：只报第一个，并说还有几个', twoRejected.evidence.includes('Alt+Shift+T') && twoRejected.evidence.includes('等 2 个'), twoRejected.evidence)

  const allHotkeys = step(base(), 'hotkeys')
  add('热键全注册上：ok 且报总数', allHotkeys.state === 'ok' && allHotkeys.evidence.includes('8'), allHotkeys.evidence)

  // ---- 数据目录 ----
  const noDir = step(base({ dataDir: null }), 'data-dir')
  add('数据目录不可写：unknown，且不计入「还差几处」', noDir.state === 'unknown' && judgeFirstRun(base({ dataDir: null })).open === 0, noDir.evidence)

  // ---- 汇总口径 ----
  const allGreen = judgeFirstRun(base())
  add('六步全绿：open === 0、done === 6', allGreen.open === 0 && allGreen.done === 6, JSON.stringify({ done: allGreen.done, open: allGreen.open }))

  const empty = judgeFirstRun(
    base({
      provider: { id: 'deepseek', model: 'deepseek-chat', hasKey: false, lastTest: null },
      gsi: { configPath: null, configError: null, lastAt: null, gameState: null },
      asr: { ready: false, downloading: false, progress: 0, error: null, dir: 'C:\\data\\asr-models\\paraformer', expectedBytes: 227_405_559 },
      dataDir: null
    })
  )
  // 空数据目录这一屏只看数量：热键是唯一不需要用户动手就绿的（新机器上没人抢），
  // 数据目录与 GSI 配置此时是 unknown，不该被算成「还差几处」。
  add(
    '空数据目录：1 步有证据（只有热键）、3 处待办',
    empty.done === 1 && empty.open === 3,
    JSON.stringify({ done: empty.done, open: empty.open, states: empty.steps.map((item) => `${item.id}=${item.state}`).join(' ') })
  )

  const failedChecks = checks.filter((item) => !item.ok)
  console.log(
    'FIRST_RUN_PROBE',
    JSON.stringify({ ok: failedChecks.length === 0, passed: checks.length - failedChecks.length, failed: failedChecks.length })
  )
  for (const item of checks) {
    console.log(`  ${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.detail ? `  (${item.detail})` : ''}`)
  }
  exitProbe(failedChecks.length === 0)
}
