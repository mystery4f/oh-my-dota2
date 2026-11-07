// 训练窗口页：上半是任务开/停与日志，下半是 ASR 微调录音（T4a）。
// 决策（互斥、计划推导、进度解析、读稿解析）都在 shared/主进程，这里只是显示器 + 采样器。
import { advanceRecording, initialRecordingState, recordingKey, shouldKeepTake, takeLineId, type RecordingStepState } from '@shared/train/recording'
import { canStartTrain, inferenceHoldLabel, type TrainSnapshot } from '@shared/train/task'
import { encodeWav16k } from '@shared/wav'
import type { FtRecInfo, FtScriptGroup } from '@shared/ipc'
import { buildFtGroupProgress } from '@shared/train/dataset'
import {
  GV_DEFAULTS,
  GV_VERSION_DEFAULT,
  GV_VERSION_INFO,
  type GvDatasetJudgement,
  type GvVersion
} from '@shared/train/gv'
import type { TrainStartRequest } from '@shared/train/task'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const kindSel = $<HTMLSelectElement>('kind')
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
const gvError = $<HTMLDivElement>('gvError')
const ftOverview = $<HTMLElement>('ftOverview')
const gvDatasetSel = $<HTMLSelectElement>('gvDataset')
const gvDatasetInfo = $<HTMLElement>('gvDatasetInfo')
const gvVersionSel = $<HTMLSelectElement>('gvVersion')
const gvBatchInput = $<HTMLInputElement>('gvBatch')
const gvEpochsInput = $<HTMLInputElement>('gvEpochs')
const gvWebuiBtn = $<HTMLButtonElement>('gvWebui')
const gvNameInput = $<HTMLInputElement>('gvName')
const gvRegisterBtn = $<HTMLButtonElement>('gvRegister')
const gvHint = $<HTMLElement>('gvHint')

const STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  preparing: '准备中',
  running: '训练中',
  stopping: '停止中',
  done: '完成',
  failed: '失败',
  stopped: '已停止'
}
/** 上一次 render 画到的任务状态：只在跨进 done 的那一刻刷换模按钮，不每次广播都打 IPC。 */
let lastRenderedStatus: string | null = null

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
      task.inference ? inferenceHoldLabel(task.inference) : '',
      `用时：${elapsed}s`
    ].filter(Boolean)
    statusEl.textContent = pieces.join(' · ')
    statusEl.classList.toggle('error', task.status === 'failed')
  }
  // 日志尾巴自增长；在底部附近才自动跟随，往回翻历史时不拽人。
  const follow = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24
  logEl.textContent = snap.logs.map((line) => `${fmtTime(line.at)}  ${line.text}`).join('\n')
  if (follow) logEl.scrollTop = logEl.scrollHeight
  // 任务刚走到 done：刷一次换模状态，让「应用新模型」亮起来。
  if (task?.status === 'done' && lastRenderedStatus !== 'done') void refreshAsrft()
  lastRenderedStatus = task?.status ?? null
}

async function start(): Promise<void> {
  const kind = kindSel.value as 'demo' | 'asr-ft' | 'gv-gpt' | 'gv-sovits'
  const isGv = kind === 'gv-gpt' || kind === 'gv-sovits'
  const dataset = isGv ? gvDatasetSel.value : ''
  // 记住这单的选择，下次开窗自动填（setSettings 在主进程落盘）。
  // 数据集只有 GV 分支是真数据（实验目录名）；ASR 微调没有名字可选，目录名固定 ft-<时间戳>。
  void window.api.setSettings(isGv ? { trainKind: kind, trainDataset: dataset } : { trainKind: kind })
  const request: TrainStartRequest = { kind, dataset }
  // gv-*：数据集下拉就是实验名；备料/配置文件由主进程准备，缺口会原样报回。
  if (isGv) {
    request.gv = {
      version: gvVersionSel.value as GvVersion,
      batchSize: Number(gvBatchInput.value),
      epochs: Number(gvEpochsInput.value)
    }
  }
  const result = await window.api.trainStart(request)
  // 启动被拒时不弹任何东西，只改状态文字；落一行日志，否则「点了没反应」永远查不到原因
  console.log('[train-ft] start', kind, result.ok, result.error ?? '')
  if (!result.ok && result.error) {
    if (isGv) {
      gvError.textContent = result.error
      void refreshGvDatasets()
    } else {
      statusEl.textContent = result.error
      statusEl.classList.add('error')
    }
  }
}

