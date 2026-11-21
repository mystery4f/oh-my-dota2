import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { Notification } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  canStartTrain,
  deriveTrainPlan,
  inferenceHoldLabel,
  normalizeTrainKind,
  shouldPauseInference,
  shouldResumeInference,
  type TrainLogLine,
  type TrainPlan,
  type TrainSnapshot,
  type TrainStartRequest,
  type TrainStartResult,
  type TrainTaskInfo,
  type TrainTaskKind,
  type TrainTaskStatus
} from '@shared/train/task'
import { parseTrainProgress } from '@shared/train/progress'
import { ensureSovitsServer, pauseSovitsForTraining, setInferenceHold, type SovitsPauseOutcome } from '../voice/sovits-server'
import { applyAsrFtModel, ftModelDirs, markRunStatus, pruneAsrFtRunDirs, stageFtNextModel } from './asr-ft'
import { ftWavDurationMs, summarizePendingTakes } from '@shared/train/asr-ft'
import { datasetVersionOf } from '@shared/train/dataset-version'
import {
  buildTrainRun,
  finishTrainRun,
  runKindLabel,
  runStatusLabel,
  type TrainRunParams,
  type TrainRunRecord
} from '@shared/train/run'
import { listDatasetEntries, loadTrainRun, markDatasetEntriesTrained, saveDatasetLedger, saveTrainRun } from './run-store'
import { readAsrMetrics, readGvMetrics } from './run-metrics'
import { auditionEntriesOf, auditionModelPair, defaultAuditionTranscribe } from './audition'
import { auditionLine, type FtAudition } from '@shared/train/audition'
import { TrainQueue, trainQueueLine, trainQueueQueuedLine, type TrainQueueEntry } from '@shared/train/queue'
import { finetuneEngine } from './target-engine'
import { errorMessage } from '@shared/errors'
import type { AsrFtSwapResult } from '@shared/train/asr-ft'
import { appendTrainLog } from './log-file'

/**
 * 训练任务管理器：同一时刻只允许一个训练进程（编排器约定）。
 * 拿到 @shared/train 推导出的计划就 spawn，stdout/stderr 全部进日志环，
 * 已知格式顺手解析成进度。推理互斥的执行（停 GV / 恢复 GV）在 T2 接线，
 * 这里先把「该不该让路」通过任务状态暴露出去。
 */

const LOG_RING_LIMIT = 500
/** 进度广播节流：真训练栈一秒几十行日志，不节流会把窗口渲染按住。 */
const BROADCAST_MIN_MS = 250
/** 训练栈 OOM 的原文标记：torch 抛 `torch.OutOfMemoryError: CUDA out of memory`，也有 RuntimeError 包装的写法。 */
const OOM_RE = /CUDA out of memory|OutOfMemoryError|out of memory/i
/** Python 收场那行：`RuntimeError: …` / `some.module.Error: …`，用来把 exit code 变成一句人话。 */
const ERROR_LINE_RE = /(?:^|\s)(?:[A-Za-z_][\w.]*Error|Exception):\s*\S/

/** 请求 → run 参数：ASR 的轮数/lr/续训点与 GV 的版本/批大小/轮数都在这里定案。 */
function runParamsOf(kind: TrainTaskKind, request: TrainStartRequest): TrainRunParams {
  if (kind === 'asr-ft') {
    const tuning = request.asrFt?.tuning
    // 开训口径落账：从底模重训 / 接着上一轮权重。请求没标就看 tuning 里有没有接续点（老调用方兼容）。
    const mode = request.mode ?? (tuning?.resumeFrom || tuning?.initFrom ? 'incremental' : 'fresh')
    return { epochs: tuning?.epochs, lr: tuning?.lr, resumeFrom: tuning?.resumeFrom ?? tuning?.initFrom ?? null, mode }
  }
  if (kind === 'gv-gpt' || kind === 'gv-sovits') {
    return { version: request.gv?.version, batchSize: request.gv?.batchSize, epochs: request.gv?.epochs }
  }
  return {}
}

