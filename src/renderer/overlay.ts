import type { OverlayStatus } from '@shared/ipc'
import { moveBy, resizeFromLeft, resizeFromRight } from '@shared/overlay-geometry'
import { encodeWav16k } from '@shared/wav'

/** 头像打包进仓库：中国网络直连 Steam CDN 会超时，运行时下载靠不住。 */
const HERO_ICONS = import.meta.glob('./assets/heroes/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>
const heroUrls = new Map<string, string>()
for (const [file, url] of Object.entries(HERO_ICONS)) {
  heroUrls.set(file.slice(file.lastIndexOf('/') + 1, -'.png'.length), url)
}

const MAX_ROWS = 40

const list = document.getElementById('list') as HTMLElement
const pill = document.getElementById('pill') as HTMLElement
const hint = document.getElementById('hint') as HTMLElement
const replyBar = document.getElementById('reply') as HTMLElement
const replyInput = document.getElementById('reply-input') as HTMLTextAreaElement
const replyHint = document.getElementById('reply-hint') as HTMLElement

const REPLY_HINT = 'Enter 发送 · Shift+Enter 换行 · Esc 关闭（草稿会保留）'
/** M7f: 浮层回复草稿落盘 —— Esc、点击穿透、窗口隐藏都不丢，只有发送成功才清空。 */
const REPLY_DRAFT_KEY = 'oh-my-dota2.overlayDraft'

const rows = new Map<string, HTMLElement>()
/** 超过这么多行，靠后的旧行渐隐：既保留上下文，又不会把下面半屏糊满。 */
const FADE_AFTER = 12

function markOldRows(): void {
  const all = Array.from(list.children) as HTMLElement[]
  all.forEach((row, index) => {
    row.classList.toggle('old', all.length - 1 - index >= FADE_AFTER)
  })
}

function appendRow(
  original: string,
  translated: string | null,
  sent = false,
  id?: string,
  pending = false,
  hero?: string,
  cached = false,
  error?: string
): void {
  hint.remove()
  const row = document.createElement('div')
  row.className = sent ? 'row sent' : pending ? 'row pending' : 'row'
  const url = hero ? heroUrls.get(hero) : undefined
  const orig = document.createElement('div')
  orig.className = 'orig'
  // 没有头像资源就退回文字名，宁可难看也不能没有说话人。
  orig.textContent = hero && url === undefined ? `[${hero}] ${original}` : original
  if (hero && url !== undefined) {
    row.classList.add('has-hero')
    const icon = document.createElement('img')
    icon.className = 'hero-img'
    icon.src = url
    icon.alt = hero
    icon.title = hero
    row.appendChild(icon)
  }
  row.appendChild(orig)
  setTranslation(row, translated, cached, error)
  list.appendChild(row)
  // 新行亮一下，不用一直盯着也知道来了消息。
  row.classList.add('fresh')
  setTimeout(() => row.classList.remove('fresh'), 400)
  markOldRows()
  if (id !== undefined) rows.set(id, row)
  while (list.childElementCount > MAX_ROWS) {
    const first = list.firstElementChild
    if (first === null) break
    for (const [key, value] of rows) if (value === first) rows.delete(key)
    first.remove()
  }
}

function setTranslation(
  row: HTMLElement,
  translated: string | null,
  cached = false,
  error?: string
): void {
  const existing = row.querySelector('.trans')
  if (!translated) {
    // 没有译文只剩两种可能：还在翻（保持 pending 的省略号，不画新东西），或者翻失败了。
    // 后者必须画出来——「一直在翻」和「已经废了」看起来一模一样，是最糟的沉默。
    if (!error) {
      existing?.remove()
      return
    }
    const failed = existing ?? document.createElement('div')
    failed.className = 'trans err'
    failed.textContent = '✕ 翻译失败'
    failed.title = error
    if (!existing) row.appendChild(failed)
    return
  }
  const trans = existing ?? document.createElement('div')
  trans.className = cached ? 'trans cached' : 'trans'
  trans.textContent = translated
  trans.title = cached ? '来自翻译词库（未调用模型）' : '本次现翻'
  if (!existing) row.appendChild(trans)
}

/** 译文到达后就地替换，不再另起一行 —— 原文早就显示出来了。 */
function updateRows(
  batch: {
    id: string
    translated: string | null
    pending?: boolean
    cached?: boolean
    error?: string
  }[]
): void {
  for (const entry of batch) {
    const row = rows.get(entry.id)
    if (!row) continue
    setTranslation(row, entry.translated, entry.cached === true, entry.error)
    if (entry.pending !== true) row.classList.remove('pending')
  }
}

window.api.onCaptureEntries((batch) => {
  for (const entry of batch) {
    appendRow(entry.original, entry.translated, false, entry.id, entry.pending === true, entry.hero, entry.cached === true, entry.error)
  }
})

window.api.onCaptureUpdate(updateRows)

/** 手动触发是「拍一张照」：先清空，再按当前屏幕内容重建，避免旧行残留。 */
window.api.onCaptureReplace((batch) => {
  list.replaceChildren()
  rows.clear()
  for (const entry of batch) {
    appendRow(entry.original, entry.translated, false, entry.id, entry.pending === true, entry.hero, entry.cached === true, entry.error)
  }
  if (batch.length === 0) pill.textContent = '没有识别到聊天内容'
  else pill.textContent = '已刷新 ' + batch.length + ' 条 · Alt+Shift+C'
})

window.api.onOverlayState((state: OverlayStatus) => applyState(state))

function setReplyOpen(open: boolean): void {
  replyBar.classList.toggle('hidden', !open)
  replyHint.textContent = REPLY_HINT
  replyHint.classList.remove('err')
  if (!open) return
  if (!replyInput.value) replyInput.value = localStorage.getItem(REPLY_DRAFT_KEY) ?? ''
  replyInput.focus()
  replyInput.setSelectionRange(replyInput.value.length, replyInput.value.length)
}

window.api.onOverlayReply((open) => setReplyOpen(open))

// ── 锁定 / 拖动 / 缩放 ────────────────────────────────────────────────
// 锁定 = 主进程把位置尺寸冻住并强制点击穿透，所以指针事件只在解锁态到达这里；
// 仍然再判一次 state.locked，避免「刚点锁定、事件还在路上」的竞态。
const bar = document.getElementById('bar') as HTMLElement
const barLabel = document.getElementById('bar-label') as HTMLElement
const barReset = document.getElementById('bar-reset') as HTMLButtonElement
const barLock = document.getElementById('bar-lock') as HTMLButtonElement
const barVoice = document.getElementById('bar-voice') as HTMLButtonElement
const barCollapse = document.getElementById('bar-collapse') as HTMLButtonElement
const mini = document.getElementById('mini') as HTMLButtonElement
const gripLeft = document.getElementById('resize-left') as HTMLElement
const gripRight = document.getElementById('resize-right') as HTMLElement

let overlayState: OverlayStatus | null = null

/**
 * 渲染进程只算「相对起点的增量」，边界收口在主进程。
 * 拿不到显示器工作区，就给一个足够大的虚拟工作区让偏移不被提前截断；
 * 真正会不会拖出屏幕，由 OverlayManager.applyGeometry 的 clamp 决定。
 */
const UNBOUNDED = { x: -100000, y: -100000, width: 200000, height: 200000 }

function geometryLabel(state: OverlayStatus): string {
  if (state.locked) return '已锁定'
  return `未锁定 · ${Math.round(state.geometry.width)}×${Math.round(state.geometry.height)}`
}

function applyState(state: OverlayStatus): void {
  overlayState = state
  // 显示层次由主进程说了算：只译文时靠 CSS 把原文那层收起来，占位行仍然先显示原文。
  document.body.dataset.text = state.textMode
  document.body.dataset.locked = state.locked ? 'true' : 'false'
  // 收起 = 整窗缩成一个小图标；展开回来由同一个按钮负责。
  document.body.dataset.collapsed = state.collapsed ? 'true' : 'false'
  // 小图标也要能看出锁定状态：锁定 = 穿透点不到，只能按 Alt+Shift+B 展开。
  // 浮层上不挂任何 title：鼠标划过就弹提示，在游戏里很碍事。
  mini.textContent = state.locked ? '🔒 翻译区' : '🔓 翻译区'
  barVoice.textContent = state.readAloud ? '朗读：开' : '朗读：关'
  barVoice.style.opacity = state.readAloud ? '1' : '0.6'
  // 行底色由设置控制：一边是游戏画面太亮看不清字，一边是底色太实挡住视野。
  document.body.style.setProperty('--row-alpha', String(state.opacity ?? 0.34))
  barLabel.textContent = geometryLabel(state)
  if (state.replyOpen) {
    pill.textContent = '回复 · Esc 关闭'
    pill.hidden = false
    pill.classList.remove('through', 'warn')
    return
  }
  // 正常运行时 pill 整块消失——浮层是字幕，不是仪表盘。
  // 只有「配置态」和「取不到字」两种情况才需要一行说明。
  if (state.hint) {
    pill.textContent = state.hint
    pill.hidden = false
    pill.classList.remove('through')
    pill.classList.add('warn')
    return
  }
  if (!state.locked) {
    pill.textContent = '未锁定 · 可拖动（5 秒后自动锁定）'
    pill.hidden = false
    pill.classList.remove('through', 'warn')
    return
  }
  pill.hidden = true
  pill.classList.remove('warn')
  pill.classList.toggle('through', true)
}

type DragKind = 'move' | 'left' | 'right'

function beginDrag(kind: DragKind, event: PointerEvent): void {
  const current = overlayState
  if (!current || current.locked || event.button !== 0) return
  event.preventDefault()
  const start = current.geometry
  const startX = event.screenX
  const startY = event.screenY
  let frame = 0
  let next: { x: number; y: number; width: number; height: number } | null = null

  const flush = (): void => {
    frame = 0
    if (!next) return
    const patch = next
    next = null
    void window.api.overlaySetGeometry(patch).then((state) => {
      overlayState = state
      barLabel.textContent = geometryLabel(state)
    })
  }

  const onMove = (move: PointerEvent): void => {
    const dx = move.screenX - startX
    const dy = move.screenY - startY
    next =
      kind === 'move'
        ? moveBy(start, dx, dy, UNBOUNDED)
        : kind === 'left'
          ? resizeFromLeft(start, dx, UNBOUNDED)
          : resizeFromRight(start, dx, UNBOUNDED)
    if (frame === 0) frame = requestAnimationFrame(flush)
  }

  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    if (frame !== 0) cancelAnimationFrame(frame)
    flush()
    // 松手那一刻贴边：拖得再准也会留 1~2px 缝，换 DPI 就成一条亮边。
    void window.api.overlaySnap().then((state) => {
      overlayState = state
      barLabel.textContent = geometryLabel(state)
    })
    // 收尾再同步一次：主进程 clamp 过的才是真值，标签不能显示手算的中间态。
    void window.api.overlayReplyState().then((state) => {
      overlayState = state
      barLabel.textContent = geometryLabel(state)
    })
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

barVoice.addEventListener('click', () => {
  const state = overlayState
  if (state) void window.api.overlaySetVoice(!state.readAloud).then(applyState)
})
barCollapse.addEventListener('click', () => {
  void window.api.overlayToggleCollapse().then(applyState)
})
mini.addEventListener('click', () => {
  void window.api.overlayToggleCollapse().then(applyState)
})
barReset.addEventListener('click', () => {
  void window.api.overlayResetGeometry().then(applyState)
})
barLock.addEventListener('click', () => {
  void window.api.overlaySetLocked(true).then(applyState)
})
bar.addEventListener('dblclick', () => {
  const state = overlayState
  if (state) void window.api.overlaySetLocked(!state.locked).then(applyState)
})
bar.addEventListener('pointerdown', (event) => {
  if (event.target instanceof HTMLButtonElement) return
  beginDrag('move', event)
})
gripLeft.addEventListener('pointerdown', (event) => beginDrag('left', event))
gripRight.addEventListener('pointerdown', (event) => beginDrag('right', event))

// The bar can be opened before this page finishes loading; sync once it is ready.
void window.api.overlayReplyState().then((state) => {
  applyState(state)
  setReplyOpen(state.replyOpen)
})

// ── 朗读 ────────────────────────────────────────────────────────────────
// speechSynthesis 只在渲染进程可用：主进程决定「这句该念」，这里负责真的出声。
// 队列很短：话说得比嘴快时宁可漏掉旧的，也不要越念越落后（落后的话反而误导）。
const SPEAK_QUEUE_MAX = 6
const speakQueue: { text: string; lang: 'zh' | 'en'; rate: number; voice: string; audio?: string }[] = []
let speaking = false

function pickVoice(lang: 'zh' | 'en', wanted: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices()
  if (wanted) {
    const exact = voices.find((voice) => voice.name === wanted)
    if (exact) return exact
  }
  const prefix = lang === 'zh' ? 'zh' : 'en'
  return voices.find((voice) => voice.lang.toLowerCase().startsWith(prefix)) ?? null
}

function pumpSpeech(): void {
  if (speaking) return
  const next = speakQueue.shift()
  if (!next) return
  // 引擎选了神经语音，但这一句没合成成功：宁可这句不出声，也不要突然换成另一个嗓子。
  // 用户对「一下这个声音一下那个声音」的反馈就是这么来的——音色跳变比漏一句更刺耳。
  if (next.engine === 'edge' && !next.audio) {
    console.log('VOICE_SKIP_NO_AUDIO', next.text)
    speaking = false
    pumpSpeech()
    return
  }
  // Edge 神经语音已经在主进程合成好了 mp3：直接播，音色比系统嗓子好听一个时代。
  if (next.audio) {
    speaking = true
    const player = new Audio(`data:${next.audioMime ?? 'audio/mpeg'};base64,${next.audio}`)
    const done = (): void => {
      speaking = false
      pumpSpeech()
    }
    const speakWithSystem = (): void => {
      const utter = new SpeechSynthesisUtterance(next.text)
      utter.lang = next.lang === 'zh' ? 'zh-CN' : 'en-US'
      utter.rate = next.rate
      utter.onend = done
      utter.onerror = done
      window.speechSynthesis.speak(utter)
    }
    player.onended = done
    player.onerror = () => {
      // mp3 解不开（数据坏了）也算失败：退回系统嗓子，别让这一句彻底消失。
      console.log('VOICE_AUDIO_ERROR', next.text)
      speakWithSystem()
    }
    void player.play().then(() => console.log('VOICE_PLAY_OK', next.text)).catch((err: unknown) => {
      // 播不出来绝不能静默：Chromium 的 autoplay 策略拒绝时会走到这里。
      console.log('VOICE_PLAY_FAILED', err instanceof Error ? err.message : String(err))
      speakWithSystem()
    })
    return
  }
  const utter = new SpeechSynthesisUtterance(next.text)
  utter.lang = next.lang === 'zh' ? 'zh-CN' : 'en-US'
  utter.rate = next.rate
  const voice = pickVoice(next.lang, next.voice)
  if (voice) utter.voice = voice
  speaking = true
  const done = (): void => {
    speaking = false
    pumpSpeech()
  }
  utter.onend = done
  utter.onerror = done
  window.speechSynthesis.speak(utter)
}

window.api.onVoiceSpeak((payload) => {
  while (speakQueue.length >= SPEAK_QUEUE_MAX) speakQueue.shift()
  speakQueue.push(payload)
  pumpSpeech()
})

async function submit(): Promise<void> {
  const draft = replyInput.value.trim()
  if (!draft) return
  replyHint.textContent = '翻译并发送中…'
  replyHint.classList.remove('err')
  // 主进程负责翻译、关栏交还焦点、控制台直发；失败时它会把栏重新打开。
  const sent = await window.api.sendReply(draft)
  if (!sent.ok) {
    replyHint.textContent = sent.error ?? '发送失败'
    replyHint.classList.add('err')
    return
  }
  appendRow(draft, sent.translated ?? '', true)
  replyInput.value = ''
  localStorage.removeItem(REPLY_DRAFT_KEY)
}

replyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    void window.api.overlayCloseReply(false)
    return
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void submit()
  }
})

