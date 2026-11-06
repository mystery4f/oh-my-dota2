import { app } from 'electron'
import { errorMessage } from '@shared/errors'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord'
import type { EntryId } from '@earendil-works/pi-durable'
import type {
  Conversation,
  ConversationId,
  Harness,
  SettledSubmissionRecord
} from '@earendil-works/pi-durable'
import type { ProviderConfig, ReplyTone, TranslateDirection } from '@shared/ipc'
import { thinkingCompatFor, thinkingLevelFor } from '@shared/provider-reasoning'
import { ensureTerminalPunct, latinTokenViolations } from '@shared/translate-fidelity'
import { loadSettings } from '../settings'
import {
  DEFAULT_MAX_WORDS,
  buildSystemPrompt,
  maxWordsFromSettings,
  clampReply,
  looksLikeCommentary,
  replyWithinLimits,
  sanitizeTranslation,
  shortenReply,
  translateText
} from '../providers'
import {
  clearTranslationPairs,
  lookupTranslation,
  readTranslation,
  translationCachePairsFor,
  writeTranslation,
  type TranslationOrigin
} from './translate-cache'

/** Longest block sent to the model in one submission; longer ticks are split. */
const BLOCK_LIMIT = 8
/** A reasoning model can spend several seconds per answer; anything past this is a stall. */
const SUBMIT_TIMEOUT_MS = 45_000
/** 冷启动（新会话/新提示词缓存）首轮明显更慢：给足时间，别让第一句话就掉进直连回退。 */
const COLD_SUBMIT_TIMEOUT_MS = 120_000
/** After a session failure, direct translation stays in charge for this long. */
const RETRY_AFTER_MS = 30_000
/**
 * 被打断（用户又按了一次热键）不是失败：不进 30 秒失败冷却、不写记账本、不触发直连兜底。
 * 用一句话当标记，调用方据此决定「原文还要不要放回去」。
 */
const TURN_CANCELLED = 'translation cancelled'
/** 捕获轮询的熔断线：一轮批量超过这个时间，聊天已经刷过去了，留在会话里等没意义。 */
const CAPTURE_WARM_TIMEOUT_MS = 12_000
/** 冷启动首轮模型要建缓存，允许更久；但超过一轮聊天的时间就没有意义了，直连兜底反而更快。 */
const CAPTURE_COLD_TIMEOUT_MS = 15_000
/** Turns kept in a conversation before it is reset: an old bad answer otherwise teaches the model to repeat it. */
const TURNS_PER_CONVERSATION = 8
const SESSION_DIRECTIONS: TranslateDirection[] = ['auto-zh', 'zh-en']
/** 面板「翻译试用」用的方向，历史隔离在 try# 槽位。 */
const TRY_DIRECTIONS: TranslateDirection[] = ['en-zh', 'zh-en']

/** zh-en 按语气各用一条会话：语气写在系统指令里，混在一条会话会被上一轮语气带跑。 */
/** 会话槽：语气各自一条会话；试用的示例句走 try# 前缀的独立会话，绝不污染生产历史。 */
function sessionSlot(
  direction: TranslateDirection,
  tone: ReplyTone = 'terse',
  scope: TranslateScope = 'prod'
): string {
  const slot = direction === 'zh-en' ? 'zh-en#' + tone : direction
  if (scope === 'try') return 'try#' + slot
  // 预热回合单独一条会话：它慢或失败绝不能堵住用户真正要发的那一句。
  if (scope === 'warm') return 'warm#' + slot
  return slot
}
export type TranslateScope = 'prod' | 'try' | 'warm'
const NUMBERED_CONTRACT_NOTE = [
  '',
  'When the user message contains numbered lines like "1| text", each numbered line is one independent chat line: reply with the same numbering and exactly one translation per line, in the same order, e.g. "1| 译文".',
  'Never merge, split, drop, reorder, or add lines.'
].join('\n')

interface SessionRuntime {
  key: string
  /** key + 推理开关 + 词数上限：只决定运行时模型对象，不该像 key 那样拆开历史文件。 */
  configKey: string
  /** 会话的思考档位（面板「推理」开关的产物），复用旧会话时也要重新配置。 */
  thinkingLevel: 'off' | 'medium'
  harness: Harness
  context: Context
  conversations: Map<string, Conversation>
  statePath: string
  modelId: string
  /** 会话指令里的 zh-en 词数上限（设置快照），建会话与重建运行时都要带上。 */
  maxWords: number
}

export type LatencySource = 'session' | 'direct' | 'timeout' | 'error'

export interface LatencySample {
  at: number
  ms: number
  source: LatencySource
  lines: number
}

/** 翻译抖动统计：服务端首字节能从 1.3s 抖到 31s，只看单次没用，必须看分位数。 */
export interface LatencySummary {
  count: number
  p50: number | null
  p90: number | null
  max: number | null
  session: number
  direct: number
  timeout: number
  error: number
  lastSource: LatencySource | null
  lastMs: number | null
}