/** 数据指纹：只统计拿得到的东西（ASR 两个 jsonl 的行数与字节数），拿不到就留 0 不编。 */
function runDataOf(request: TrainStartRequest): { files: number; bytes: number } {
  let lines = 0
  let bytes = 0
  for (const file of [request.asrFt?.data.trainJsonl, request.asrFt?.data.evalJsonl]) {
    if (!file) continue
    try {
      const text = readFileSync(file, 'utf8')
      bytes += Buffer.byteLength(text, 'utf8')
      lines += text.split('\n').filter((line) => line.trim().length > 0).length
    } catch {
      // 文件还没落盘就不算，别让指纹拦住开训
    }
  }
  return { files: lines, bytes }
}

/** 产物路径：ASR 是 checkpoint 根 + 导出目录；GV 是实验目录（webui 的 logs/<exp>）。 */
function runArtifactsOf(kind: TrainTaskKind, request: TrainStartRequest): TrainRunRecord['artifacts'] {
  if (kind === 'asr-ft' && request.asrFt) {
    return { runDir: request.asrFt.data.runDir, ckptDir: request.asrFt.data.runDir, exportDir: request.asrFt.exportDir }
  }
  if ((kind === 'gv-gpt' || kind === 'gv-sovits') && request.gvResolved) {
    return { runDir: join(request.gvResolved.home, 'GPT_SoVITS', 'logs', request.gvResolved.expName) }
  }
  return {}
}

/** 长跑结束发一次系统通知：人可以去睡觉，收场不用守着窗口。手动停止不打扰。 */
function notifyRunEnd(run: TrainRunRecord): void {
  if (run.status === 'stopped') return
  try {
    if (!Notification.isSupported()) return
    const ok = run.status === 'trained' || run.status === 'applied'
    new Notification({
      title: ok ? '训练完成' : '训练失败',
      body: `${runKindLabel(run.kind)} · ${run.experiment} · ${runStatusLabel(run.status)}`
    }).show()
  } catch {
    // 通知只是提醒，失败不影响训练结果
  }
}

/**
 * manager 对语音侧的副作用出口：默认绑真实实现（sovits-server）。
 * 探针注入记录器后，「训练占卡 → 朗读让路」的接线从源码文本钉升级为行为断言。
 */
export interface TrainVoiceIo {
  holdInference(hold: boolean): void
  pause(): SovitsPauseOutcome
  resume(): Promise<boolean>
}

function realTrainVoiceIo(): TrainVoiceIo {
  return { holdInference: setInferenceHold, pause: pauseSovitsForTraining, resume: ensureSovitsServer }
}