async function stop(): Promise<void> {
  const result = await window.api.trainStop()
  if (!result.ok && result.error) {
    statusEl.textContent = result.error
    statusEl.classList.add('error')
  }
}


// ---------- GV（GPT-SoVITS）微调（T3） ----------

let gvDatasets: GvDatasetJudgement[] = []
let gvWebuiOpen = false

/** 版本下拉一次成型；六版全来自 shared 的 GV_VERSION_INFO，缺省 v2ProPlus。 */
function initGvVersionSel(): void {
  for (const [version, info] of Object.entries(GV_VERSION_INFO)) {
    const opt = document.createElement('option')
    opt.value = version
    opt.textContent = version
    opt.title = info.s2PretrainedG
    gvVersionSel.appendChild(opt)
  }
  gvVersionSel.value = GV_VERSION_DEFAULT
}

/** 批/轮随任务类型走默认（GV_DEFAULTS 照抄 webui 的保守值）。 */
function applyGvDefaults(): void {
  const def = kindSel.value === 'gv-gpt' ? GV_DEFAULTS['gv-gpt'] : GV_DEFAULTS['gv-sovits']
  gvBatchInput.value = String(def.batchSize)
  gvEpochsInput.value = String(def.epochs)
}

function applyGvDatasetInfo(): void {
  const picked = gvDatasets.find((d) => d.expName === gvDatasetSel.value)
  gvDatasetInfo.textContent = picked
    ? picked.ready
      ? '备料齐全，可开训'
      : `缺：${picked.missing.join('、')}`
    : '没有实验；打开 webui 备好数据集后点刷新'
}

async function refreshGvDatasets(): Promise<void> {
  try {
    gvDatasets = await window.api.trainGvDatasets()
  } catch (err) {
    gvError.textContent = `备料清单读取失败（${String(err)}）`
    return
  }
  gvError.textContent = ''
  const previous = gvDatasetSel.value
  gvDatasetSel.replaceChildren()
  for (const d of gvDatasets) {
    const opt = document.createElement('option')
    opt.value = d.expName
    opt.textContent = d.ready ? d.expName : `${d.expName}（备料不全）`
    gvDatasetSel.appendChild(opt)
  }
  if (previous && gvDatasets.some((d) => d.expName === previous)) gvDatasetSel.value = previous
  applyGvDatasetInfo()
}

/** webui 开关：切分、打标注、备料三步都在 webui 里做，这里只负责开关与清单刷新。 */
async function toggleGvWebui(): Promise<void> {
  gvWebuiBtn.disabled = true
  const result = await window.api.trainGvWebui({ open: !gvWebuiOpen })
  gvWebuiBtn.disabled = false
  if (!result.ok) {
    gvError.textContent = result.error ?? 'webui 操作失败'
    return
  }
  gvWebuiOpen = !gvWebuiOpen
  gvWebuiBtn.textContent = gvWebuiOpen ? '关闭 webui' : '打开 webui'
  if (gvWebuiOpen) setTimeout(() => void refreshGvDatasets(), 3000)
}

/** 产物登记：把当前实验两腿的最新权重 + 参考音频收进音色包库。 */
async function registerGv(): Promise<void> {
  const name = gvNameInput.value.trim()
  if (!name) {
    gvHint.textContent = '先填音色名'
    return
  }
  gvRegisterBtn.disabled = true
  const result = await window.api.trainGvRegister({ expName: gvDatasetSel.value, version: gvVersionSel.value, name })
  gvRegisterBtn.disabled = false
  gvHint.textContent = result.ok ? `已注册「${name}」，语音出面板里就能选` : (result.error ?? '注册失败')
}
// ---------- ASR 微调录音（T4a） ----------

