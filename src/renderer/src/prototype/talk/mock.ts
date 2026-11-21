/**
 * 一次性原型数据（对讲页三方案共用）。
 *
 * 这里是**原型代码**，不是产品代码：数据全在内存里，没有持久化、没有 IPC、没有错误处理。
 * 目的只有一个——把「对讲页该长什么样」这个问题摆到眼前，选完就把整个目录删掉。
 */

export type StepState = 'ready' | 'warn' | 'bad'

export interface Step {
  key: string
  name: string
  /** 一句话证据：为什么是这个状态，用户能核对 */
  detail: string
  state: StepState
  /** 断了的那一步该怎么修；就绪时为空 */
  fix?: string
}

export interface Entry {
  at: string
  transcript: string
  translated: string
  spoken: boolean
  firstAudioMs: number
  totalMs: number
}

export type VariantKey = 'A' | 'B' | 'C' | 'D'

const OK: Step[] = [
  { key: 'mic', name: '麦克风', detail: '麦克风阵列 · 电平正常', state: 'ready' },
  { key: 'asr', name: '识别', detail: 'Qwen3-ASR-0.6B · 799 MB', state: 'ready' },
  { key: 'mt', name: '翻译', detail: 'DeepSeek · 上次 412 ms', state: 'ready' },
  { key: 'tts', name: '声出', detail: 'Edge Jenny · CABLE Input 已接', state: 'ready' }
]

const BROKEN: Step[] = [
  { key: 'mic', name: '麦克风', detail: '麦克风阵列 · 电平正常', state: 'ready' },
  { key: 'asr', name: '识别', detail: 'Qwen3-ASR-0.6B · 799 MB', state: 'ready' },
  {
    key: 'mt',
    name: '翻译',
    detail: '上次请求超时（api.deepseek.com）',
    state: 'bad',
    fix: '换引擎'
  },
  {
    key: 'tts',
    name: '声出',
    detail: '没找到 CABLE Input，游戏里听不到',
    state: 'bad',
    fix: '装 VB-Cable'
  }
]

export const ENTRIES: Entry[] = [
  {
    at: '18:42',
    transcript: '对面猴子跳刀了，小心',
    translated: 'Their Monkey King has Blink, careful',
    spoken: true,
    firstAudioMs: 780,
    totalMs: 1620
  },
  {
    at: '18:39',
    transcript: '我先出个跳刀',
    translated: "I'll go Blink first",
    spoken: true,
    firstAudioMs: 910,
    totalMs: 1840
  },
  {
    at: '18:35',
    transcript: '他们打肉山了',
    translated: 'They are doing Roshan',
    spoken: false,
    firstAudioMs: 1200,
    totalMs: 2260
  }
]

/** 热词表满（49/50）+ 三个待定候选，正是这一页最占地方、最少改动的东西。 */
export const HOTWORD_COUNT = 49
export const HOTWORD_LIMIT = 50
export const CANDIDATES = [
  { word: '肉山', count: 4 },
  { word: '马尔斯', count: 2 },
  { word: '跳刀', count: 1 }
]

export function stepsFor(broken: boolean): Step[] {
  return broken ? BROKEN : OK
}

export function readVariant(search: string): VariantKey {
  const raw = new URLSearchParams(search).get('variant')
  if (raw === 'B' || raw === 'b') return 'B'
  if (raw === 'C' || raw === 'c') return 'C'
  if (raw === 'D' || raw === 'd') return 'D'
  return 'A'
}

export function readBroken(search: string): boolean {
  return new URLSearchParams(search).get('broken') === '1'
}

export function variantUrl(variant: VariantKey, broken: boolean): string {
  const url = new URL(window.location.href)
  url.searchParams.set('variant', variant)
  if (broken) url.searchParams.set('broken', '1')
  else url.searchParams.delete('broken')
  return `${url.pathname}${url.search}`
}
