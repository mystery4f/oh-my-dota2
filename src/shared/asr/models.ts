/**
 * ASR 模型注册表：磁盘上现在有哪些模型、哪一份可当现役。
 *
 * 纯函数，不碰 fs：主进程只负责把「候选目录的顶层字节数、必备文件的字节数」采上来
 * （`AsrDirFact`），归属判定、ready 判据、来源分类、现役回落全在这里，所以能被探针锁住。
 *
 * 为什么要有注册表：换模型（同引擎不同权重、微调转正、回滚到备份）在旧结构里等于改代码，
 * 而它本该只是「换个 id」。注册表让面板列得出每一份模型，设置里只存一个 id。
 */
import { ASR_ENGINE_LIST, type AsrEngineId, type AsrEngineSpec, type AsrSherpaKind } from './engines'

/** 一个候选目录的磁盘事实。 */
export interface AsrDirFact {
  /** userData 相对路径，正斜杠。 */
  rel: string
  /** `requiredPathsAll()` 里每个路径的字节数（不存在 = -1）。 */
  sizes: Record<string, number>
  /** 目录顶层总字节数，面板用来看体积。 */
  bytes: number
}

export interface AsrModel {
  /** 稳定 id：`<engineId>:<rel>`，settings 里存的就是它。 */
  id: string
  engineId: AsrEngineId
  label: string
  rel: string
  ready: boolean
  bytes: number
  /** download = 按表下载；manual = 手动解包；finetuned = 训练产物待转正；backup = 回滚点。 */
  origin: 'download' | 'manual' | 'finetuned' | 'backup'
}

/** 面板与识别入口共享的一份快照：有哪些模型、现在用哪份、id 是钉的还是回落的。 */
export interface AsrState {
  models: AsrModel[]
  /** 生效的现役 id（可能是回落选出来的）。 */
  activeId: string
  /** 设置里钉过 id 没有：没钉时界面要说清「按可用性自动选」。 */
  pinned: boolean
}

/** 路径是否落在某个候选模式下：末尾 `*` 是前缀匹配，其余要求完全相等。 */
export function matchesDirPattern(pattern: string, rel: string): boolean {
  return pattern.endsWith('*') ? rel.startsWith(pattern.slice(0, -1)) : pattern === rel
}

/** 目录归属哪个引擎：按表顺序，第一条匹配的模式说了算；都不匹配返回 null（退役目录自然消失）。 */
export function engineForRel(rel: string): AsrEngineSpec | null {
  for (const spec of ASR_ENGINE_LIST) {
    if (spec.dirPatterns.some((pattern) => matchesDirPattern(pattern, rel))) return spec
  }
  return null
}

/** sherpa worker 用的适配器键：调用方只该从这里拿，不要自己写字符串。 */
export function sherpaKindFor(model: AsrModel): AsrSherpaKind {
  return ASR_ENGINE_LIST.find((spec) => spec.id === model.engineId)?.sherpaKind ?? 'qwen3Asr'
}

function lastSegment(rel: string): string {
  const parts = rel.split('/')
  return parts[parts.length - 1] ?? rel
}

function originOf(spec: AsrEngineSpec, rel: string): AsrModel['origin'] {
  if (rel.endsWith('.bak')) return 'backup'
  if (rel.endsWith('.next')) return 'finetuned'
  return rel === spec.canonicalRel ? 'download' : 'manual'
}

function labelOf(spec: AsrEngineSpec, rel: string, origin: AsrModel['origin']): string {
  if (origin === 'backup') return `${spec.label}（备份）`
  if (origin === 'finetuned') return `${spec.label}（待转正）`
  if (origin === 'download') return spec.label
  return `${spec.label} · ${lastSegment(rel)}`
}

/**
 * 目录事实 → 模型列表。顺序固定：ready 在前，其次按 id 字典序，
 * 这样面板永远同一个顺序，探针也能比对。
 */
export function collectAsrModels(facts: readonly AsrDirFact[]): AsrModel[] {
  const models: AsrModel[] = []
  for (const fact of facts) {
    const spec = engineForRel(fact.rel)
    if (!spec) continue
    const origin = originOf(spec, fact.rel)
    models.push({
      id: `${spec.id}:${fact.rel}`,
      engineId: spec.id,
      label: labelOf(spec, fact.rel, origin),
      rel: fact.rel,
      ready: spec.requiredPaths.every((path) => (fact.sizes[path] ?? -1) > 0),
      bytes: fact.bytes,
      origin
    })
  }
  return models.sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * 现役回落规则（只写这一处）：id 命中就用它；没命中就用第一条 ready 的；一条都没有返回 null。
 * 命中不看 ready —— 用户刚点的那份可能还在下载，界面要能显示「正在准备」而不是悄悄换成别的模型。
 */
export function pickActiveAsrModel(models: readonly AsrModel[], activeId: string): AsrModel | null {
  const hit = models.find((model) => model.id === activeId)
  if (hit) return hit
  return models.find((model) => model.ready) ?? null
}

/** 迁移用：设置里还没有 id 时该写哪一条（第一条 ready，没有就空串）。 */
export function defaultActiveModelId(models: readonly AsrModel[]): string {
  return pickActiveAsrModel(models, '')?.id ?? ''
}
