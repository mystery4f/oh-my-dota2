/**
 * 补丁巡检的采样与落盘（#131）：帧进来时只做加法，判断与写日志在窗口满了才做一次。
 *
 * 为什么不每帧判一次：一次判断要遍历声明的路径表 × 词表，一局 20 分钟是几万帧，
 * 每帧判就是把 CPU 花在「什么都没变」上。所以这里只累计三个集合，窗口到点再判。
 *
 * 「健康安装什么都不写」靠 seen 文件：记过的缺口有稳定键（kind:name），
 * 第二局同样的内容不再写 jsonl，面板上那一行也只留还没记过的。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GLOSSARY, type GlossaryEntry } from '@shared/dota-glossary'
import {
  PATCH_WATCH_MIN_FRAMES,
  collectFramePaths,
  judgePatchWatch,
  patchGapKey,
  patchWatchLine,
  patchWatchRecord,
  unseenGaps,
  type PatchGap,
  type PatchWatchView
} from '@shared/patch-watch'
import { appendCappedJsonl } from './logs/jsonl'
import { logsDir } from './logs/base-dir'

const PATCH_WATCH_MAX_BYTES = 256 * 1024
/** 窗口满了之后，再采这么多帧判一次（不写重复的，只发现新的）。 */
const PATCH_WATCH_RECHECK_FRAMES = 300
const SEEN_KEEP = 400

interface PatchWatchState {
  paths: Set<string>
  heroes: Set<string>
  eventTypes: Set<string>
  frames: number
  seen: Set<string>
  unread: PatchGap[]
  at: string | null
  nextCheck: number
}

const state: PatchWatchState = {
  paths: new Set(),
  heroes: new Set(),
  eventTypes: new Set(),
  frames: 0,
  seen: new Set(),
  unread: [],
  at: null,
  nextCheck: PATCH_WATCH_MIN_FRAMES
}

function seenPath(): string {
  return join(logsDir(), 'patch-watch-seen.json')
}

function recordPath(): string {
  return join(logsDir(), 'patch-watch.jsonl')
}

/** 读已经记过的缺口键；坏文件当空表（宁可重报一次，也不因为一个坏文件放弃巡检）。 */
function loadSeen(): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(seenPath(), 'utf8')) as unknown
    const list = Array.isArray(raw) ? raw : []
    return new Set(list.filter((item): item is string => typeof item === 'string'))
  } catch {
    return new Set()
  }
}

function saveSeen(seen: Set<string>): void {
  try {
    writeFileSync(seenPath(), JSON.stringify([...seen].slice(-SEEN_KEEP), null, 0))
  } catch {
    // 记不住就重报一次，不值得让巡检把游戏链路带崩。
  }
}

/** 词表里的英雄展示名：词表换包之后这里读到的就是新表。 */
function glossaryHeroNames(): string[] {
  return (GLOSSARY as GlossaryEntry[]).filter((entry) => entry.kind === 'hero').map((entry) => entry.en)
}

function heroIdOf(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/^npc_dota_hero_/, '') : ''
}

/**
 * 一帧进账。只做集合加法 + 帧计数，到窗口点才判一次并落盘。
 *
 * payload 的键我们只取三处：英雄（allplayers / hero）、事件类型（events）、路径（整帧结构）。
 */
export function noteFrame(payload: unknown): void {
  if (payload === null || typeof payload !== 'object') return
  const frame = payload as {
    allplayers?: Record<string, { hero?: string }>
    hero?: { name?: string }
    events?: Array<{ event_type?: string }>
  }
  for (const path of collectFramePaths(frame)) state.paths.add(path)
  for (const info of Object.values(frame.allplayers ?? {})) {
    const hero = heroIdOf(info?.hero)
    if (hero.length > 0) state.heroes.add(hero)
  }
  const own = heroIdOf(frame.hero?.name)
  if (own.length > 0) state.heroes.add(own)
  for (const event of frame.events ?? []) {
    if (typeof event?.event_type === 'string' && event.event_type.length > 0) state.eventTypes.add(event.event_type)
  }
  state.frames += 1
  if (state.frames >= state.nextCheck) {
    state.nextCheck = state.frames + PATCH_WATCH_RECHECK_FRAMES
    flushPatchWatch()
  }
}

/**
 * 判一次并落盘。返回这次新记下的缺口（调用方只在探针里用得到）。
 *
 * 只有没记过的缺口才写 jsonl：同一局的重复帧、下一局的同一批英雄，都不会再写一行。
 */
export function flushPatchWatch(): PatchGap[] {
  const sample = {
    paths: [...state.paths],
    heroes: [...state.heroes],
    eventTypes: [...state.eventTypes],
    frames: state.frames
  }
  const gaps = judgePatchWatch(sample, glossaryHeroNames())
  const fresh = unseenGaps(gaps, state.seen)
  state.at = new Date().toISOString()
  if (fresh.length > 0) {
    appendCappedJsonl(recordPath(), patchWatchRecord(fresh, state.frames, state.at), PATCH_WATCH_MAX_BYTES)
    for (const gap of fresh) state.seen.add(patchGapKey(gap))
    saveSeen(state.seen)
    console.log('PATCH_WATCH ' + patchWatchLine(fresh))
  }
  // 面板那一行只留「还没记过的」：记过的东西不该一直亮在面板上。
  state.unread = unseenGaps(gaps, state.seen)
  return fresh
}

export function patchWatchView(): PatchWatchView {
  return {
    frames: state.frames,
    gaps: state.unread.length,
    line: state.unread.length > 0 ? patchWatchLine(state.unread) : null,
    at: state.at
  }
}

/** 启动时读一次 seen：面板从第一帧起就不会重复报上一局记过的东西。 */
export function startPatchWatch(): void {
  state.seen = loadSeen()
}

/** 探针用：把累计状态清空（seen 也一起，测试之间互不影响）。 */
export function resetPatchWatchForProbe(): void {
  state.paths.clear()
  state.heroes.clear()
  state.eventTypes.clear()
  state.frames = 0
  state.seen = new Set()
  state.unread = []
  state.at = null
  state.nextCheck = PATCH_WATCH_MIN_FRAMES
}

/** 探针用：把 seen 换成给定集合，模拟「上一局已经记过」。 */
export function setPatchWatchSeenForProbe(keys: Iterable<string>): void {
  state.seen = new Set(keys)
}

export function patchWatchPathsForProbe(): { record: string; seen: string } {
  return { record: recordPath(), seen: seenPath() }
}