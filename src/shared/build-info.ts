/**
 * 构建新鲜度（票 113）：把「改的代码没生效」这句话变成面板上一行。
 *
 * 为什么只做显示不做检测：检测本来就存在——主进程每次启动打印 `BUILD_STAMP`（`out/main/index.js`
 * 的 mtime）。真正贵的是**没人看见**：改了源码、watcher 没重建、跑起来还是旧行为，于是人开始
 * debug 一个不存在的 bug。所以这里只做两件事：把构建时间摆到面板上，以及在源码比产物新时明说一句。
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
  /** `src/` 下最新的文件 mtime；打包版没有源码，为 null。 */
  newestSourceMs: number | null
}

export interface BuildVerdict {
  /** true = 源码比产物新，跑的是旧代码。 */
  stale: boolean
  /** 人话：面板那一行直接显示它。 */
  note: string
  /** 源码比产物新多少（毫秒）；不新鲜或没有源码可比时为 null。 */
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
 * 判一条构建是不是旧的。三种情况各自有话可说，绝不笼统说「未知」：
 * 读不到产物 → 说读不到；没有源码（打包版）→ 说只能报时间；有源码 → 比出来。
 */
export function judgeBuildFreshness(facts: BuildFacts, slackMs: number = BUILD_STALE_SLACK_MS): BuildVerdict {
  const { stampMs, newestSourceMs } = facts
  if (stampMs === null) {
    return { stale: false, note: '构建时间读不到：可能是打包版，或 out/ 被清过', behindMs: null }
  }
  if (newestSourceMs === null) {
    return { stale: false, note: '打包版没有源码可比，这里只报构建时间', behindMs: null }
  }
  const behindMs = newestSourceMs - stampMs
  if (behindMs > slackMs) {
    return {
      stale: true,
      note: `改的代码没生效：源码比构建产物新 ${formatSpan(behindMs)}，重跑 npm run dev:restart`,
      behindMs
    }
  }
  return { stale: false, note: '构建产物是最新的', behindMs: null }
}

/** 面板直读的那一份：事实 + 判断结果，一次 invoke 拿全。 */
export interface BuildInfo extends BuildFacts {
  stale: boolean
  note: string
  behindMs: number | null
}

/** 事实 -> 面板那一行要的一切（判断只有一处，别在调用方再判一遍）。 */
export function buildInfoOf(facts: BuildFacts, slackMs?: number): BuildInfo {
  const verdict = judgeBuildFreshness(facts, slackMs)
  return { ...facts, stale: verdict.stale, note: verdict.note, behindMs: verdict.behindMs }
}
