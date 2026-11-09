import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { app, Notification } from 'electron'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
import { ensureSovitsServer, pauseSovitsForTraining, setInferenceHold } from '../voice/sovits-server'
import { applyAsrFtModel, markRunStatus, pruneAsrFtRunDirs } from './asr-ft'
import {
  buildTrainRun,
  finishTrainRun,
  runKindLabel,
  runStatusLabel,
  type TrainRunParams,
  type TrainRunRecord
} from '@shared/train/run'
import { loadTrainRun, markDatasetEntriesTrained, saveDatasetLedger, saveTrainRun } from './run-store'
import { readAsrMetrics, readGvMetrics } from './run-metrics'

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
/** 训练日志落盘上限：一圈环形日志挡不住崩溃现场，磁盘这份才是事后唯一证据。 */
const TRAIN_LOG_MAX_BYTES = 4 * 1024 * 1024
let trainLogSize = -1

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
 * 训练子进程输出落盘（logs/train.log）：窗口里的环形日志一关就没，
 * 崩在加载模型还是第一步只能看这份。写不进去不能反过来影响训练。
 */
function appendTrainLog(text: string): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'train.log')
    if (trainLogSize < 0) trainLogSize = statSync(file, { throwIfNoEntry: false })?.size ?? 0
    if (trainLogSize > TRAIN_LOG_MAX_BYTES) {
      writeFileSync(file, '')
      trainLogSize = 0
    }
    const line = `[${new Date().toISOString()}] ${text}\n`
    appendFileSync(file, line, 'utf8')
    trainLogSize += Buffer.byteLength(line)
  } catch {
    // 日志失败不影响训练
  }
}

class TrainManager {
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
  onState(listener: (snapshot: TrainSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(): TrainSnapshot {
    return { task: this.task, logs: this.logs.slice(-120) }
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
    if (!gate.ok) return { ok: false, error: gate.reason }
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
    this.emit(true)
    if (shouldPauseInference(this.status()) && this.task) {
      const outcome = pauseSovitsForTraining()
      this.task = { ...this.task, inference: outcome === 'paused' ? 'held' : 'kept-off' }
      this.record(inferenceHoldLabel(outcome === 'paused' ? 'held' : 'kept-off'))
      this.emit(true)
    }
    // 训练占显存期间，朗读热键与试听都不许把 GV 拉回来——那等于把刚下的暂停命令撤销。
    setInferenceHold(true)

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
      startedAt: this.task?.startedAt
    })
    saveTrainRun(this.run)
    // 这次打包吃进去的录音随开训一起记账（split + 指纹），run 行上留一份冻结快照给续训对账；
    // 训练成功才标「已训」，见 finish。
    if (this.run.kind === 'asr-ft' && request.asrFt?.ledger) saveDatasetLedger(request.asrFt.ledger, this.run.id)
    this.spawnChild(plan.exe === 'node' ? (node ?? 'node') : plan.exe, plan)
    return { ok: true, error: null }
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
      const run = this.run
      const metrics =
        run.kind === 'asr-ft'
          ? readAsrMetrics(run.artifacts.runDir)
          : readGvMetrics(this.request?.gvResolved?.home, run.experiment)
      saved = finishTrainRun(run, {
        status: status === 'done' ? 'trained' : status === 'stopped' ? 'stopped' : 'failed',
        error: failure,
        metrics
      })
      saveTrainRun(saved)
    }
    // 训练 + 导出都成功就直接换上去：磁盘上只留一份微调模型，用户不必再点第二个按钮。
    const promoted = status === 'done' && this.chained && this.run?.kind === 'asr-ft' ? applyAsrFtModel() : null
    // 换模自己会把那一轮翻成 applied；重读一次让内存里的记录与库一致。
    if (promoted?.ok && saved) saved = loadTrainRun(saved.id) ?? saved
    const stage =
      status === 'done'
        ? promoted
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
      if (status === 'done' && ledger) markDatasetEntriesTrained(saved.id, ledger)
      this.run = saved
      notifyRunEnd(saved)
    }
    this.child = null
    this.emit(true)
    // 任务退干净就该恢复推理（T2 接线）；没停过（kept-off）不演恢复。
    setInferenceHold(false)
    if (shouldResumeInference(this.status())) void this.resumeInference()
  }

  /** T2：把 GV 推理拉回来；失败在窗口里明说，别让「怎么没声」变成悬案。 */
  private async resumeInference(): Promise<void> {
    if (this.task?.inference !== 'held') return
    const resumed = await ensureSovitsServer()
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