let groups: FtScriptGroup[] = []
const recs = new Map<string, FtRecInfo>()
let currentGroupId = ''
let currentLineNo = 0 // lines 模式：当前句号；free 模式：0 表示还没选段
let recording = false
const chunks: Float32Array[] = [] // 当前这次录音的原始 PCM 段

let recState: RecordingStepState = initialRecordingState(0)

function currentGroup(): FtScriptGroup | null {
  return groups.find((g) => g.id === currentGroupId) ?? null
}

/** 组内完成数（free 组数已完成段）。 */
function doneCount(group: FtScriptGroup): number {
  if (group.mode === 'free') {
    let n = 0
    while (recs.has(recordingKey(group.id, group.mode, n + 1))) n += 1
    return n
  }
  return group.lines.filter((line) => recs.has(recordingKey(group.id, group.mode, line.no))).length
}

/** T4 组总览：一句汇总（已录段数/总时长/逐句组完成度）+ 只列没录满的组（缺句清单）。 */
function renderFtOverview(): void {
  const progress = buildFtGroupProgress(
    groups.map((g) => ({ id: g.id, mode: g.mode, lines: g.lines.map((l) => ({ no: l.no, text: l.text })) })),
    (key) => recs.get(key)?.durationMs ?? null
  )
  const takes = progress.reduce((n, p) => n + p.done, 0)
  const totalMs = progress.reduce((n, p) => n + p.durationMs, 0)
  const linesGroups = progress.filter((p) => p.mode === 'lines')
  const completeGroups = linesGroups.filter((p) => p.missing.length === 0).length
  const parts = [`已录 ${takes} 段 · ${Math.round(totalMs / 1000)}s · 逐句组完成 ${completeGroups}/${linesGroups.length}`]
  for (const p of linesGroups.filter((x) => x.missing.length > 0)) {
    parts.push(`${p.id} 缺 ${p.missing.map((no) => takeLineId('lines', no)).join('、')}`)
  }
  ftOverview.textContent = parts.join(' ｜ ')
}

/** 当前要录的那句：lines 模式取第一个没录的句号（都录完就停在最后一句），free 模式下一段。 */
function pickCurrent(): void {
  const group = currentGroup()
  if (!group) return
  if (group.mode === 'free') {
    currentLineNo = doneCount(group) + 1
  } else {
    const missing = group.lines.find((line) => !recs.has(recordingKey(group.id, group.mode, line.no)))
    currentLineNo = (missing ?? group.lines[group.lines.length - 1]).no
  }
}

function renderFt(): void {
  const group = currentGroup()
  if (!group) return
  renderFtOverview()
  const done = doneCount(group)
  const total = group.mode === 'free' ? Math.max(done, 20) : group.lines.length
  ftGroupInfo.textContent = `${group.id} ${group.title} · 已录 ${done}/${total}`
  // 句号条：lines 模式逐句一颗 chip；free 模式显示已录段 + 「+自由说」。
  ftLines.textContent = ''
  if (group.mode === 'free') {
    for (let i = 1; i <= done; i += 1) {
      const chip = document.createElement('span')
      chip.className = 'chip done'
      chip.textContent = recordingKey(group.id, group.mode, i)
      chip.addEventListener('click', () => {
        currentLineNo = i
        renderFt()
      })
      ftLines.appendChild(chip)
    }
    const chip = document.createElement('span')
    chip.className = done === currentLineNo - 1 ? 'chip current' : 'chip'
    chip.textContent = `+ ${recordingKey(group.id, group.mode, done + 1)}（自由说）`
    chip.addEventListener('click', () => {
      currentLineNo = done + 1
      renderFt()
    })
    ftLines.appendChild(chip)
    ftText.textContent = group.note || '自由说：用平时开黑的语气随便讲一段（10–20 秒）。'
  } else {
    for (const line of group.lines) {
      const key = recordingKey(group.id, group.mode, line.no)
      const chip = document.createElement('span')
      chip.className = key === recordingKey(group.id, group.mode, currentLineNo) ? 'chip current' : recs.has(key) ? 'chip done' : 'chip'
      chip.textContent = String(line.no)
      chip.title = line.text
      chip.addEventListener('click', () => {
        currentLineNo = line.no
        renderFt()
      })
      ftLines.appendChild(chip)
    }
    const line = group.lines.find((item) => item.no === currentLineNo) ?? group.lines[0]
    ftText.textContent = line?.text ?? ''
  }
  const key = recordingKey(group.id, group.mode, currentLineNo)
  ftReplayBtn.disabled = !recs.has(key)
  ftAsrBtn.disabled = !recs.has(key)
  ftRecBtn.disabled = recording
  ftStopRecBtn.disabled = !recording
}