export interface SessionStatus {
  active: boolean
  model: string | null
  conversations: string[]
  lastFallback: string | null
  /** Last raw model output of a numbered block, kept for diagnosing parse misses. */
  lastRaw: string | null
  latency: LatencySummary
}

const LATENCY_WINDOW = 60
const latencySamples: LatencySample[] = []

function trackLatency(ms: number, source: LatencySource, lines: number): void {
  latencySamples.push({ at: Date.now(), ms: Math.round(ms), source, lines })
  if (latencySamples.length > LATENCY_WINDOW) latencySamples.splice(0, latencySamples.length - LATENCY_WINDOW)
}

export function latencySummary(): LatencySummary {
  const times = latencySamples.map((sample) => sample.ms).sort((a, b) => a - b)
  const pick = (ratio: number): number | null =>
    times.length === 0 ? null : times[Math.min(times.length - 1, Math.floor(times.length * ratio))]
  const count = (source: LatencySource): number => latencySamples.filter((sample) => sample.source === source).length
  const last = latencySamples[latencySamples.length - 1]
  return {
    count: latencySamples.length,
    p50: pick(0.5),
    p90: pick(0.9),
    max: times.length > 0 ? times[times.length - 1] : null,
    session: count('session'),
    direct: count('direct'),
    timeout: count('timeout'),
    error: count('error'),
    lastSource: last?.source ?? null,
    lastMs: last?.ms ?? null
  }
}

let runtime: SessionRuntime | null = null
let opening: Promise<SessionRuntime> | null = null
let lastFallback: string | null = null
let failedAt = 0
let failedReason: string | null = null
let lastRaw: string | null = null
const turns = new Map<string, number>()

function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8)
}

export function providerKey(provider: ProviderConfig): string {
  return [provider.id, provider.baseUrl, provider.model, provider.authStyle ?? 'bearer', provider.apiKey.length].join('|')
}

/**
 * 运行时身份：换 provider、换推理档位或换词数上限都要重建模型对象（指令变了），
 * 但共用同一份会话历史（providerKey 不含档位），否则切一下开关就把 few-shot 历史丢了。
 */
function runtimeConfigKey(provider: ProviderConfig, maxWords: number): string {
  return providerKey(provider) + '|' + thinkingLevelFor(provider) + '|' + maxWords
}


/**
 * 会话库按 provider 分文件：换模型/换端点（包括探针里的假 provider）各自一份历史，
 * 否则别人的 few-shot 会混进你的译文，反过来也一样。
 */
export function sessionPaths(provider: ProviderConfig): { dir: string; db: string; state: string } {
  const dir = join(app.getPath('userData'), 'sessions')
  const suffix = providerKey(provider).length === 0 ? '' : '-' + shortHash(providerKey(provider))
  return {
    dir,
    db: join(dir, 'translator' + suffix + '.sqlite'),
    state: join(dir, 'conversations' + suffix + '.json')
  }
}

function readState(path: string): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(raw))
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    return out
  } catch {
    return {}
  }
}

function writeState(path: string, value: Record<string, number>): void {
  try {
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
  } catch {
    // A missing state file only costs a fresh conversation; never fail translation over it.
  }
}

/** 会话系统指令 = 方向提示词（短格式 + 示例）+ 编号契约；静态，会话按会话配置指令，不按行。 */
export function instructionsFor(
  direction: TranslateDirection,
  tone: ReplyTone = 'terse',
  maxWords = DEFAULT_MAX_WORDS
): string {
  return buildSystemPrompt(direction, tone, maxWords) + NUMBERED_CONTRACT_NOTE
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = SUBMIT_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

function messageText(record: { model?: { content?: unknown }[] } | undefined): string {
  const messages = Array.isArray(record?.model) ? record.model : []
  const parts: string[] = []
  for (const message of messages) {
    const content = message?.content
    if (typeof content === 'string') parts.push(content)
    else if (Array.isArray(content))
      for (const block of content) {
        const typed = block as { type?: string; text?: string }
        if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
      }
  }
  return parts.join('\n').trim()
}

function numberedTranslations(output: string, count: number): string[] {
  const found = new Map<number, string>()
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d{1,2})\s*[|｜:：.)]\s*(.+)$/)
    if (!match) continue
    const index = Number(match[1])
    if (index < 1 || index > count || found.has(index)) continue
    const value = match[2].trim()
    if (value) found.set(index, value)
  }
  return Array.from({ length: count }, (_, i) => found.get(i + 1) ?? '')
}