export class TrainManager {
  constructor(private io: TrainVoiceIo = realTrainVoiceIo()) {}
  private task: TrainTaskInfo | null = null
  private logs: TrainLogLine[] = []
  private child: ChildProcess | null = null
  private listeners = new Set<(snapshot: TrainSnapshot) => void>()
  private lastBroadcastAt = 0
  /** asr-ft 的两段式：训练腿跑完拿这条闭包拼导出腿；其他 kind 恒为 null。 */
  private chain: (() => TrainPlan | null) | null = null
  /** 本任务走过链式导出没有：决定 done 的收场文案。 */
  private chained = false
  /** 本任务的启动请求：asr-ft 失败时回写 run.json（其他 kind 不碰账本）。 */
  private request: TrainStartRequest | null = null
  /** 本次任务的训练记录：开训即落盘，收场补指标与产物（面板两页读它）。 */
  private run: TrainRunRecord | null = null
  /**
   * #107：排队的任务。队头出队即开跑；队列**从不**持有正在跑的那一个，
   * 所以撤排队与停正在跑是两条路，这里不会互相踩。
   */
  private readonly queue = new TrainQueue()
  private readonly queuedStarts = new Map<
    string,
    { request: TrainStartRequest; chain: (() => TrainPlan | null) | null; warning: string | null }
  >()
  onState(listener: (snapshot: TrainSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(): TrainSnapshot {
    // #107：队列一起广播——面板换页回来也能立刻看到「后面还排着谁」。
    return { task: this.task, logs: this.logs.slice(-120), queue: this.queue.list() }
  }

  /** 当前任务状态：null = 没有任务（面板和 T2 的互斥判定都从这里读）。 */
  status(): TrainTaskStatus | null {
    return this.task?.status ?? null
  }

  private record(text: string): void {
    this.logs.push({ at: Date.now(), text })
    if (this.logs.length > LOG_RING_LIMIT) this.logs.splice(0, this.logs.length - LOG_RING_LIMIT)
    appendTrainLog(text)
  }

  /**
   * 开训头几行（asr-ft 专用）：这次吃多少条、从哪条开始、到哪条结束、轮数/lr/起点。
   * 用户按这份日志判断「练的是什么」——只有阶段名的话，事后根本分不清哪一轮吃了哪批录音。
   */
  private recordAsrFtOpening(request: TrainStartRequest): void {
    const ledger = request.asrFt?.ledger ?? []
    if (ledger.length === 0) return
    const train = ledger.filter((entry) => entry.split === 'train')
    const evalCount = ledger.length - train.length
    const audioMs = ledger.reduce((sum, entry) => sum + ftWavDurationMs(entry.bytes), 0)
    const mode = request.mode === 'incremental' ? '增量微调' : '全量重训'
    this.record(
      `—— 开始训练：${mode} · ${train.length} 条进训练 + ${evalCount} 条留验证（共 ${ledger.length} 条，${Math.max(1, Math.round(audioMs / 1000))} 秒音频）——`
    )
    const first = train[0]
    const last = train[train.length - 1]
    if (first) this.record(`第 1 条：${first.key}「${first.text}」`)
    if (last && last !== first) this.record(`最后一条：${last.key}「${last.text}」`)
    const tuning = request.asrFt?.tuning
    if (tuning) {
      const start = tuning.resumeFrom ?? tuning.initFrom ?? '底模'
      this.record(`轮数 ${tuning.epochs ?? '自动'} · 学习率 ${tuning.lr ?? '引擎默认'} · 起点 ${start}`)
    }
  }

  private emit(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastBroadcastAt < BROADCAST_MIN_MS) return
    this.lastBroadcastAt = now
    const snap = this.snapshot()
    for (const listener of this.listeners) listener(snap)
  }

  private nodeBin(): string | null {
    const candidate = process.env.OHMYDOTA2_NODE || 'node'
    const check = spawnSync(candidate, ['-v'], { timeout: 5000, windowsHide: true })
    return check.status === 0 ? candidate : null
  }

  start(request: TrainStartRequest, chain?: () => TrainPlan | null, warning?: string | null): TrainStartResult {
    const gate = canStartTrain(this.status())
    if (!gate.ok) {
      // #107：正在跑（preparing/running）时不再是「先停止再开新的」，而是排进队列；
      // 「还在停」仍然拒绝——那一刻旧进程没退干净，排进去也不知道什么时候能开。
      const busy = this.task !== null && (this.task.status === 'preparing' || this.task.status === 'running')
      if (!busy) return { ok: false, error: gate.reason }
      return this.enqueueStart(request, chain ?? null, warning ?? null)
    }
    const kind: TrainTaskKind = normalizeTrainKind(request.kind)
    // 整份 request 一起传：asrFt / gvResolved 是备料阶段挂上来的附件，丢掉就一定会报「环境没就绪」
    const plan = deriveTrainPlan({ ...request, kind })
    if (plan.unavailable) return { ok: false, error: plan.unavailable }
    const node = this.nodeBin()
    if (plan.exe === 'node' && !node) return { ok: false, error: '没找到 node，演示任务跑不了（装 node 或设 OHMYDOTA2_NODE）' }

    this.task = {
      id: `train-${Date.now()}`,
      kind,
      dataset: String(request.dataset ?? ''),
      status: 'preparing',
      progress: -1,
      stage: '启动中',
      startedAt: Date.now(),
      endedAt: null,
      inference: null
    }
    this.logs = []
    // 显存预检的提示（只提示不拦）：放在第一行，用户点完就能看见「现在有多少、差多少」。
    if (warning) this.record(warning)
    if (kind === 'asr-ft') this.recordAsrFtOpening(request)
    this.emit(true)
    if (shouldPauseInference(this.status()) && this.task) {
      const outcome = this.io.pause()
      this.task = { ...this.task, inference: outcome === 'paused' ? 'held' : 'kept-off' }
      this.record(inferenceHoldLabel(outcome === 'paused' ? 'held' : 'kept-off'))
      this.emit(true)
    }
    // 训练占显存期间，朗读热键与试听都不许把 GV 拉回来——那等于把刚下的暂停命令撤销。
    this.io.holdInference(true)

    this.request = request
    this.chain = chain ?? null
    this.chained = false
    // 开训即落记录：跑崩了也能在列表里看到「曾经跑过、失败在什么阶段」。
    this.run = buildTrainRun({
      kind,
      experiment: String(request.dataset ?? ''),
      params: runParamsOf(kind, request),
      data: runDataOf(request),
      artifacts: runArtifactsOf(kind, request),
      startedAt: this.task?.startedAt,
      // #109：开训前就把这批录音的版本号写进 run 行——跑到一半崩了，也能回答「它本来要吃哪一批」。
      datasetVersion: kind === 'asr-ft' && request.asrFt?.ledger ? datasetVersionOf(request.asrFt.ledger) : null
    })
    saveTrainRun(this.run)
    // 这次打包吃进去的录音随开训一起记账（split + 指纹），run 行上留一份冻结快照给续训对账；
    // 训练成功才标「已训」，见 finish。
    if (this.run.kind === 'asr-ft' && request.asrFt?.ledger) saveDatasetLedger(request.asrFt.ledger, this.run.id)
    this.spawnChild(plan.exe === 'node' ? (node ?? 'node') : plan.exe, plan)
    return { ok: true, error: null }
  }

  /** #107：把这次开训请求排进队列，返回位次（`queued`）。 */
  private enqueueStart(request: TrainStartRequest, chain: (() => TrainPlan | null) | null, warning: string | null): TrainStartResult {
    const kind = normalizeTrainKind(request.kind)
    const label = `${kind} · ${String(request.dataset ?? '演示')}`
    const id = `queued-${Date.now()}-${this.queue.size() + 1}`
    const added = this.queue.add({ id, label, requestedAt: Date.now() })
    if (!added.ok) return { ok: false, error: added.error }
    this.queuedStarts.set(id, { request, chain, warning })
    this.record(trainQueueQueuedLine(label, added.position))
    this.emit(true)
    return { ok: true, error: null, queued: added.position }
  }

  /** 队列快照：面板与日志读同一句话，标题里不再各自拼。 */
  queuedSnapshot(): { entries: TrainQueueEntry[]; line: string } {
    const entries = this.queue.list()
    return { entries, line: trainQueueLine(entries) }
  }

  /**
   * 撤掉一个还在等的任务。正在跑的那个不在队列里，所以这里永远拒绝它并指路「停止」——
   * 一次误点不许把正在写权重的那一轮吹掉。
   */
  cancelQueued(id: string): { ok: boolean; error: string | null } {
    const outcome = this.queue.remove(id)
    if (outcome.error !== null) return { ok: false, error: outcome.error }
    this.queuedStarts.delete(id)
    this.record(`已从队列撤掉：${outcome.removed?.label ?? id}`)
    this.emit(true)
    return { ok: true, error: null }
  }

  /** 收场后接上队头；队列空就什么也不做（收场路径不许因此变慢或变吵）。 */
  private drainQueue(): void {
    const next = this.queue.shift()
    if (next === null) return
    const args = this.queuedStarts.get(next.id)
    this.queuedStarts.delete(next.id)
    if (!args) return
    this.record(`队列接上：${next.label}（${trainQueueLine(this.queue.list())}）`)
    const outcome = this.start(args.request, args.chain ?? undefined, args.warning ?? undefined)
    if (!outcome.ok) this.record(`队列里这一轮开不了：${outcome.error ?? '未知原因'}`)
  }

  /** 训练腿成功且有链：同一任务接着跑导出腿，状态只换阶段不换任务。 */
  private launchChain(plan: TrainPlan): void {
    this.record('—— 训练完成，接着导出 ONNX（CPU，不占显卡）——')
    this.chained = true
    if (this.task) this.task = { ...this.task, status: 'running', progress: -1, stage: '导出 ONNX（CPU）' }
    this.emit(true)
    this.spawnChild(plan.exe, plan)
  }

  private spawnChild(exe: string, plan: TrainPlan): void {
    const child = spawn(exe, plan.args, {
      cwd: plan.cwd ?? undefined,
      env: plan.env ? { ...process.env, ...plan.env } : process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => this.onChunk(String(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => this.onChunk(String(chunk)))
    child.on('error', (err: Error) => {
      this.record(`启动失败: ${String(err)}`)
      if (this.child === child) this.finish('failed', null)
    })
    child.on('exit', (code: number | null) => {
      // 迟到的旧进程退场不碰新任务（常驻桥的老规矩）。
      if (this.child !== child) return
      if (this.task?.status === 'stopping') {
        this.finish('stopped', code)
        return
      }
      // funasr 收尾的权重平均可能死在「挑中的文件已被淘汰」上，训练本身却是成功的：救回来继续导出，
      // 别为了一句日志把几十分钟的卡白烧。
      const ok = code === 0 || this.salvageFunasrAverage()
      if (ok && this.chain) {
        const next = this.chain()
        this.chain = null
        if (next) {
          this.launchChain(next)
          return
        }
        this.record('没找到训练产物（checkpoint-*），导出没法继续，按失败收场')
        this.finish('failed', code)
        return
      }
      if (ok) this.finish('done', code)
      else this.finish('failed', code)
    })
  }

  /**
   * funasr 收尾的 `average_checkpoints` 先按 val 表挑最优文件名、再去开那个文件；acc 并列时它挑中的
   * 正是 keep_nbest 窗口刚淘汰掉的那个，于是 `RuntimeError: No checkpoints found for averaging`
   * 把一次已经跑完的训练记成失败（实测 2026-11-09：15 epoch / 585 步跑完，目录只剩 ep13/14/15）。
   * 权重本身在 `model.pt.best`，导出腿也认它：日志里有这一句、磁盘上还有可用权重，就继续走。
   */
  private salvageFunasrAverage(): boolean {
    if (this.run?.kind !== 'asr-ft' || !this.chain) return false
    if (!this.logs.some((line) => line.text.includes('No checkpoints found for averaging'))) return false
    const dir = this.run.artifacts.runDir ?? ''
    const weight = ['model.pt.avg1', 'model.pt.best', 'model.pt'].find((name) => {
      try {
        return statSync(join(dir, name)).isFile()
      } catch {
        return false
      }
    })
    if (!weight) return false
    this.record(`权重平均没做成（并列挑到了已淘汰的 checkpoint），改用 ${weight} 直接导出`)
    return true
  }

  private onChunk(chunk: string): void {
    for (const raw of chunk.split(/\r?\n/)) {
      const text = raw.trim()
      if (!text) continue
      this.record(text)
      const progress = parseTrainProgress(text)
      if (progress && this.task && (this.task.status === 'preparing' || this.task.status === 'running')) {
        this.task = { ...this.task, status: 'running', progress: progress.percent, stage: progress.stage }
      }
      this.emit()
    }
  }

  stop(): TrainStartResult {
    if (!this.child || !this.task) return { ok: false, error: '没有在跑的任务' }
    if (this.task.status !== 'preparing' && this.task.status !== 'running') return { ok: false, error: '任务不在跑' }
    this.task = { ...this.task, status: 'stopping' }
    this.emit(true)
    const pid = this.child.pid
    if (pid) {
      // Windows 下杀进程树：子进程可能带出自己的孙进程（训练栈常这样）。
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 8000, windowsHide: true })
    } else {
      this.child.kill()
    }
    return { ok: true, error: null }
  }

  /**
   * 应用退出前收尾：杀掉训练进程树，并把这一轮记成失败。
   *
   * 不走 finish()：那里会广播快照、弹系统通知、把朗读拉回来，退出途中窗口正在销毁，
   * 副作用只会换来一串 "Object has been destroyed"。启动对账兜的是进程被强杀的情况，
   * 这里兜的是正常退出（用户点退出时训练还在跑）。
   */
  shutdown(): void {
    const child = this.child
    const run = this.run
    if (!child && !run) return
    if (child) {
      const pid = child.pid
      // Windows 下杀进程树：python 训练栈常带出自己的孙进程（dataloader）。
      if (pid) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 8000, windowsHide: true })
      else child.kill()
    }
    this.child = null
    if (this.task) this.task = { ...this.task, status: 'failed', endedAt: Date.now(), stage: '应用退出，训练被中断' }
    if (run && run.status === 'running') {
      this.record('应用退出，训练被中断（这一轮没有跑完）')
      this.settle({
        status: 'failed',
        error: '应用退出，训练被中断（这一轮没有跑完）',
        metrics: this.runMetrics(run)
      })
    }
    this.io.holdInference(false)
  }