async function loadScriptAndRecs(): Promise<void> {
  const [script, list] = await Promise.all([window.api.ftScriptRead(), window.api.ftRecList()])
  groups = script.groups
  ftError.textContent = script.error ?? ''
  recs.clear()
  console.log('[train-ft] script groups=', groups.length, 'error=', script.error ?? 'none', 'recs=', list.length)
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
let recRate = 48000 // 开录时从 AudioContext 记下，finishRecording 会把 ctx 置 null

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
  console.log('[train-ft] save chunks=', chunks.length, 'durationMs=', durationMs)
  // 收尾判定收进共享缝 shouldKeepTake：太短丢；全程没探到说话（哑麦/漏探）的静音段也丢。
  const verdict = shouldKeepTake({ durationMs, speechSeen: recState.speechSeen })
  if (!verdict.keep) {
    ftHint.textContent = verdict.reason ?? ''
    chunks.length = 0
    renderFt()
    return
  }
  const base64 = encodeWav16k(chunks, rate)
  chunks.length = 0
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const line = takeLineId(group.mode, currentLineNo)
  try {
    const info = await window.api.ftRecSave(group.id, line, bytes)
    recs.set(info.key, info)
    console.log('[train-ft] saved', info.key)
    ftHint.textContent = `已存 ${info.key}（${(info.durationMs / 1000).toFixed(1)}s）`
    pickCurrent()
  } catch (err) {
    ftHint.textContent = `保存失败：${String(err)}`
    console.log('[train-ft] save failed:', String(err))
  }
  renderFt()
}

async function beginRecording(): Promise<void> {
  if (recording || !currentGroup()) {
    console.log('[train-ft] begin skipped recording=', recording, 'group=', currentGroup()?.id ?? 'null')
    return
  }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })
  } catch (err) {
    ftHint.textContent = `拿不到麦克风：${String(err)}`
    console.log('[train-ft] mic denied:', String(err))
    return
  }
  recording = true
  console.log('[train-ft] begin recording')
  chunks.length = 0
  recState = initialRecordingState(Date.now())
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
      const step = advanceRecording(recState, { rms, nowMs: Date.now() })
      recState = step.state
      if (step.stop) void stopRecording(step.reason ?? '')
    }
    recCtx.createMediaStreamSource(recStream).connect(recNode)
    console.log('[train-ft] graph ok rate=', recRate)
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
  console.log('[train-ft] stop reason=', reason || 'manual', 'chunks=', chunks.length)
  ftHint.textContent = reason ? `${reason}，保存中…` : '保存中…'
  await saveChunks()
}

async function replay(): Promise<void> {
  const group = currentGroup()
  if (!group) return
  const key = recordingKey(group.id, group.mode, currentLineNo)
  if (!recs.has(key)) return
  const line = takeLineId(group.mode, currentLineNo)
  const bytes = await window.api.ftRecRead(group.id, line)
  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' }))
  const audio = new Audio(url)
  audio.addEventListener('ended', () => URL.revokeObjectURL(url))
  void audio.play()
}

