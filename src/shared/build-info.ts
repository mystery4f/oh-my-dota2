/**
 * 构建新鲜度（票 113，票 147 修正比较对象）：把「改的代码没生效」这句话变成面板上一行。
 *
 * 为什么只做显示不做检测：检测本来就存在——主进程每次启动打印 `BUILD_STAMP`（`out/main/index.js`
 * 的 mtime）。真正贵的是**没人看见**：改了源码、watcher 没重建、跑起来还是旧行为，于是人开始
 * debug 一个不存在的 bug。所以这里只做两件事：把构建时间摆到面板上，以及在源码比产物新时明说一句。
 *
 * 为什么分主进程和渲染层两组事实（#147）：`out/main/index.js` 是主进程 + preload 的产物，
 * `src/renderer/**` 从来不会进这个文件——开发模式下它由 vite 直接服务、保存即热更新。拿渲染层的
 * mtime 去和主进程产物比，会把「面板改了一个字」报成「跑的是旧代码，重跑 dev:restart」，
 * 于是做 UI 的人天天顶着一个永远清不掉的琥珀色徽标。两组分开比，两句话分开说，因为修法不同。
 *
 * 为什么给 2 秒宽限：`npm run build` 写完产物后源码 mtime 不会动，反过来的抖动（编辑器保存、
 * git checkout 的 mtime 刷新）却是常事——差几毫秒就报「没生效」等于天天狼来了。
 */

/** 源码比产物新多少才算「没生效」。2 秒：够盖住编辑器保存与 checkout 的时间抖动。 */
export const BUILD_STALE_SLACK_MS = 2000

export interface BuildFacts {
  /** 构建产物（`out/main/index.js`）的 mtime；读不到为 null。 */
  stampMs: number | null
  /** 产物字节数，只为在面板上说清「你看的是哪一个包」；读不到为 null。 */
  bytes: number | null
  /** 主进程产物的输入（`src/main` + `src/preload` + `src/shared`）里最新的 mtime；打包版为 null。 */
  newestMainMs: number | null
  /** 渲染层（`src/renderer`）里最新的 mtime；打包版为 null。 */
  newestRendererMs: number | null
}

/** 谁比产物新：`main` = 真的跑旧代码；`renderer` = 只有界面改动，开发模式下已经生效。 */
export type BuildScope = 'main' | 'renderer'

export interface BuildVerdict {
  /** true = 主进程源码比产物新，跑的是旧代码。渲染层改动不算 stale。 */
  stale: boolean
  /** `main` / `renderer` / null（最新，或没法比）。 */
  scope: BuildScope | null
  /** 人话：面板那一行直接显示它。 */
  note: string
  /** 主进程源码比产物新多少（毫秒）；不新鲜或没有源码可比时为 null。 */
  behindMs: number | null
}

/** 多久：`1.2 秒` / `3 分` / `2 小时`，只求看得出量级。 */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return `${Math.max(0, Math.round(ms))} 毫秒`
  const seconds = ms / 1000
  if (seconds < 90) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`
  const minutes = seconds / 60
  if (minutes < 90) return `${Math.round(minutes)} 分`
  const hours = minutes / 60
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} 小时`
  return `${Math.round(hours / 24)} 天`
}

/**
 * 判一条构建是不是旧的。四种情况各自有话可说，绝不笼统说「未知」：
 * 读不到产物 → 说读不到；没有源码（打包版）→ 说只能报时间；主进程源码更新 → 说没生效并给出办法；
 * 只有渲染层更新 → 说这一层已经生效了，别喊重启。
 */
export function judgeBuildFreshness(facts: BuildFacts, slackMs: number = BUILD_STALE_SLACK_MS): BuildVerdict {
  const { stampMs, newestMainMs, newestRendererMs } = facts
  if (stampMs === null) {
    return { stale: false, scope: null, note: '构建时间读不到：可能是打包版，或 out/ 被清过', behindMs: null }
  }
  if (newestMainMs === null && newestRendererMs === null) {
    return { stale: false, scope: null, note: '打包版没有源码可比，这里只报构建时间', behindMs: null }
  }
  const behindMs = newestMainMs === null ? null : newestMainMs - stampMs
  if (behindMs !== null && behindMs > slackMs) {
    return {
      stale: true,
      scope: 'main',
      note: `改的代码没生效：主进程源码比构建产物新 ${formatSpan(behindMs)}，重跑 npm run dev:restart`,
      behindMs
    }
  }
  const rendererBehind = newestRendererMs === null ? null : newestRendererMs - stampMs
  if (rendererBehind !== null && rendererBehind > slackMs) {
    return {
      stale: false,
      scope: 'renderer',
      note: '渲染层有改动：开发模式下已经热更新，打包版才需要重新 npm run build',
      behindMs: null
    }
  }
  return { stale: false, scope: null, note: '构建产物是最新的', behindMs: null }
}

/** 面板直读的那一份：事实 + 判断结果，一次 invoke 拿全。 */
export interface BuildInfo extends BuildFacts {
  stale: boolean
  scope: BuildScope | null
  note: string
  behindMs: number | null
}

/** 事实 -> 面板那一行要的一切（判断只有一处，别在调用方再判一遍）。 */
export function buildInfoOf(facts: BuildFacts, slackMs?: number): BuildInfo {
  const verdict = judgeBuildFreshness(facts, slackMs)
  return { ...facts, stale: verdict.stale, scope: verdict.scope, note: verdict.note, behindMs: verdict.behindMs }
}