  /** 日志环最近一段有没有 OOM 原文：失败收场要说人话，别只丢一个 exit code。 */
  private sawOom(): boolean {
    return this.logs.slice(-60).some((line) => OOM_RE.test(line.text))
  }

  /**
   * 退场原因只写 exit code 等于没说：Python 那边已经把 traceback 打进日志了，
   * 这里捞最后一条真错误（`XxxError: …` / `Exception: …`）附在收场文案后面。
   */
  private lastErrorLine(): string | null {
    const tail = this.logs.slice(-80)
    for (let index = tail.length - 1; index >= 0; index--) {
      const text = tail[index].text.trim()
      if (!ERROR_LINE_RE.test(text)) continue
      return text.length > 160 ? `${text.slice(0, 157)}…` : text
    }
    return null
  }

  /** 这一轮该记什么指标：识别读训练目录，音色读 GV 日志；读不到就记 null，不编。 */
  private runMetrics(run: TrainRunRecord) {
    return run.kind === 'asr-ft'
      ? readAsrMetrics(run.artifacts.runDir)
      : readGvMetrics(this.request?.gvResolved?.home, run.experiment)
  }


  /**
   * 收场时的转正决策（#105）：先把导出产物铺成 .next，再用这一轮的留出集录音试听。
   *
   * 三种收场：
   * - 铺不成（导出缺件）→ 返回失败，与旧行为一致；
   * - 没有留出集可听 → 记一条「自动跳过」再直接换上，run 行上留痕；
   * - 有留出集 → 起一个后台试听，本次不换模（awaiting），人看过对比再选采纳或跳过。
   */
  private auditionOrPromote(saved: TrainRunRecord | null): { result: AsrFtSwapResult | null; awaiting: boolean } {
    const staged = stageFtNextModel()
    if (!staged.ok) return { result: { ok: false, error: staged.error ?? '准备新模型失败', model: null }, awaiting: false }
    const entries = auditionEntriesOf(this.request?.asrFt?.ledger ?? [])
    if (saved === null || entries.length === 0) {
      if (saved) {
        const patched = finishTrainRun(saved, {
          status: 'trained',
          auditionSkip: { at: Date.now(), auto: true, reason: '没有留出集可听' }
        })
        saveTrainRun(patched)
        this.run = patched
        this.record('没有留出集可听：自动跳过试听，直接换上')
      }
      return { result: applyAsrFtModel(), awaiting: false }
    }
    void this.runAudition(saved, entries)
    return { result: null, awaiting: true }
  }