async function openRuntime(provider: ProviderConfig, maxWords: number): Promise<SessionRuntime> {
  const durable = await import('@earendil-works/pi-durable')
  const { createModels, createProvider } = await import('@earendil-works/pi-ai/models')
  const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy')
  const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node')
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context')

  const paths = sessionPaths(provider)
  mkdirSync(paths.dir, { recursive: true })

  const baseUrl = provider.baseUrl.replace(/\/+$/, '')
  const apiKey = provider.apiKey || 'unused'
  const headers: Record<string, string> = provider.authStyle === 'api-key' ? { 'api-key': apiKey } : {}
  const model = {
    id: provider.model,
    name: provider.model,
    api: 'openai-completions',
    provider: 'app',
    baseUrl,
    input: ['text'] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 128_000,
    // 推理模型会先花掉一大截预算，留 2048 才不会把译文截成半句。
    maxTokens: 2048,
    // 各家「先思考」的开关不是一个字段（zai/deepseek 的 thinking.type、OpenAI 的 reasoning_effort）：
    // 方言与开关分两处：方言由 @shared/provider-reasoning 的 thinkingCompatFor 翻译，
    // 开关由会话的 thinkingLevel 决定（面板「推理」）。
    // thinkingLevel:'off' 时 pi-ai 把 reasoningEffort 置空，各家分支据此下发 disabled / 什么都不发。
    compat: thinkingCompatFor(provider.id),
    headers
  }

  const models = createModels()
  models.setProvider(
    createProvider({
      id: 'app',
      name: 'app',
      baseUrl,
      headers,
      auth: { apiKey: { name: 'app key', resolve: async () => ({ auth: { apiKey } }) } },
      models: [model as never],
      api: openAICompletionsApi()
    })
  )

  const storage = await openNodeSqliteStorage(paths.db)
  const harness = await durable.Harness.open(
    storage,
    { models, registry: durable.createRegistry(), settings: {} },
    BACKGROUND_CONTEXT
  )

  const session: SessionRuntime = {
    key: providerKey(provider),
    configKey: runtimeConfigKey(provider, maxWords),
    thinkingLevel: thinkingLevelFor(provider),
    harness,
    context: BACKGROUND_CONTEXT,
    conversations: new Map(),
    statePath: paths.state,
    modelId: provider.model,
    maxWords
  }
  // 先把两个方向的会话建好：提交过程中再建会话会让存储层撞上"对话忙"。
  // 试用的 try# 槽位一并预建，面板里点「翻译」时就不会撞上冷启动。
  const warmSlots: Array<[TranslateDirection, TranslateScope]> = [
    ...SESSION_DIRECTIONS.map((direction) => [direction, 'prod'] as [TranslateDirection, TranslateScope]),
    ...TRY_DIRECTIONS.map((direction) => [direction, 'try'] as [TranslateDirection, TranslateScope]),
    ...SESSION_DIRECTIONS.map((direction) => [direction, 'warm'] as [TranslateDirection, TranslateScope])
  ]
  for (const [direction, scope] of warmSlots) {
    await ensureConversation(session, direction, 'terse', scope).catch((err: unknown) => {
      noteFailure(errorMessage(err))
    })
  }
  return session
}

/**
 * 启动时预热：sqlite 建库、会话创建都挪到用户说话之前，
 * 再补一个最小回合，让流式连接与提示词缓存也热起来（首句原本要等 7-8 秒）。
 */
export async function warmTranslator(provider: ProviderConfig): Promise<void> {
  const session = await ensureRuntime(provider).catch(() => null)
  if (!session) return
  // 预热必须落在生产会话上，否则用户的第一句永远是冷启动（实测冷 2.7-5.2s / 热 0.6-1.7s）；
  // 预热回合本身被预算与超时中止兜住，不会像以前那样一直堵着后面的 submit。
  await translateWithSession(provider, '收到', 'zh-en', 'terse', 'prod', {
    warm: WARM_UP_TIMEOUT_MS,
    cold: WARM_UP_TIMEOUT_MS
  }).catch(() => undefined)
}

async function ensureRuntime(provider: ProviderConfig): Promise<SessionRuntime> {
  const maxWords = maxWordsFromSettings(loadSettings().translationMaxWords)
  const configKey = runtimeConfigKey(provider, maxWords)
  if (runtime && runtime.configKey === configKey) return runtime
  if (opening) {
    const pending = await opening
    if (pending.configKey === configKey) return pending
  }
  if (runtime) {
    await runtime.harness.close(runtime.context).catch(() => undefined)
    runtime = null
  }
  opening = openRuntime(provider, maxWords)
  try {
    runtime = await opening
    failedAt = 0
    failedReason = null
    return runtime
  } finally {
    opening = null
  }
}

