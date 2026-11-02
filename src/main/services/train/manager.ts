import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  canStartTrain,
  deriveTrainPlan,
  normalizeTrainKind,
  parseTrainProgress,
  shouldResumeInference,
  type TrainLogLine,
  type TrainPlan,
  type TrainSnapshot,
  type TrainStartRequest,
  type TrainStartResult,
  type TrainTaskInfo,
  type TrainTaskKind,
  type TrainTaskStatus
} from '@shared/train'

/**
 * 训练任务管理器：同一时刻只允许一个训练进程（编排器约定）。
 * 拿到 @shared/train 推导出的计划就 spawn，stdout/stderr 全部进日志环，
 * 已知格式顺手解析成进度。推理互斥的执行（停 GV / 恢复 GV）在 T2 接线，
 * 这里先把「该不该让路」通过任务状态暴露出去。
 */

const LOG_RING_LIMIT = 500
/** 进度广播节流：真训练栈一秒几十行日志，不节流会把窗口渲染按住。 */
const BROADCAST_MIN_MS = 250

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

  start(request: TrainStartRequest, chain?: () => TrainPlan | null): TrainStartResult {
    const gate = canStartTrain(this.status())
    if (!gate.ok) return { ok: false, error: gate.reason }
    const kind: TrainTaskKind = normalizeTrainKind(request.kind)
    const plan = deriveTrainPlan({ kind, dataset: String(request.dataset ?? '') })
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
      endedAt: null
    }
    this.logs = []
    this.emit(true)

    this.chain = chain ?? null
    this.chained = false
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
      if (code === 0 && this.chain) {
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
      if (code === 0) this.finish('done', code)
      else this.finish('failed', code)
    })
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

  private finish(status: Extract<TrainTaskStatus, 'done' | 'failed' | 'stopped'>, code: number | null): void {
    const stage =
      status === 'done' ? (this.chained ? '完成（可应用新模型）' : '完成') : status === 'stopped' ? '已停止' : `失败 (exit ${code ?? '?'})`
    if (this.task) this.task = { ...this.task, status, endedAt: Date.now(), stage }
    this.child = null
    this.emit(true)
    // 任务退干净就该恢复推理；T2 把这行换成真的恢复调用。
    if (shouldResumeInference(this.status())) this.record('推理可恢复（T2 接线恢复调用）')
  }
}

let manager: TrainManager | null = null

export function getTrainManager(): TrainManager {
  if (!manager) manager = new TrainManager()
  return manager
}

