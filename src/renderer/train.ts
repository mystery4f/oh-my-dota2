// 训练窗口页：上半是任务开/停与日志，下半是 ASR 微调录音（T4a）。
// 决策（互斥、计划推导、进度解析、读稿解析）都在 shared/主进程，这里只是显示器 + 采样器。
import { canStartTrain, type TrainSnapshot } from '@shared/train'
import { encodeWav16k } from '@shared/wav'
import type { FtRecInfo, FtScriptGroup } from '@shared/ipc'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const kindSel = $<HTMLSelectElement>('kind')
const datasetInput = $<HTMLInputElement>('dataset')
const startBtn = $<HTMLButtonElement>('start')
const stopBtn = $<HTMLButtonElement>('stop')
const bar = $<HTMLDivElement>('bar')
const statusEl = $<HTMLDivElement>('status')
const logEl = $<HTMLPreElement>('log')
const ftGroupSel = $<HTMLSelectElement>('ftGroup')
const ftGroupInfo = $<HTMLElement>('ftGroupInfo')
const ftLines = $<HTMLDivElement>('ftLines')
const ftText = $<HTMLDivElement>('ftText')
const ftRecBtn = $<HTMLButtonElement>('ftRec')
const ftStopRecBtn = $<HTMLButtonElement>('ftStopRec')
const ftReplayBtn = $<HTMLButtonElement>('ftReplay')
const ftHint = $<HTMLElement>('ftHint')
const ftError = $<HTMLDivElement>('ftError')

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

// ---------- ASR 微调录音（T4a） ----------

let groups: FtScriptGroup[] = []
const recs = new Map<string, FtRecInfo>()
let currentGroupId = ''
let currentLineNo = 0 // lines 模式：当前句号；free 模式：0 表示还没选段
let recording = false

const lineKey = (groupId: string, no: number): string => `${groupId}-L${String(no).padStart(2, '0')}`
const takeKey = (groupId: string, no: number): string => `${groupId}-T${String(no).padStart(2, '0')}`

function currentGroup(): FtScriptGroup | null {
  return groups.find((g) => g.id === currentGroupId) ?? null
}

/** 组内完成数（free 组数已完成段）。 */
function doneCount(group: FtScriptGroup): number {
  if (group.mode === 'free') {
    let n = 0
    while (recs.has(takeKey(group.id, n + 1))) n += 1
    return n
  }
  return group.lines.filter((line) => recs.has(lineKey(group.id, line.no))).length
}

/** 当前要录的那句：lines 模式取第一个没录的句号（都录完就停在最后一句），free 模式下一段。 */
function pickCurrent(): void {
  const group = currentGroup()
  if (!group) return
  if (group.mode === 'free') {
    currentLineNo = doneCount(group) + 1
  } else {
    const missing = group.lines.find((line) => !recs.has(lineKey(group.id, line.no)))
    currentLineNo = (missing ?? group.lines[group.lines.length - 1]).no
  }
}

function renderFt(): void {
  const group = currentGroup()
  if (!group) return
  const done = doneCount(group)
  const total = group.mode === 'free' ? Math.max(done, 20) : group.lines.length
  ftGroupInfo.textContent = `${group.id} ${group.title} · 已录 ${done}/${total}`
  // 句号条：lines 模式逐句一颗 chip；free 模式显示已录段 + 「+自由说」。
  ftLines.textContent = ''
  if (group.mode === 'free') {
    for (let i = 1; i <= done; i += 1) {
      const chip = document.createElement('span')
      chip.className = 'chip done'
      chip.textContent = takeKey(group.id, i)
      chip.addEventListener('click', () => {
        currentLineNo = i
        renderFt()
      })
      ftLines.appendChild(chip)
    }
    const chip = document.createElement('span')
    chip.className = done === currentLineNo - 1 ? 'chip current' : 'chip'
    chip.textContent = `+ ${takeKey(group.id, done + 1)}（自由说）`
    chip.addEventListener('click', () => {
      currentLineNo = done + 1
      renderFt()
    })
    ftLines.appendChild(chip)
    ftText.textContent = group.note || '自由说：用平时开黑的语气随便讲一段（10–20 秒）。'
  } else {
    for (const line of group.lines) {
      const key = lineKey(group.id, line.no)
      const chip = document.createElement('span')
      chip.className = key === lineKey(group.id, currentLineNo) ? 'chip current' : recs.has(key) ? 'chip done' : 'chip'
      chip.textContent = String(line.no)
      chip.title = line.text
      chip.addEventListener('click', () => {
        currentLineNo = line.no
        renderFt()
      })
      ftLines.appendChild(chip)
    }
    const line = group.lines.find((item) => item.no === currentLineNo) ?? group.lines[0]
    ftText.textContent = line ? `${line.no}. ${line.text}` : ''
  }
  const key = group.mode === 'free' ? takeKey(group.id, currentLineNo) : lineKey(group.id, currentLineNo)
  ftReplayBtn.disabled = !recs.has(key)
  ftRecBtn.disabled = recording
  ftStopRecBtn.disabled = !recording
}

async function loadScriptAndRecs(): Promise<void> {
  const [script, list] = await Promise.all([window.api.ftScriptRead(), window.api.ftRecList()])
  groups = script.groups
  ftError.textContent = script.error ?? ''
  recs.clear()
  for (const info of list) recs.set(info.key, info)
  ftGroupSel.textContent = ''
  for (const group of groups) {
    const option = document.createElement('option')
    option.value = group.id
    option.textContent = `${group.id} ${group.title}`
    ftGroupSel.appendChild(option)
  }
  if (groups.length > 0) {
    currentGroupId = groups[0].id
    pickCurrent()
  }
  renderFt()
}