async function ensureConversation(
  session: SessionRuntime,
  direction: TranslateDirection,
  tone: ReplyTone = 'terse',
  scope: TranslateScope = 'prod'
): Promise<Conversation> {
  const slot = sessionSlot(direction, tone, scope)
  const cached = session.conversations.get(slot)
  if (cached) return cached

  const state = readState(session.statePath)
  const storedId = state[slot]
  if (storedId) {
    try {
      const existing = await session.harness.conversation(storedId as ConversationId, session.context)
      if (!existing) throw new Error('conversation ' + storedId + ' is gone')
      await existing.configure(
        { instructions: instructionsFor(direction, tone, session.maxWords), thinkingLevel: session.thinkingLevel },
        session.context
      )
      session.conversations.set(slot, existing)
      return existing
    } catch {
      delete state[slot]
      writeState(session.statePath, state)
    }
  }

  const created = await session.harness.createConversation(
    {
      ownership: { kind: 'ownerless' },
      agent: {
        model: { provider: 'app', modelId: session.modelId },
        instructions: instructionsFor(direction, tone, session.maxWords),
        // 翻译默认不思考（面板「推理」可打开）：短句任务，思考 token 只加延迟。
        thinkingLevel: session.thinkingLevel
      }
    },
    session.context
  )
  state[slot] = created.id
  writeState(session.statePath, state)
  session.conversations.set(slot, created)
  return created
}

/** Drop the model-visible history so a bad answer cannot poison the next turn. */
async function resetHistory(
  direction: TranslateDirection,
  tone: ReplyTone = 'terse',
  scope: TranslateScope = 'prod'
): Promise<void> {
  const session = runtime
  if (!session) return
  const slot = sessionSlot(direction, tone, scope)
  const conversation = session.conversations.get(slot)
  turns.set(slot, 0)
  if (conversation) await conversation.reset(undefined, session.context).catch(() => undefined)
}

/**
 * One conversation is a shared mutable transcript: capture ticks and reply
 * translations submit into it concurrently. Serialise every turn so an answer
 * can always be attributed to its own submission.
 */
let turnTail: Promise<unknown> = Promise.resolve()

function withTurnLock<T>(work: () => Promise<T>): Promise<T> {
  const run = turnTail.then(work, work)
  turnTail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function translateWithSession(
  provider: ProviderConfig,
  text: string,
  direction: TranslateDirection,
  tone: ReplyTone = 'terse',
  scope: TranslateScope = 'prod',
  budgets: { warm: number; cold: number } = { warm: SUBMIT_TIMEOUT_MS, cold: COLD_SUBMIT_TIMEOUT_MS },
  gate: TurnGate = { origin: 'capture' }
): Promise<string> {
  return withTurnLock(async () => {
    // 排队期间用户可能已经又按了一次热键：拿到锁先看一眼，没人要的立刻放弃 ——
    // 提交一条没人读的回答不但白烧 token，还会把下一句堵在回合锁后面。
    const { guard } = gate
    if (guard && !guard()) throw new Error(TURN_CANCELLED)
    const startedAt = Date.now()
    const session = await ensureRuntime(provider)
    const slot = sessionSlot(direction, tone, scope)
    const conversation = await ensureConversation(session, direction, tone, scope)
    const cold = (turns.get(slot) ?? 0) === 0
    const tSubmit = Date.now()

    // 一次完整回合：提交 → 等答案 → 校验 → 取出译文。保真守卫的重试用它跑第二遍。
    const submitOnce = async (): Promise<string> => {
      const submission = await conversation.submit({ type: 'input', content: text }, session.context)
      let settled: SettledSubmissionRecord
      const abortTurn = (): void => {
        void conversation.abort(session.context).catch(() => undefined)
      }
      inFlight = { origin: gate.origin, abort: abortTurn }
      try {
        settled = await withTimeout(submission.wait(session.context), 'translation', cold ? budgets.cold : budgets.warm)
      } catch (err) {
        // 客户端超时不等于模型停了：不撤掉这一轮，它会在会话里继续跑，
        // 下一句 submit 只能排在它后面，表现就是「点了热键一直没反应」。
        abortTurn()
        throw err
      } finally {
        if (inFlight?.abort === abortTurn) inFlight = null
      }
      if (process.env.DURABLE_DEBUG)
        console.log('TURN_TIMING', JSON.stringify({ submitMs: Date.now() - tSubmit, settledMs: Date.now() - tSubmit, status: settled.status }))
      if (settled.status !== 'done') {
        const failure = settled as { reason?: string; detail?: unknown }
        const detail = failure.detail === undefined ? '' : ' (' + String(failure.detail).slice(0, 200) + ')'
        throw new Error('translation unanswered: ' + String(failure.reason ?? settled.status) + detail)
      }
      const turnsSoFar = (turns.get(slot) ?? 0) + 1
      turns.set(slot, turnsSoFar)
      if (turnsSoFar % TURNS_PER_CONVERSATION === 0) {
        // 每 N 轮清一次上下文：译文历史只保留最近几行（见 payload），不让旧答案变成范例。
        await conversation.reset(undefined, session.context)
      }
      const answerId = settled.answer as EntryId | undefined
      const page = await conversation.entries(
        answerId === undefined ? {} : { minEntryId: answerId, maxEntryId: answerId },
        1,
        undefined,
        session.context
      )
      const latest = page.items[0] as { model?: { content?: unknown }[] } | undefined
      const translated = sanitizeTranslation(messageText(latest))
      if (direction === 'zh-en' && (translated.match(/[\u3400-\u9fff]/g)?.length ?? 0) > 2)
        throw new Error('zh-en answer came back untranslated')
      return translated
    }

    let translated = await submitOnce()
    translated = ensureTerminalPunct(text, translated)
    // 保真守卫：缩写被写坏（bkb → bkg）就清历史重试一次；再犯就放弃，原文原样返回，
    // 译文和记账本都不进（调用方对「译文 === 原文」本来就不落账）。适用于所有 scope 包括 try。
    const violations = latinTokenViolations(text, translated, direction)
    if (violations.length > 0) {
      console.log('TRANSLATE_GUARD_RETRY', JSON.stringify({ tokens: violations, via: 'session' }))
      await resetHistory(direction, tone, scope)
      translated = await submitOnce()
      translated = ensureTerminalPunct(text, translated)
      const again = latinTokenViolations(text, translated, direction)
      if (again.length > 0) {
        console.log('TRANSLATE_GUARD_GIVEUP', JSON.stringify({ tokens: again, translated: translated.slice(0, 200), via: 'session' }))
        trackLatency(Date.now() - startedAt, 'session', 1)
        return text
      }
    }
    trackLatency(Date.now() - startedAt, 'session', 1)
    return translated
  })
}

/** 归一化后比较：去掉空白/标点/大小写差异，判断模型是不是把原文原样吐回来了。 */
function isEcho(source: string, output: string): boolean {
  const norm = (text: string): string => text.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
  const a = norm(source)
  const b = norm(output)
  return a.length > 0 && a === b
}

function noteFailure(reason: string): void {
  failedAt = Date.now()
  failedReason = reason
}

const CAPTURE_BUDGETS = { warm: CAPTURE_WARM_TIMEOUT_MS, cold: CAPTURE_COLD_TIMEOUT_MS }
/** 会话回合超过这个时间就并行发起直连请求（对冲）：mimo 首字节抖动 1-30 秒，谁先回来用谁。 */
const HEDGE_AFTER_MS = 5_000
/** 回复（热键直发）的对冲线更早：用户就站在聊天框前等，1.8 秒还没回就先拿直连的结果。 */
const REPLY_HEDGE_AFTER_MS = 1_800
/** 回复路径的回合预算：宁可早点对冲/兜底，也不让用户盯着聊天框干等十几秒。 */
const REPLY_BUDGETS = { warm: 9_000, cold: 15_000 }
/** 启动预热回合的上限：预热失败无所谓，绝不能拖住启动。 */
const WARM_UP_TIMEOUT_MS = 20_000

type Settled<T> = { ok: true; value: T } | { ok: false; error: Error }

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value): Settled<T> => ({ ok: true, value }),
    (error): Settled<T> => ({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })
  )
}

