// 训练窗口页：拉快照 + 订阅广播，把任务状态画出来；开/停只是把请求交给主进程。
// 决策（互斥、计划推导、进度解析）都在 @shared/train 和主进程 manager，这里只是显示器。
import { canStartTrain, type TrainSnapshot } from '@shared/train'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const kindSel = $<HTMLSelectElement>('kind')
const datasetInput = $<HTMLInputElement>('dataset')
const startBtn = $<HTMLButtonElement>('start')
const stopBtn = $<HTMLButtonElement>('stop')
const bar = $<HTMLDivElement>('bar')
const statusEl = $<HTMLDivElement>('status')
const logEl = $<HTMLPreElement>('log')

const STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  preparing: '准备中',
  running: '训练中',
  stopping: '停止中',
  done: '完成',
  failed: '失败',
  stopped: '已停止'
}

function fmtTime(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function render(snap: TrainSnapshot): void {
  const task = snap.task
  const gate = canStartTrain(task?.status ?? null)
  startBtn.disabled = !gate.ok
  stopBtn.disabled = !(task && (task.status === 'preparing' || task.status === 'running'))
  if (!task) {
    bar.style.width = '0'
    statusEl.textContent = '没有任务'
    statusEl.classList.remove('error')
  } else {
    bar.style.width = `${Math.max(0, task.progress)}%`
    const elapsed = Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000)
    const pieces = [
      `状态：${STATUS_LABEL[task.status] ?? task.status}`,
      task.progress >= 0 ? `进度：${task.progress}%` : '进度：—',
      task.stage ? `阶段：${task.stage}` : '',
      `用时：${elapsed}s`
    ].filter(Boolean)
    statusEl.textContent = pieces.join(' · ')
    statusEl.classList.toggle('error', task.status === 'failed')
  }
  // 日志尾巴自增长；在底部附近才自动跟随，往回翻历史时不拽人。
  const follow = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24
  logEl.textContent = snap.logs.map((line) => `${fmtTime(line.at)}  ${line.text}`).join('\n')
  if (follow) logEl.scrollTop = logEl.scrollHeight
}

async function start(): Promise<void> {
  const kind = kindSel.value as 'demo' | 'asr-ft' | 'gv-gpt' | 'gv-sovits'
  const dataset = datasetInput.value.trim()
  // 记住这单的选择，下次开窗自动填（setSettings 在主进程落盘）。
  void window.api.setSettings({ trainKind: kind, trainDataset: dataset })
  const result = await window.api.trainStart({ kind, dataset })
  if (!result.ok && result.error) {
    statusEl.textContent = result.error
    statusEl.classList.add('error')
  }
}

async function stop(): Promise<void> {
  const result = await window.api.trainStop()
  if (!result.ok && result.error) {
    statusEl.textContent = result.error
    statusEl.classList.add('error')
  }
}

async function init(): Promise<void> {
  const settings = await window.api.getSettings()
  kindSel.value = settings.trainKind
  datasetInput.value = settings.trainDataset
  render(await window.api.trainSnapshot())
  window.api.onTrainState(render)
}

startBtn.addEventListener('click', () => void start())
stopBtn.addEventListener('click', () => void stop())
void init()