replyInput.addEventListener('input', () => {
  const value = replyInput.value
  if (value) localStorage.setItem(REPLY_DRAFT_KEY, value)
  else localStorage.removeItem(REPLY_DRAFT_KEY)
})

replyInput.addEventListener('blur', () => {
  if (!replyBar.classList.contains('hidden')) replyInput.focus()
})

const RECORD_MAX_MS = 20_000

let recording = false
let recordCtx: AudioContext | null = null
let recordStream: MediaStream | null = null
let recordNode: ScriptProcessorNode | null = null
let recordChunks: Float32Array[] = []
let recordTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Start microphone capture. ScriptProcessorNode is deprecated but needs no extra
 * worklet asset in this multi-page build; a single short utterance is cheap.
 */
async function startRecording(): Promise<void> {
  if (recording) return
  try {
    recordStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })
  } catch (err) {
    appendRow('🎤 麦克风不可用（检查 Windows 隐私设置：允许桌面应用使用麦克风）', null)
    console.error('overlay: getUserMedia failed', err)
    return
  }
  recordCtx = new AudioContext()
  const source = recordCtx.createMediaStreamSource(recordStream)
  recordNode = recordCtx.createScriptProcessor(4096, 1, 1)
  recordChunks = []
  recordNode.onaudioprocess = (event) => {
    recordChunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
  }
  source.connect(recordNode)
  recordNode.connect(recordCtx.destination)
  recording = true
  pill.textContent = '● 录音中 · Alt+Shift+V 结束'
  pill.classList.remove('through')
  recordTimer = setTimeout(() => void stopRecording(), RECORD_MAX_MS)
}