interface HedgeOutcome<T> {
  settled: Settled<T>
  via: 'session' | 'direct'
}

/**
 * 这一轮翻译还归不归调用方：guard 返回 false 就说明它被新的请求取代了，立刻放弃。
 * 直连对冲先回来时也用同一套机制掐掉没人读的会话回合（否则它继续烧 token、把下一句堵在后面）。
 */
interface TurnGate {
  /** 谁发起的：打断按来源认领，抓屏批次不该被热键掐掉。 */
  origin: TranslationOrigin
  guard?: () => boolean
}
/** 正在跑的会话回合：带上来源，打断时才认得出这是不是「自己要掐的那一个」。 */
let inFlight: { origin: TranslationOrigin; abort: () => void } | null = null
/**
 * 掐掉指定来源正在跑的翻译。返回 false 表示那一刻没有它的回合。
 * 热键直发第二次按下时要的就是这个：上一句别再往聊天框里写。
 */
export function abortTranslation(origin: TranslationOrigin): boolean {
  if (inFlight === null || inFlight.origin !== origin) return false
  inFlight.abort()
  return true
}

/**
 * 会话回合超过 afterMs 就并行打一条直连请求，谁先回用谁。
 * 直连先失败不算结果：那只是对冲失败，会话还有机会，继续等它。
 */