function selectGroup(id: string): void {
  currentGroupId = id
  pickCurrent()
  renderFt()
}

// 采样状态（与 overlay 的语音采集同款约束，训练数据和推理听到的一致）。
let recStream: MediaStream | null = null
let recCtx: AudioContext | null = null
let recNode: ScriptProcessorNode | null = null
const RMS_THRESHOLD = 0.012
let recRate = 48000 // 开录时从 AudioContext 记下，finishRecording 会把 ctx 置 null
const QUIET_MS_TO_STOP = 1200
const MIN_MS = 400
const MAX_MS = 20000

function finishRecording(): void {
  recNode?.disconnect()
  recStream?.getTracks().forEach((track) => track.stop())
  void recCtx?.close()
  recNode = null
  recStream = null
  recCtx = null
  recording = false
  ftRecBtn.disabled = false
  ftStopRecBtn.disabled = true
}

async function saveChunks(): Promise<void> {
  const group = currentGroup()
  if (!group) return
  const rate = recRate
  const durationMs = Math.round((chunks.reduce((sum, c) => sum + c.length, 0) / rate) * 1000)
  if (durationMs < MIN_MS) {
    ftHint.textContent = `太短（${durationMs}ms），丢弃了——重新点录制`
    chunks.length = 0
    renderFt()
    return
  }
  const base64 = encodeWav16k(chunks, rate)
  chunks.length = 0
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const line = group.mode === 'free' ? `T${String(currentLineNo).padStart(2, '0')}` : `L${String(currentLineNo).padStart(2, '0')}`
  try {
    const info = await window.api.ftRecSave(group.id, line, bytes)
    recs.set(info.key, info)
    ftHint.textContent = `已存 ${info.key}（${(info.durationMs / 1000).toFixed(1)}s）`
    pickCurrent()
  } catch (err) {
    ftHint.textContent = `保存失败：${String(err)}`
  }
  renderFt()
}

async function beginRecording(): Promise<void> {
  if (recording || !currentGroup()) return
  try {
    recStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })
  } catch (err) {
    ftHint.textContent = `拿不到麦克风：${String(err)}`
    return
  }
  recording = true
  chunks.length = 0
  const startedAt = Date.now()
  let speechSeen = false
  let quietSince = 0
  ftHint.textContent = '录音中…'
  renderFt()
  try {
    recCtx = new AudioContext()
    recRate = recCtx.sampleRate
    recNode = recCtx.createScriptProcessor(4096, 1, 1)
    recNode.onaudioprocess = (event): void => {
      const input = event.inputBuffer.getChannelData(0)
      chunks.push(new Float32Array(input))
      let energy = 0
      for (const sample of input) energy += sample * sample
      const rms = Math.sqrt(energy / input.length)
      if (rms >= RMS_THRESHOLD) {
        speechSeen = true
        quietSince = 0
      } else if (speechSeen) {
        if (!quietSince) quietSince = Date.now()
        // 说完连续安静 1.2 秒就自动停（读稿节奏就是句间停一秒）。
        if (Date.now() - quietSince >= QUIET_MS_TO_STOP) void stopRecording('自动停')
      }
      if (Date.now() - startedAt >= MAX_MS) void stopRecording('到 20s 上限')
    }
    recCtx.createMediaStreamSource(recStream).connect(recNode)
    recNode.connect(recCtx.destination)
  } catch (err) {
    // 图建不起来就把状态退干净，别留下「录音中…」的僵尸态。
    finishRecording()
    chunks.length = 0
    ftHint.textContent = `录音初始化失败：${String(err)}`
    renderFt()
    return
  }
}

async function stopRecording(reason = ''): Promise<void> {
  if (!recording) return
  finishRecording()
  ftHint.textContent = reason ? `${reason}，保存中…` : '保存中…'
  await saveChunks()
}

async function replay(): Promise<void> {
  const group = currentGroup()
  if (!group) return
  const key = group.mode === 'free' ? takeKey(group.id, currentLineNo) : lineKey(group.id, currentLineNo)
  if (!recs.has(key)) return
  const line = group.mode === 'free' ? `T${String(currentLineNo).padStart(2, '0')}` : `L${String(currentLineNo).padStart(2, '0')}`
  const bytes = await window.api.ftRecRead(group.id, line)
  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' }))
  const audio = new Audio(url)
  audio.addEventListener('ended', () => URL.revokeObjectURL(url))
  void audio.play()
}

async function init(): Promise<void> {
  const settings = await window.api.getSettings()
  kindSel.value = settings.trainKind
  datasetInput.value = settings.trainDataset
  render(await window.api.trainSnapshot())
  window.api.onTrainState(render)
  await loadScriptAndRecs()
}

startBtn.addEventListener('click', () => void start())
stopBtn.addEventListener('click', () => void stop())
ftGroupSel.addEventListener('change', () => selectGroup(ftGroupSel.value))
ftRecBtn.addEventListener('click', () => void beginRecording())
ftStopRecBtn.addEventListener('click', () => void stopRecording())
ftReplayBtn.addEventListener('click', () => void replay())
// 空格开停录音（焦点不在输入框/下拉时），念稿时不用伸手点鼠标。
window.addEventListener('keydown', (event) => {
  const tag = (event.target as HTMLElement | null)?.tagName ?? ''
  if (event.code !== 'Space' || tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON') return
  event.preventDefault()
  void (recording ? stopRecording() : beginRecording())
})
void init()