/** Stop capture, transcribe with whisper.cpp, then translate and copy the reply. */
async function stopRecording(): Promise<void> {
  if (!recording) return
  recording = false
  if (recordTimer) clearTimeout(recordTimer)
  recordTimer = null
  const rate = recordCtx?.sampleRate ?? 48_000
  recordNode?.disconnect()
  recordNode = null
  recordStream?.getTracks().forEach((track) => track.stop())
  recordStream = null
  const ctx = recordCtx
  recordCtx = null
  if (ctx) ctx.close().catch(() => undefined)
  const chunks = recordChunks
  recordChunks = []
  const frames = chunks.reduce((total, chunk) => total + chunk.length, 0)
  if (frames < rate * 0.3) {
    appendRow('🎤 录音太短，已忽略', null)
    pill.textContent = '运行中 · Alt+Shift+O'
    return
  }
  // whisper hallucinates text on silence, so skip the request when the mic is quiet.
  let energy = 0
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) energy += chunk[i] * chunk[i]
  }
  const rms = Math.sqrt(energy / frames)
  if (rms < 0.012) {
    appendRow(`🎤 没有检测到语音（音量 RMS ${rms.toFixed(4)}）`, null)
    pill.textContent = '运行中 · Alt+Shift+O'
    return
  }
  pill.textContent = '识别中…'
  const result = await window.api.transcribeAudio(encodeWav16k(chunks, rate))
  const transcript = result.text.trim()
  if (!result.ok || !transcript) {
    appendRow('🎤 ' + (result.error ?? '未识别到语音'), null)
    pill.textContent = '运行中 · Alt+Shift+O'
    return
  }
  appendRow('🎤 ' + transcript, null)
  const reply = await window.api.translateReply(transcript)
  if (reply.ok && reply.translated) appendRow(transcript, reply.translated, true)
  else appendRow(transcript, reply.error ?? '翻译失败', false)
  pill.textContent = '运行中 · Alt+Shift+O'
}


window.api.onVoiceRecordToggle(() => {
  if (recording) void stopRecording()
  else void startRecording()
})

// ── 方向键微调 / 活动保活 ─────────────────────────────────────────────
window.addEventListener('keydown', (event) => {
  const state = overlayState
  if (!state || state.locked) return
  const step = event.shiftKey ? 10 : 1
  const delta =
    event.key === 'ArrowLeft'
      ? { dx: -step, dy: 0 }
      : event.key === 'ArrowRight'
        ? { dx: step, dy: 0 }
        : event.key === 'ArrowUp'
          ? { dx: 0, dy: -step }
          : event.key === 'ArrowDown'
            ? { dx: 0, dy: step }
            : null
  if (!delta) return
  event.preventDefault()
  void window.api.overlayNudge(delta.dx, delta.dy).then((next) => {
    overlayState = next
    barLabel.textContent = geometryLabel(next)
  })
})

// 配置态闲置倒计时由主进程管；这边只要把「还在动」告诉它，1 秒一次足够。
let lastAlive = 0
window.addEventListener('pointermove', () => {
  if (overlayState?.locked) return
  const now = Date.now()
  if (now - lastAlive < 1000) return
  lastAlive = now
  void window.api.overlayKeepAlive()
})