  /** 后台试听：两副模型听同一批录音，结论落回 run 行；成功与否都不换模（换模由人点）。 */
  private async runAudition(saved: TrainRunRecord, entries: Parameters<typeof auditionModelPair>[0]): Promise<void> {
    const dirs = ftModelDirs()
    try {
      const audition: FtAudition = await auditionModelPair(
        entries,
        { before: dirs.active, after: dirs.next },
        defaultAuditionTranscribe(finetuneEngine().id)
      )
      const patched = finishTrainRun(saved, { status: 'trained', audition })
      saveTrainRun(patched)
      this.run = patched
      this.record(`${auditionLine(audition)} · 采纳或跳过由你在面板上点`)
    } catch (err) {
      const patched = finishTrainRun(saved, {
        status: 'trained',
        auditionSkip: { at: Date.now(), auto: true, reason: `试听失败：${errorMessage(err)}` }
      })
      saveTrainRun(patched)
      this.run = patched
      this.record(`试听失败：${errorMessage(err)}（新模型已铺好，可在面板上直接采纳）`)
    }
  }

  /**
   * 收场的共同一段：结果补进这一轮并落库。
   * 正常收场与「应用退出」从这里分叉之前完全一样，区别只在要不要广播与通知——
   * 退出途中窗口正在销毁，所以这里刻意不广播。
   */
  private settle(patch: Parameters<typeof finishTrainRun>[1]): TrainRunRecord | null {
    if (!this.run) return null
    const saved = finishTrainRun(this.run, patch)
    saveTrainRun(saved)
    this.run = saved
    return saved
  }

