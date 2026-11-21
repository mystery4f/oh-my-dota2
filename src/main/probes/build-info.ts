/**
 * 构建新鲜度探针（票 113）：不碰网络、不跑构建，只钉「看到的时间」与「判定」对不对。
 *
 * 锁四件：
 * - 读不到产物时说「读不到」，不说「最新」——假绿比红更贵；
 * - 打包版没有源码可比时只报时间，不编一个「不旧」；
 * - 源码比产物新超过宽限才判旧，差几毫秒不许天天喊狼来了；
 * - 真机自检：在开发环境里读到的产物 mtime 必须是个真实时间戳（读成 null 说明这个包根本读不到自己）。
 */
import { BUILD_STALE_SLACK_MS, buildInfoOf, formatSpan, judgeBuildFreshness } from '@shared/build-info'
import { readBuildInfo } from '../services/build-info'
import { finishProbe, probeCases } from './harness'

const T = 1_763_000_000_000

export async function runBuildInfoProbe(): Promise<void> {
  const { cases, push: check } = probeCases()

  // —— 读不到产物：说实话，别假绿
  const noArtifact = judgeBuildFreshness({ stampMs: null, bytes: null, newestMainMs: T, newestRendererMs: T })
  check('读不到产物时不算旧', noArtifact.stale === false)
  check('读不到产物时说「读不到」而不是「最新」', noArtifact.note.includes('读不到'))

  // —— 打包版：没有源码可比
  const packaged = judgeBuildFreshness({ stampMs: T, bytes: 1024, newestMainMs: null, newestRendererMs: null })
  check('打包版不判旧', packaged.stale === false)
  check('打包版明说只能报时间', packaged.note.includes('打包版') && packaged.note.includes('构建时间'))

  // —— 宽限之内不算旧
  const almost = judgeBuildFreshness({
    stampMs: T,
    bytes: 1024,
    newestMainMs: T + BUILD_STALE_SLACK_MS - 1,
    newestRendererMs: T
  })
  check('源码只新一点点不算旧（宽限内）', almost.stale === false && almost.behindMs === null)
  const equal = judgeBuildFreshness({ stampMs: T, bytes: 1024, newestMainMs: T, newestRendererMs: T })
  check('同一时刻不算旧', equal.stale === false)

  // —— 超过宽限就是旧，且说清差多少、下一步做什么
  const stale = judgeBuildFreshness({ stampMs: T, bytes: 1024, newestMainMs: T + 540_000, newestRendererMs: T })
  check('源码新 9 分 -> 判旧', stale.stale === true)
  check('旧的时候给出落后的时长', stale.behindMs === 540_000)
  check('旧的时候说清怎么修', stale.note.includes('dev:restart'))
  check('旧的时候带上时长', stale.note.includes('9 分'))
  check('不旧的时候不提 dev:restart', !equal.note.includes('dev:restart'))

  // —— #147：只有渲染层动过，不算旧代码，也不该喊重启
  const rendererOnly = judgeBuildFreshness({ stampMs: T, bytes: 1024, newestMainMs: T, newestRendererMs: T + 260_000 })
  check('只改渲染层不判旧', rendererOnly.stale === false && rendererOnly.behindMs === null)
  check('只改渲染层说清「已热更新」而不是「没生效」', rendererOnly.note.includes('热更新') && !rendererOnly.note.includes('没生效'))
  check('只改渲染层不喊 dev:restart', !rendererOnly.note.includes('dev:restart'))
  check('只改渲染层标 scope=renderer', rendererOnly.scope === 'renderer')
  const bothNewer = judgeBuildFreshness({ stampMs: T, bytes: 1024, newestMainMs: T + 60_000, newestRendererMs: T + 900_000 })
  check('两组都新时以主进程为准（主进程更旧才是真的旧代码）', bothNewer.stale === true && bothNewer.scope === 'main')
  const rendererOnlyPackaged = judgeBuildFreshness({ stampMs: T, bytes: 1024, newestMainMs: null, newestRendererMs: T + 900_000 })
  check(
    '主进程没有源码可比、渲染层有：不判旧，但渲染层那句照说',
    rendererOnlyPackaged.stale === false && rendererOnlyPackaged.scope === 'renderer'
  )

  // —— 时长文案：只求看得出量级
  check('毫秒量级', formatSpan(320).includes('毫秒'))
  check('秒量级', formatSpan(4_200).includes('秒'))
  check('分量级', formatSpan(600_000).includes('分'))
  check('小时量级', formatSpan(7_200_000).includes('小时'))
  check('天量级', formatSpan(3 * 86_400_000).includes('天'))

  // —— 合成：面板一次 invoke 拿到的一切
  const view = buildInfoOf({ stampMs: T, bytes: 2048, newestMainMs: T + 60_000, newestRendererMs: T })
  check('面板视图带 stale / note / behindMs / scope', view.stale && view.note.includes('没生效') && view.behindMs === 60_000 && view.scope === 'main')

  // —— 真机自检：读到的产物时间必须是真的
  const real = readBuildInfo()
  check('开发环境读得到产物 mtime', typeof real.stampMs === 'number' && real.stampMs > 0, String(real.stampMs))
  check(
    '开发环境读得到两组源码的最新时间',
    typeof real.newestMainMs === 'number' && real.newestMainMs > 0 && typeof real.newestRendererMs === 'number' && real.newestRendererMs > 0
  )
  check(
    '真机判定与事实一致（detail 是真机给出的那句话）',
    real.stale === judgeBuildFreshness(real).stale && real.scope === judgeBuildFreshness(real).scope,
    real.note
  )

  finishProbe('BUILD_INFO_PROBE', cases)
}