// 识别测试：把当前这条录音喂给面板选的识别引擎，和稿子原文对比（标点/空白不参与比对）。
const ftAsrBtn = $<HTMLButtonElement>('ftAsr')
const ftAsrResult = $<HTMLElement>('ftAsrResult')
const normalizeForCompare = (text: string): string => text.replace(/[\s\p{P}]+/gu, '')

async function testAsr(): Promise<void> {
  const group = currentGroup()
  if (!group || ftAsrBtn.disabled) return
  const line = takeLineId(group.mode, currentLineNo)
  ftAsrBtn.disabled = true
  ftAsrResult.textContent = '识别中…'
  try {
    const result = await window.api.ftRecAsr(group.id, line)
    if (!result.ok) {
      ftAsrResult.textContent = `识别失败：${result.error ?? '未知错误'}`
      return
    }
    const expected = group.mode === 'free' ? '' : group.lines.find((item) => item.no === currentLineNo)?.text ?? ''
    const match = expected !== '' && normalizeForCompare(expected) === normalizeForCompare(result.text)
    const head = expected === '' ? '识别' : match ? '✓ 一致' : '✕ 不一致'
    ftAsrResult.textContent = `${head}｜稿子：${expected || '（自由说，无标准答案）'}｜识别：${result.text}`
    console.log('[train-ft] asr test', line, 'match=', match, 'text=', result.text)
  } catch (err) {
    ftAsrResult.textContent = `识别失败：${String(err)}`
  } finally {
    renderFt()
  }
}

// 一键打包：已录句子 × 稿子 → 官方微调 JSONL（train/eval 两份，训脚本直接吃）。
async function packDataset(): Promise<void> {
  ftAsrResult.textContent = '打包中…'
  try {
    const result = await window.api.ftDatasetPrepare()
    ftAsrResult.textContent = result.ok
      ? `已打包：训练 ${result.trainCount} 条 / 验证 ${result.evalCount} 条 → ${result.trainPath}`
      : `打包失败：${result.error ?? '未知错误'}`
    console.log('[train-ft] pack', result.ok, result.trainCount, result.evalCount)
  } catch (err) {
    ftAsrResult.textContent = `打包失败：${String(err)}`
  }
}


// ---------- ASR 微调闭环（T5）：一键微调 + 换模/回滚 ----------

const ftEnvEl = $<HTMLElement>('ftEnv')
const ftInstallBtn = $<HTMLButtonElement>('ftInstall')
const ftApplyBtn = $<HTMLButtonElement>('ftApply')
const ftRollbackBtn = $<HTMLButtonElement>('ftRollback')
/** 安装轮询句柄：安装进行中每 1.5s 刷一次环境行。 */
let installTimer: ReturnType<typeof setInterval> | null = null

/** 环境行 + 换模按钮：跟着主进程的检测走（缺什么念什么，有导出产物才允许应用）。 */
async function refreshAsrft(): Promise<void> {
  try {
    const status = await window.api.ftAsrftStatus()
    const install = status.install
    if (install?.running) {
      ftEnvEl.textContent = `微调环境：${install.stage} ${install.progress}%（断网也能续，挂了再点一次）`
      if (!installTimer) installTimer = setInterval(() => void refreshAsrft(), 1500)
    } else {
      if (installTimer) {
        clearInterval(installTimer)
        installTimer = null
        if (install) ftAsrResult.textContent = install.error ? `环境安装失败：${install.error}` : '训练环境就绪'
      }
      ftEnvEl.textContent = status.env.ok
        ? `微调环境：就绪（${status.env.envRoot}）`
        : `微调环境缺：${status.env.gaps.join('；')}`
    }
    ftInstallBtn.hidden = Boolean(status.env.ok) || Boolean(install?.running)
    ftApplyBtn.disabled = !status.swap.lastExportDir || Boolean(install?.running)
    ftApplyBtn.title = status.swap.lastExportDir ? `应用 ${status.swap.lastExportDir}` : '先跑一次「微调并替换模型」'
    ftRollbackBtn.disabled = !status.swap.bakExists
  } catch (err) {
    ftEnvEl.textContent = `微调环境：状态读取失败（${String(err)}）`
  }
}