  private finish(status: Extract<TrainTaskStatus, 'done' | 'failed' | 'stopped'>, code: number | null): void {
    // asr-ft 失败收场回写 run.json（成功标 trained 走链回调、转正标 applied 走 apply）；缺账本就跳过。
    if (status === 'failed' && this.request?.asrFt) markRunStatus(this.request.asrFt.data.runDir, 'failed')
    const failure =
      status === 'failed'
        ? this.sawOom()
          ? '失败：显存不足（CUDA OOM），关掉占卡程序再点一次'
          : this.lastErrorLine() === null
            ? `失败 (exit ${code ?? '?'})`
            : `失败 (exit ${code ?? '?'})：${this.lastErrorLine()}`
        : null
    // 先落库再换模：applyAsrFtModel 是按导出目录回库里找回这一轮记 applied 的，行还没写就翻不到牌。
    let saved: TrainRunRecord | null = null
    if (this.run) {
      saved = this.settle({
        status: status === 'done' ? 'trained' : status === 'stopped' ? 'stopped' : 'failed',
        error: failure,
        metrics: this.runMetrics(this.run)
      })
    }
    // 训练 + 导出都成功：先铺 .next 并用留出集试听（#105），有对比就停在「待试听」由人采纳或跳过；
    // 没有留出集可听就照旧自动换上，不让第一轮小数据训练卡在没人能判断的空档里。
    const promotion = status === 'done' && this.chained && this.run?.kind === 'asr-ft' ? this.auditionOrPromote(saved) : null
    const promoted = promotion?.result ?? null
    const awaiting = promotion?.awaiting === true
    // 换模自己会把那一轮翻成 applied；重读一次让内存里的记录与库一致。
    if (promoted?.ok && saved) saved = loadTrainRun(saved.id) ?? saved
    const stage =
      status === 'done'
        ? awaiting
          ? '完成（待试听：同一批留出集录音在两副模型上并排比）'
          : promoted
            ? promoted.ok
              ? '完成（已换上新模型）'
              : `完成，但换模失败：${promoted.error ?? '未知错误'}`
            : '完成'
        : (failure ?? '已停止')
    if (this.task) this.task = { ...this.task, status, endedAt: Date.now(), stage }
    // 收场结论也进日志文件：换模失败、权重平均兜底这类只有一行的判断，事后只能靠这一句复盘。
    this.record(stage)
    if (saved) {
      // 换模成功才清盘：只留当前这轮与下一轮的增量起点（见 docs/adr/asr-ft-run-retention.md）。
      // 异步做，不占收场这一步；清不掉也只是多占点盘，不影响已经换上的模型。
      if (promoted?.ok) {
        void pruneAsrFtRunDirs(saved.id)
          .then((removed) => {
            if (removed.length > 0) console.log('TRAIN_RUN_DIRS_PRUNED', removed.length)
          })
          .catch((err: unknown) => console.log('TRAIN_RUN_DIRS_PRUNE_FAILED', String(err)))
      }
      // 训练腿成功才算「这些录音训过了」：失败的 run 不动覆盖标记，下次还会进训练集。
      const ledger = this.request?.asrFt?.ledger
      if (status === 'done' && ledger) {
        markDatasetEntriesTrained(saved.id, ledger)
        // 收场也要回答同一个问题：这一轮吃掉了什么、账本里还剩多少（用户按这个决定要不要马上再训一轮）。
        const left = summarizePendingTakes({ entries: listDatasetEntries(), hasRun: true }).count
        this.record(
          `本轮训练 ${ledger.filter((entry) => entry.split === 'train').length} 条 + 验证 ${ledger.filter((entry) => entry.split === 'eval').length} 条；账本里还剩 ${left} 条待训`
        )
      }
      this.run = saved
      notifyRunEnd(saved)
    }
    this.child = null
    this.emit(true)
    this.drainQueue()
    if (!shouldPauseInference(this.status())) {
      this.io.holdInference(false)
      if (shouldResumeInference(this.status())) void this.resumeInference()
    }
  }

  /** T2：把 GV 推理拉回来；失败在窗口里明说，别让「怎么没声」变成悬案。 */
  private async resumeInference(): Promise<void> {
    if (this.task?.inference !== 'held') return
    const resumed = await this.io.resume()
    if (!this.task) return
    this.task = { ...this.task, inference: resumed ? 'released' : 'release-failed' }
    this.record(inferenceHoldLabel(resumed ? 'released' : 'release-failed'))
    this.emit(true)
  }
}

let manager: TrainManager | null = null

export function getTrainManager(): TrainManager {
  if (!manager) manager = new TrainManager()
  return manager
}

/** 已经有过任务的实例；退出收尾用，别为了「什么也没发生过」把单例凭空建出来。 */
export function trainManagerIfStarted(): TrainManager | null {
  return manager
}