async function raceHedge<T>(
  session: Promise<Settled<T>>,
  direct: () => Promise<Settled<T>>,
  afterMs = HEDGE_AFTER_MS
): Promise<HedgeOutcome<T>> {
  let timer: NodeJS.Timeout | null = null
  const hedged = new Promise<HedgeOutcome<T> | null>((resolve) => {
    timer = setTimeout(() => {
      void direct().then((settled) => resolve(settled.ok ? { settled, via: 'direct' } : null))
    }, afterMs)
  })
  try {
    const first = await Promise.race([
      session.then((settled): HedgeOutcome<T> => ({ settled, via: 'session' })),
      hedged
    ])
    if (first) {
      if (first.via === 'direct') inFlight?.abort()
      return first
    }
    return { settled: await session, via: 'session' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 直连兜底也计时：抖动出现在会话层还是服务端，看分位数一目了然。 */
async function translateDirect(
  provider: ProviderConfig,
  text: string,
  direction: TranslateDirection,
  maxWords = DEFAULT_MAX_WORDS
): Promise<string> {
  const startedAt = Date.now()
  try {
    let output = await translateText(provider, text, direction, maxWords)
    output = ensureTerminalPunct(text, output)
    // 直连同样过保真守卫（对冲赢家、冷却兜底都走这里），重试一次后放弃回原文。
    const violations = latinTokenViolations(text, output, direction)
    if (violations.length > 0) {
      console.log('TRANSLATE_GUARD_RETRY', JSON.stringify({ tokens: violations, via: 'direct' }))
      output = await translateText(provider, text, direction, maxWords)
      output = ensureTerminalPunct(text, output)
      const again = latinTokenViolations(text, output, direction)
      if (again.length > 0) {
        console.log('TRANSLATE_GUARD_GIVEUP', JSON.stringify({ tokens: again, translated: output.slice(0, 200), via: 'direct' }))
        trackLatency(Date.now() - startedAt, 'direct', 1)
        return text
      }
    }
    trackLatency(Date.now() - startedAt, 'direct', 1)
    return output
  } catch (err) {
    trackLatency(Date.now() - startedAt, 'error', 1)
    throw err
  }
}

/** Translate one line, keeping the durable conversation when it is available. */
export async function translateLine(
  provider: ProviderConfig,
  text: string,
  direction: TranslateDirection,
  tone: ReplyTone = 'terse',
  scope: TranslateScope = 'prod',
  origin: TranslationOrigin = 'capture',
  /** 调用方是否还要这一句：返回 false 就立刻放弃（热键直发再按一次会作废上一句）。 */
  alive?: () => boolean
): Promise<string> {
  const startedAt = Date.now()
  // 这一句还有没有人要（按了第二次热键就没人要了）：每一处 await 之后都要再问一次，
  // 否则一次没人读的翻译会进记账本、占着回合锁、还可能冒充「翻译失败」触发 30 秒冷却。
  const ensureAlive = (): void => {
    if (alive && !alive()) throw new Error(TURN_CANCELLED)
  }
  ensureAlive()
  const cacheKey = providerKey(provider)
  // 记账本先查：这句（或它换个方向的那半句）翻过就直接出，不碰模型。
  const hit = lookupTranslation(
    text,
    direction,
    cacheKey,
    tone,
    origin,
    loadSettings().crossToneLookup !== false
  )
  if (hit !== null) {
    // 跨语气命中：译文本该「按语气重翻」，但既然句库里有现成的，先用它，别让用户白等一次模型。
    if (hit.tone !== tone) console.log('TRANSLATE_CACHE_CROSS_TONE', { want: tone, got: hit.tone })
    return hit.value
  }
  const cooling = failedReason !== null && Date.now() - failedAt < RETRY_AFTER_MS
  // 关掉思考后模型偶尔会把原文原样吐回（多半是历史里混进了同样的回声）。
  // 只对非中文方向判定：中文行本来就该原样返回。
  const sessionAttempt = async (): Promise<string> => {
    const budgets = scope === 'prod' && direction === 'zh-en' ? REPLY_BUDGETS : undefined
    let translated = await translateWithSession(provider, text, direction, tone, scope, budgets, { origin, guard: alive })
    if (direction !== 'zh-en' && isEcho(text, translated)) {
      await resetHistory(direction, tone, scope)
      translated = await translateWithSession(provider, text, direction, tone, scope, budgets, { origin, guard: alive })
      if (isEcho(text, translated)) throw new Error('session echoed the source line')
    }
    return translated
  }
  if (!cooling) {
    try {
      const outcome = await raceHedge(
        settle(sessionAttempt()),
        () => settle(translateDirect(provider, text, direction)),
        REPLY_HEDGE_AFTER_MS
      )
      if (!outcome.settled.ok) throw outcome.settled.error
      const translated = outcome.settled.value
      // 对冲/等待期间被作废的句子：成绩、记账本、失败冷却一律不记，就当没翻过。
      ensureAlive()
      trackLatency(Date.now() - startedAt, outcome.via, 1)
      lastFallback = outcome.via === 'session' ? null : '直连对冲先返回（会话层较慢）'
      if (translated) {
        // 保真守卫放弃时译文 === 原文：原样行不进记账本（与 writeTranslation 的原样跳过同一条规则）。
        if (translated !== text) writeTranslation(text, cacheKey, tone, translated, { direction, origin })
        return translated
      }
      noteFailure('empty session output')
    } catch (err) {
      // 被打断（abort）也会让会话回合报失败：先问一句「还要不要」，要才算真失败。
      // 记成失败会让下一句白等 30 秒冷却，表现出来就是「按了没反应」。
      ensureAlive()
      const message = errorMessage(err)
      trackLatency(Date.now() - startedAt, message.includes('timed out') ? 'timeout' : 'error', 1)
      noteFailure(message)
    }
  }
  ensureAlive()
  lastFallback = failedReason
  const fallback = await translateDirect(provider, text, direction)
  ensureAlive()
  if (fallback !== text) writeTranslation(text, cacheKey, tone, fallback, { direction, origin })
  return fallback
}

/**
 * 回复专用：先走 zh-en 会话，再压到词数上限（设置，默认 16）以内；
 * 仍然超长才让模型自己再压一版，最后无论如何都按词截断（聊天框放不下）。
 */
/** 面板「翻译试用」专用：和生产同一条流式链路，但历史隔离在 try# 会话里。 */
export async function translateTry(
  provider: ProviderConfig,
  text: string,
  direction: TranslateDirection
): Promise<string> {
  return translateLine(provider, text, direction, 'terse', 'try', 'try')
}

/** 回复翻译的调用方闸门：热键直发再按一次会把它作废，作废后既不提交也不写记账本。 */
export interface TranslateReplyOptions {
  alive?: () => boolean
}
export async function translateReply(
  provider: ProviderConfig,
  text: string,
  tone: ReplyTone = 'terse',
  options: TranslateReplyOptions = {}
): Promise<string> {
  // 回复腿的词数上限走设置（默认 16）：clamp、二次压缩判定与 shorten 提示词共用。
  const maxWords = maxWordsFromSettings(loadSettings().translationMaxWords)
  let raw = await translateLine(provider, text, 'zh-en', tone, 'prod', 'reply', options.alive)
  // 一条聊天行只能对应一句话：模型偶尔回两行，取第一行，别把两句拼进游戏聊天框。
  raw = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? raw
  if (looksLikeCommentary(raw)) {
    await resetHistory('zh-en', tone)
    raw = await translateLine(provider, text, 'zh-en', tone, 'prod', 'reply', options.alive)
  }
  if (looksLikeCommentary(raw)) throw new Error('reply translation came back as commentary')
  const clamped = clampReply(raw, maxWords)
  let answer = clamped
  if (!replyWithinLimits(clamped, maxWords)) {
    try {
      // 二次压缩又要一次模型往返：已经没人要这一句就别花这个时间。
      if (options.alive && !options.alive()) throw new Error(TURN_CANCELLED)
      const shortened = clampReply(await shortenReply(provider, clamped, maxWords), maxWords)
      if (shortened.length > 0) answer = shortened
    } catch {
      // 二次压缩失败不影响主流程，下面直接返回截断结果。
    }
  }
  // 记账本对齐「真正发出去的那句」：translateLine 写进去的是模型原始输出，
  // 可能带两行或超长；反查要按实际发出去的文本才对得上。
  writeTranslation(text, providerKey(provider), tone, answer, {
    direction: 'zh-en',
    origin: 'reply'
  })
  return answer
}

/**
 * Translate one capture tick as a single numbered block (one request instead of N),
 * falling back to direct per-line translation when the session is unavailable.
 * 记账本里已经有的行不再发给模型，只翻没见过的；结果按原顺序拼回去。
 */
/** 只比「字」：大小写、空白、标点、符号的差别不算两个意思。 */
export function sameText(a: string, b: string): boolean {
  const norm = (text: string): string => text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  return norm(a) === norm(b)
}

export async function translateLines(
  provider: ProviderConfig,
  texts: string[],
  direction: TranslateDirection,
  /** 可选出参：第 i 行是不是直接从记账本取的（没调模型）。 */
  marks?: boolean[]
): Promise<string[]> {
  if (texts.length === 0) return []
  const cacheKey = providerKey(provider)
  const cached = texts.map((text) => readTranslation(text, direction, cacheKey, 'terse', 'capture'))
  const pending: number[] = []
  cached.forEach((value, index) => {
    if (marks) marks[index] = value !== null
    if (value === null) pending.push(index)
  })
  if (pending.length === 0) return cached as string[]
  const fresh = await translateBlockwise(
    provider,
    pending.map((index) => texts[index]),
    direction
  )
  const merged = cached as string[]
  pending.forEach((index, at) => {
    const value = (fresh[at] ?? texts[index]).trim()
    // 模型把原文原样吐回来（`gg → gg`、`??? → ???`）就没有「译文」可言：存进账本
    // 只会多一条无信息的一对，浮层还会把同一句显示两遍。原样返回就当作没有译文。
    if (sameText(texts[index], value)) {
      merged[index] = ''
      return
    }
    merged[index] = value
    writeTranslation(texts[index], cacheKey, 'terse', value, { direction, origin: 'capture' })
  })
  return merged
}

async function translateBlockwise(
  provider: ProviderConfig,
  texts: string[],
  direction: TranslateDirection
): Promise<string[]> {
  if (texts.length === 0) return []
  const startedAt = Date.now()
  const cooling = failedReason !== null && Date.now() - failedAt < RETRY_AFTER_MS
  if (!cooling) {
    try {
      const output: string[] = []
      for (let start = 0; start < texts.length; start += BLOCK_LIMIT) {
        const slice = texts.slice(start, start + BLOCK_LIMIT)
        const payload =
          slice.length === 1
            ? slice[0]
            : slice.map((text, i) => i + 1 + '| ' + text.replace(/\r?\n/g, ' ')).join('\n')
        const outcome = await raceHedge(
          settle(translateWithSession(provider, payload, direction, 'terse', 'prod', CAPTURE_BUDGETS)),
          () => settle(translateDirect(provider, payload, direction))
        )
        if (!outcome.settled.ok) throw outcome.settled.error
        const translated = outcome.settled.value
        if (slice.length === 1) {
          output.push(translated)
          continue
        }
        lastRaw = translated.slice(0, 400)
        const parsed = numberedTranslations(translated, slice.length)
        if (parsed.some((value) => value.length === 0)) {
          await resetHistory(direction)
          throw new Error('numbered block came back incomplete')
        }
        output.push(...parsed)
      }
      lastFallback = null
      return output
    } catch (err) {
      const message = errorMessage(err)
      trackLatency(Date.now() - startedAt, message.includes('timed out') ? 'timeout' : 'error', texts.length)
      noteFailure(message)
    }
  }
  lastFallback = failedReason
  return Promise.all(
    texts.map((text) => translateDirect(provider, text, direction).catch(() => text))
  )
}

/** Debug only: dump the newest entries of each translator conversation. */
export async function sessionDump(limit = 6): Promise<unknown[]> {
  const meta = { userData: app.getPath('userData'), db: sessionPaths(loadSettings().provider).db }
  const session = await ensureRuntime(loadSettings().provider)
  if (!session) return []
  const out: unknown[] = [meta]
  for (const [slot, conversation] of session.conversations) {
    const page = await conversation.entries({}, limit, undefined, session.context)
    for (const entry of page.items) {
      const model = (entry as { model?: { content?: unknown }[] }).model ?? []
      out.push({
        slot,
        conversationId: conversation.id,
        entryId: entry.id,
        type: (entry as unknown as { type: string }).type,
        text: messageText({ model }).slice(0, 160)
      })
    }
  }
  return out
}

export function sessionStatus(): SessionStatus {
  return {
    active: runtime !== null,
    model: runtime?.modelId ?? null,
    conversations: Array.from(runtime?.conversations.keys() ?? []),
    lastFallback,
    lastRaw,
    latency: latencySummary()
  }
}

/** 面板「清空缓存」的数字口径：记账对 + 会话槽；inspect 与 clear 共用，model 供确认框点名。 */
export interface TranslationCacheCounts {
  pairs: number
  conversations: number
  model: string
}

function countStateSlots(path: string): number {
  try {
    return Object.keys(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>).length
  } catch {
    return 0
  }
}

/**
 * 只数数不动文件：这个 provider 名下的记账对与会话槽。面板确认框的第一步。
 * 参数可显式传入（探针用假 provider），不传就是当前设置里的 provider。
 */
export function inspectTranslationCache(provider: ProviderConfig = loadSettings().provider): TranslationCacheCounts {
  return {
    pairs: translationCachePairsFor(providerKey(provider)),
    conversations: countStateSlots(sessionPaths(provider).state),
    model: provider.model
  }
}

/**
 * 清空这个 provider 的全部翻译缓存：记账本对 + 会话库（sqlite 连同 wal/shm）+ 会话槽 sidecar。
 * 其它 provider 的文件按 hash 分名，一个字节都不碰。会话库整个删掉重建：缓存与历史都可再生，
 * 大小才拿得回来；下一句翻译会自然重建全新会话。
 */
export async function clearTranslationCache(
  provider: ProviderConfig = loadSettings().provider
): Promise<TranslationCacheCounts> {
  const key = providerKey(provider)
  const paths = sessionPaths(provider)
  const conversations = countStateSlots(paths.state)

  // 正在跑的回合先揪掉（translateWithSession 的 abort 约定）：不清这一步，半截回合会把
  // stale 状态写回刚删掉的文件，下一句还排在死会话后面。
  if (runtime && runtime.key === key) inFlight?.abort()

  return withTurnLock(async () => {
    // 锁内重看一眼：排队回合可能刚换过会话。先关句柄再删文件——Windows 上开着句柄删不动。
    if (runtime && runtime.key === key) {
      await runtime.harness.close(runtime.context).catch(() => undefined)
      runtime = null
    }
    turns.clear()
    failedAt = 0
    failedReason = null
    for (const path of [paths.state, paths.db, `${paths.db}-wal`, `${paths.db}-shm`]) {
      try {
        rmSync(path, { force: true })
      } catch (err) {
        console.log('TRANSLATE_SESSION_CLEAR_FAILED', path, errorMessage(err))
      }
    }
    const pairs = clearTranslationPairs(key)
    return { pairs, conversations, model: provider.model }
  })
}