/** 一键安装：启动后立刻转轮询；装完或失败由 refreshAsrft 收尾。 */
async function startInstall(): Promise<void> {
  ftInstallBtn.disabled = true
  ftAsrResult.textContent = '开始安装训练环境（uv + Python + 依赖 + 底模，全程国内镜像，可断点续传）'
  await window.api.ftAsrftInstall()
  await refreshAsrft()
  ftInstallBtn.disabled = false
}

/** 一键微调：打包 → 训练 → 导出是一个任务，跑完点「应用新模型」转正。 */
async function startFt(): Promise<void> {
  kindSel.value = 'asr-ft'
  // 66 epoch × 10 步 ≈ 660 步；实测 3.6 s/步（4060 8G），约 40 分钟，导出另算（CPU）。
  ftAsrResult.textContent = '已开跑：打包 → 训练 66 epoch（约 40 分钟，看显卡）→ 导出 ONNX；完成后点「应用新模型」'
  await start()
}

async function applyModel(): Promise<void> {
  ftApplyBtn.disabled = true
  const result = await window.api.ftAsrftApply()
  ftAsrResult.textContent = result.ok ? '新模型已转正，下一句识别就用它' : result.error ?? '应用失败'
  await refreshAsrft()
}

async function rollbackModel(): Promise<void> {
  const result = await window.api.ftAsrftRollback()
  ftAsrResult.textContent = result.ok ? '已回滚到上一版模型' : result.error ?? '回滚失败'
  await refreshAsrft()
}
async function init(): Promise<void> {
  initGvVersionSel()
  applyGvDefaults()
  await refreshGvDatasets()
  await refreshAsrft()
  const settings = await window.api.getSettings()
  kindSel.value = settings.trainKind
  render(await window.api.trainSnapshot())
  window.api.onTrainState(render)
  await loadScriptAndRecs()
}

// 元素缺失（比如页面文件和脚本版本错开）就跳过对应监听并打日志，别让整个模块静默死掉。
function on(id: string, event: string, handler: () => void): void {
  const el = document.getElementById(id)
  if (!el) {
    console.error(`[train] 缺元素 #${id}，${event} 监听没挂上（页面/脚本版本不一致？）`)
    return
  }
  el.addEventListener(event, handler)
}

on('start', 'click', () => void start())
on('stop', 'click', () => void stop())
on('ftGroup', 'change', () => selectGroup(ftGroupSel.value))
on('ftRec', 'click', () => void beginRecording())
on('ftStopRec', 'click', () => void stopRecording())
on('ftReplay', 'click', () => void replay())
on('ftAsr', 'click', () => void testAsr())
on('ftPack', 'click', () => void packDataset())
on('ftInstall', 'click', () => void startInstall())
on('startFt', 'click', () => void startFt())
on('ftApply', 'click', () => void applyModel())
on('ftRollback', 'click', () => void rollbackModel())
on('gvRefresh', 'click', () => void refreshGvDatasets())
on('gvDataset', 'change', applyGvDatasetInfo)
on('gvWebui', 'click', () => void toggleGvWebui())
on('gvRegister', 'click', () => void registerGv())
on('kind', 'change', applyGvDefaults)
  console.log('[train-ft] listeners attached')
// 空格开停录音（焦点不在输入框/下拉时），念稿时不用伸手点鼠标。
window.addEventListener('keydown', (event) => {
  const tag = (event.target as HTMLElement | null)?.tagName ?? ''
  if (event.code !== 'Space' || tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON') return
  event.preventDefault()
  void (recording ? stopRecording() : beginRecording())
})
void init()
