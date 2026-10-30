import { useEffect, useState } from 'react'
import {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  type AppSettings,
  type CaptureStatus,
  type ReplySendResult,
  type OverlayStatus,
  type ProviderId,
  type ReplyResult,
  type ReplyTone,
  type TestResult,
  type TranslateDirection,
  type VoiceAssetProgress,
  type VoiceAssetsResult,
  type VoicePreviewResult,
  type TranslatorStatus,
  type VoiceProbeResult,
  OFFLINE_VOICES,
  type OfflineVoiceId,
  type SovitsRefEntry,
  type SovitsStatus,
  type SovitsVoicePack,
  SOVITS_SEED_REF_DIR
} from '@shared/ipc'
import type { UpdateState } from '@shared/ipc'
import { DEFAULT_EDGE_VOICE, EDGE_VOICES } from '@shared/tts-voices'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

type TestState = { status: 'idle' } | { status: 'running' } | { status: 'done'; result: TestResult }

type CheckRow = { label: string; ok: boolean; detail: string }

/** 面板分组标题：一屏里塞十几样东西，没有分组就只能靠猜。 */
function GroupLabel({ text }: { text: string }) {
  return (
    <p className="mt-1 w-full border-t border-border/60 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {text}
    </p>
  )
}


/** 浮层的初始状态：主进程一广播就会被真值覆盖，这里只负责不要闪。 */
const EMPTY_OVERLAY: OverlayStatus = {
  visible: false,
  textMode: 'translated',
  replyOpen: false,
  locked: true,
  collapsed: false,
  readAloud: false,
  opacity: 0.34,
  geometry: { x: 0, y: 0, width: 0, height: 0 },
  hint: null
}

/** 抖动统计一行：分位数比单次数字更能说明「为什么刚才那么慢」。 */
function formatLatency(status: TranslatorStatus | null): string {
  const latency = status?.latency
  if (!latency || latency.count === 0) return '暂无样本'
  const secs = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`)
  const parts = [`p50 ${secs(latency.p50)}`, `p90 ${secs(latency.p90)}`, `最大 ${secs(latency.max)}`]
  if (latency.direct > 0) parts.push(`直连 ${latency.direct}`)
  if (latency.timeout > 0) parts.push(`超时 ${latency.timeout}`)
  if (latency.error > 0) parts.push(`错误 ${latency.error}`)
  return parts.join(' · ')
}

function OverviewCard(): React.ReactElement {
  const [settings, setSettings] = useState<AppSettings | null>(null)
const [capture, setCapture] = useState<CaptureStatus | null>(null)
  const [translator, setTranslator] = useState<TranslatorStatus | null>(null)
  const [overlay, setOverlay] = useState<OverlayStatus>(EMPTY_OVERLAY)
  const [rows, setRows] = useState<CheckRow[] | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    const [nextSettings, nextCapture, nextTranslator] = await Promise.all([
      window.api.getSettings(),
      window.api.captureStatus(),
      window.api.translatorStatus()
    ])
    setSettings(nextSettings)
    setCapture(nextCapture)
    setTranslator(nextTranslator)
  }

  useEffect(() => {
    void refresh()
    const offOverlay = window.api.onOverlayState(setOverlay)
    const timer = window.setInterval(() => {
      void window.api.captureStatus().then(setCapture)
      void window.api.translatorStatus().then(setTranslator)
    }, 3000)
    return () => {
      offOverlay()
      window.clearInterval(timer)
    }
  }, [])

  const selfCheck = async (): Promise<void> => {
    setBusy(true)
    const next: CheckRow[] = []
    try {
      const current = settings ?? (await window.api.getSettings())
      try {
        const result = await window.api.testProvider(current.provider)
        next.push({
          label: '模型服务',
          ok: result.ok,
          detail: `${
            result.ok ? `${result.latencyMs ?? 0} ms` : result.message
          } · ${current.provider.model}`
        })
      } catch (err) {
        next.push({ label: '模型服务', ok: false, detail: err instanceof Error ? err.message : String(err) })
      }
      const captureStatus = await window.api.captureStatus()
      next.push({
        label: '对局正文',
        ok: captureStatus.running,
        detail: captureStatus.running ? `监听中 · ${captureStatus.totalEntries} 条` : '已停止'
      })
      setRows(next)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const summary: Array<[string, string]> = settings
    ? [
        ['模型服务', `${settings.provider.id} · ${settings.provider.model}`],
        ['代理', settings.proxyUrl || '未启用'],
        ['对局正文', capture?.running ? `监听中 · ${capture.totalEntries} 条` : '已停止'],
        ['浮层', overlay.visible ? `显示中 · ${overlay.locked ? '已锁定' : '可编辑'}` : '已隐藏'],
        ['翻译延迟', formatLatency(translator)],
        ['开机自动捕获', settings.autoStartCapture ? '开' : '关']
      ]
    : []

  return (
    <Card>
      <CardHeader>
        <CardTitle>总览</CardTitle>
        <CardDescription>一眼看清整条链路，并可一键自检模型服务与对局正文状态。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 text-sm md:grid-cols-2">
          {summary.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-3 rounded-md border border-stone-700 px-3 py-2">
              <span className="text-muted-foreground">{label}</span>
              <span className="truncate text-right">{value}</span>
            </div>
          ))}
          {translator?.lastFallback ? (
            <div className="rounded-md border border-amber-900 px-3 py-2 text-sm text-amber-400 md:col-span-2">
              会话层回退直连：{translator.lastFallback}
            </div>
          ) : null}
          {capture?.lastError ? (
            <div className="rounded-md border border-red-900 px-3 py-2 text-sm text-red-400 md:col-span-2">
              {capture.lastError}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void selfCheck()} disabled={busy}>
            {busy ? '检查中…' : '一键自检'}
          </Button>
          <span className="text-xs text-muted-foreground">
            Alt+Shift+R 框选区域 · Alt+Shift+O 浮层 · Alt+Shift+P 点击穿透 · Alt+Shift+T 输入直发 · Alt+Shift+Y 回复 ·
            Alt+Shift+V 语音
          </span>
        </div>

        {rows ? (
          <div className="space-y-2">
            {rows.map((row) => (
              <div key={row.label} className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={row.ok ? 'default' : 'destructive'}>{row.ok ? '通过' : '失败'}</Badge>
                <span className="w-40 shrink-0 text-muted-foreground">{row.label}</span>
                <span className="truncate">{row.detail}</span>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}


function TranslateTryCard({
  title,
  description,
  direction,
  initial
}: {
  title: string
  description: string
  direction: TranslateDirection
  initial: string
}): React.ReactElement {
  const [text, setText] = useState(initial)
  const [out, setOut] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (): Promise<void> => {
    if (!text.trim()) return
    setBusy(true)
    setError('')
    try {
      setOut(await window.api.translate(text, direction))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="输入一句话…" />
        <div className="flex items-center gap-3">
          <Button onClick={() => void run()} disabled={busy || !text.trim()}>
            {busy ? '翻译中…' : '翻译'}
          </Button>
          {error ? <Badge variant="destructive">失败</Badge> : null}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {out ? <p className="rounded-md bg-secondary p-3 text-sm">{out}</p> : null}
      </CardContent>
    </Card>
  )
}

function SendCard(): React.ReactElement {
  const [draft, setDraft] = useState('')
  const [consoleKey, setConsoleKey] = useState('\\')
  const [sendMode, setSendMode] = useState<'inplace' | 'chat' | 'console'>('inplace')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ReplySendResult | null>(null)
  const [latencyNote, setLatencyNote] = useState('')

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      setConsoleKey(s.consoleKey)
      setSendMode(s.sendMode)
    })
  }, [])

  const handleSend = async (): Promise<void> => {
    if (busy) return
    if (sendMode === 'inplace') {
      setBusy(true)
      try {
        const res = await window.api.translateInPlace()
        setLatencyNote(
          [
            res.grabMs === undefined ? null : `读聊天框 ${res.grabMs}ms`,
            res.translateMs === undefined ? null : `翻译 ${res.translateMs}ms`,
            res.sendMs === undefined ? null : `写回 ${res.sendMs}ms`
          ]
            .filter(Boolean)
            .join(' · ')
        )
        setResult({
          ok: res.ok,
          draft: res.draft ?? '',
          translated: res.translated,
          command: res.translated,
          error: res.error
        })
      } finally {
        setBusy(false)
      }
      return
    }
    if (!draft.trim()) return
    setBusy(true)
    setLatencyNote('')
    try {
      setResult(await window.api.sendReply(draft))
    } finally {
      setBusy(false)
    }
  }

  const handleKeyBlur = async (): Promise<void> => {
    const next = consoleKey.trim().slice(0, 1) || '\\'
    setConsoleKey(next)
    await window.api.setSettings({ consoleKey: next })
  }

  const handleModeChange = async (next: 'inplace' | 'chat' | 'console'): Promise<void> => {
    setSendMode(next)
    await window.api.setSettings({ sendMode: next })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>游戏内直发</CardTitle>
        <CardDescription>
          {sendMode === 'inplace'
            ? '在游戏聊天框里打中文（先别按回车）→ 按 Alt+Shift+T → 后台翻译 → 自动粘贴英文并回车发送。全程不切换窗口。'
            : '打中文 → 回车 → 翻成英文 → 自动切回游戏、粘贴进聊天框并回车发送。'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sendMode === 'inplace' ? (
          <div className="text-xs text-muted-foreground">
            游戏里按 Enter 打开聊天框 → 打中文 → 按 Alt+Shift+T。读到的草稿会被清空，翻译完成后自动粘回并回车发出；
            失败时原文还在剪贴板里，可 Ctrl+V 恢复。
          </div>
        ) : (
          <Textarea
            value={draft}
            placeholder="要发到队伍频道的中文，回车发送"
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void handleSend()
              }
            }}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || (sendMode !== 'inplace' && !draft.trim())}
            onClick={() => void handleSend()}
          >
            {busy ? '翻译中…' : sendMode === 'inplace' ? '读取聊天框并直发' : '翻译并发送'}
          </Button>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="sendMode">发送通道</Label>
          <Select
            id="sendMode"
            value={sendMode}
            onChange={(event) =>
              void handleModeChange(event.target.value as 'inplace' | 'chat' | 'console')
            }
          >
            <option value="inplace">原地替换游戏聊天框（推荐）</option>
            <option value="chat">浮层输入后粘贴发送</option>
            <option value="console">控制台 say_team（需 -console，逐字符 1-4 秒）</option>
          </Select>
        </div>
        {sendMode === 'console' ? (
          <div className="grid gap-2">
            <Label htmlFor="consoleKey">控制台开关键</Label>
            <Input
              id="consoleKey"
              maxLength={1}
              value={consoleKey}
              onChange={(event) => setConsoleKey(event.target.value)}
              onBlur={() => void handleKeyBlur()}
            />
            <div className="text-xs text-muted-foreground">
              需要 Dota 2 启动项 -console；默认是反斜杠 \，改这里就换成你绑的键。
            </div>
          </div>
        ) : null}
        {result ? (
          <div className="grid gap-1">
            <div className={result.ok ? 'text-sm text-emerald-400' : 'text-sm text-rose-400'}>
              {result.ok ? `已发送：${result.command ?? ''}` : `失败：${result.error ?? ''}`}
            </div>
            {result.translated ? (
              <div className="text-xs text-muted-foreground">译文：{result.translated}</div>
            ) : null}
            {latencyNote ? (
              <div className="text-xs text-muted-foreground">耗时：{latencyNote}</div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
/** 浮层与朗读：这两件事绑在一起，都属于「看得见、听得见」的那一半。 */
function OverlayCard(): React.ReactElement {
  const [overlay, setOverlay] = useState<OverlayStatus>(EMPTY_OVERLAY)
  const [readAloud, setReadAloud] = useState(false)
  const [readOwn, setReadOwn] = useState(false)
  const [speakPrefix, setSpeakPrefix] = useState<'front' | 'back' | 'off'>('front')
  const [speakFrontTpl, setSpeakFrontTpl] = useState('{who}说，{body}')
  const [speakBackTpl, setSpeakBackTpl] = useState('{body}，{who}表示')
  const [engine, setEngine] = useState<'system' | 'edge' | 'offline' | 'sovits'>('edge')
  const [offline, setOffline] = useState<{ ready: boolean; bytes: number; downloading: boolean; progress: number; error: string | null } | null>(null)
  useEffect(() => {
    void window.api.ttsOfflineState().then(setOffline)
  }, [])
  const [voice, setVoice] = useState(DEFAULT_EDGE_VOICE)
  const [offlineVoice, setOfflineVoice] = useState<OfflineVoiceId>('baker')
  const [rate, setRate] = useState(1)
  const [pitch, setPitch] = useState(1)
  const [sovitsUrl, setSovitsUrl] = useState('http://127.0.0.1:9880')
  const [sovitsRef, setSovitsRef] = useState('')
  const [sovitsPrompt, setSovitsPrompt] = useState('')
  const [sovitsPromptLang, setSovitsPromptLang] = useState<'zh' | 'en'>('zh')
  const [sovitsHome, setSovitsHome] = useState('')
  const [sovits, setSovits] = useState<SovitsStatus | null>(null)
  const [sovitsRefs, setSovitsRefs] = useState<SovitsRefEntry[]>([])
  const [sovitsPacks, setSovitsPacks] = useState<SovitsVoicePack[]>([])
  const [packSel, setPackSel] = useState('')
  const [packErr, setPackErr] = useState<string | null>(null)
  const [nicknames, setNicknames] = useState('')
  const [autoStart, setAutoStart] = useState(DEFAULT_SETTINGS.autoStartCapture)

  useEffect(() => {
    // 面板要显示真值而不是初值：朗读默认关，浮层状态平时只靠广播。
    void window.api.getSettings().then((next) => {
      setReadAloud(next.ttsReadAloud)
      setReadOwn(next.ttsReadOwn)
      setSpeakPrefix(next.ttsSpeakPrefix)
      setSpeakFrontTpl(next.ttsSpeakFrontTpl)
      setSpeakBackTpl(next.ttsSpeakBackTpl)
      setEngine(next.ttsEngine)
      setVoice(next.ttsVoice || DEFAULT_EDGE_VOICE)
      setOfflineVoice(next.ttsOfflineVoice ?? 'baker')
      setRate(next.ttsRate)
      setPitch(next.ttsPitch)
      setSovitsUrl(next.ttsSovitsUrl)
      setSovitsRef(next.ttsSovitsRefAudio)
      setSovitsPrompt(next.ttsSovitsPromptText)
      setSovitsPromptLang(next.ttsSovitsPromptLang ?? 'zh')
      setSovitsHome(next.ttsSovitsHome)
      setNicknames(next.myNicknames.join(', '))
      setAutoStart(next.autoStartCapture)
    })
    void window.api.overlayReplyState().then(setOverlay)
    void window.api.overlayReplyState().then(setOverlay)
    void window.api.sovitsRefs().then(setSovitsRefs)
    return window.api.onOverlayState(setOverlay)
  }, [])

  useEffect(() => {
    // 服务状态每 3 秒刷一次：拉模型、下 8GB、服务挂掉都在这条轮询里体现。
    // 只在选了 GPT-SoVITS 时轮询，别的引擎不该为它多花一次 IPC。
    if (engine !== 'sovits') return
    // 切到 sovits 时顺手刷新参考库与音色包：refs.json 是手编文件，加条目不该要求重启。
    void window.api.sovitsRefs().then(setSovitsRefs)
    void window.api.sovitsVoicepacks().then(setSovitsPacks)
    let alive = true
    const tick = (): void => {
      void window.api.sovitsStatus().then((next) => {
        if (alive) setSovits(next)
      })
      // 音色包下载进度在主进程内存里，跟着状态一起刷。
      // 参考库也跟着刷：音色包装完会往 refs.json 追加条目（主进程写的），
      // 不刷的话「参考音频库」下拉会一直显示切引擎那一刻的旧快照——
      // 装完米拉娜下拉里却看不到，就是这个坑。
      void window.api.sovitsVoicepacks().then((next) => {
        if (alive) setSovitsPacks(next)
      })
      void window.api.sovitsRefs().then((next) => {
        if (alive) setSovitsRefs(next)
      })
    }
    tick()
    const timer = setInterval(tick, 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [engine])

  return (
    <Card>
      <CardHeader>
        <CardTitle>浮层与朗读</CardTitle>
        <CardDescription>
          浮层只在对局里显示聊天译文；朗读把新消息念出来，可以一边打一边听。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={overlay.visible ? 'secondary' : 'default'}
            onClick={() => void window.api.overlayToggle().then(setOverlay)}
          >
            {overlay.visible ? '隐藏浮层' : '显示浮层'}
          </Button>
          <Button
            variant={overlay.locked ? 'secondary' : 'outline'}
            disabled={!overlay.visible}
            onClick={() => void window.api.overlaySetLocked(!overlay.locked).then(setOverlay)}
            title="锁定 = 几何冻住且不吃鼠标；解锁后可拖动、拉两侧改宽度（Alt+Shift+P）"
          >
            {overlay.locked ? '已锁定' : '可编辑'}
          </Button>
          <Button
            variant="outline"
            disabled={!overlay.visible}
            onClick={() => void window.api.overlayToggleCollapse().then(setOverlay)}
            title="收成角落里的小图标，再点一下展开（Alt+Shift+B）"
          >
            {overlay.collapsed ? '展开' : '收起'}
          </Button>
          <Button
            variant="outline"
            disabled={!overlay.visible || overlay.locked}
            onClick={() => void window.api.overlayResetGeometry().then(setOverlay)}
            title="回到默认位置与尺寸"
          >
            还原位置大小
          </Button>
          <label className="flex items-center gap-2 text-xs text-muted-foreground" title="只改每行底色深浅，窗口本身始终透明">
            底色
            <input
              type="range"
              min={5}
              max={90}
              value={Math.round(overlay.opacity * 100)}
              onChange={(e) => void window.api.overlaySetOpacity(Number(e.target.value) / 100).then(setOverlay)}
              className="h-1 w-24 accent-amber-500"
            />
            {Math.round(overlay.opacity * 100)}%
          </label>
          <select
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
            value={overlay.textMode}
            onChange={(e) => {
              const next = e.target.value as 'translated' | 'both' | 'original'
              void window.api.overlaySetText(next).then(setOverlay)
            }}
            title="只显示译文最省视线；等翻译时先占位原文，到达后就地换掉"
          >
            <option value="translated">只显示译文</option>
            <option value="both">原文 + 译文</option>
            <option value="original">只显示原文</option>
          </select>
          <span className="text-xs tabular-nums text-muted-foreground">
            {Math.round(overlay.geometry.width)}×{Math.round(overlay.geometry.height)} @{' '}
            {Math.round(overlay.geometry.x)},{Math.round(overlay.geometry.y)}
          </span>
        </div>

        <GroupLabel text="朗读" />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={readAloud ? 'secondary' : 'outline'}
            onClick={() => {
              const next = !readAloud
              setReadAloud(next)
              void window.api.setSettings({ ttsReadAloud: next })
            }}
            title="把新消息念出来。中文原话、英文译文都会念，只念内容不念「谁说的」"
          >
            朗读：{readAloud ? '开' : '关'}
          </Button>
          {/* 自己发的也念：默认关。开着时会把自己的话念出来，配合语音核对发音很顺手，
              代价是自己那句和紧接着的译文会连读成一句话（「司夜刺客说，基地」）。 */}
          <Button
            variant={readOwn ? 'secondary' : 'outline'}
            disabled={!readAloud}
            onClick={() => {
              const next = !readOwn
              setReadOwn(next)
              void window.api.setSettings({ ttsReadOwn: next })
            }}
            title="自己发的消息也念出来。默认关：自己刚打完的字不必再听一遍"
          >
            自己的话：{readOwn ? '念' : '不念'}
          </Button>
          {/* 「某某说」念在哪头。用下拉不用循环按钮：三个选项一眼看得全，
              循环按钮的当前态（「说话人：不念」）曾被用户当成「没有前后那个设置」。 */}
          <label
            className="flex items-center gap-2 text-xs text-muted-foreground"
            title="说话人标签念在哪头：句首先知道是谁说的，句尾先听内容，不念只听内容"
          >
            说话人
            <select
              className="rounded-md border border-input bg-background px-2 py-1 text-xs"
              value={speakPrefix}
              disabled={!readAloud}
              onChange={(e) => {
                const next = e.target.value as 'front' | 'back' | 'off'
                setSpeakPrefix(next)
                void window.api.setSettings({ ttsSpeakPrefix: next })
              }}
            >
              <option value="front">句首「玩家9说，…」</option>
              <option value="back">句尾「…，玩家9表示」</option>
              <option value="off">不念</option>
            </select>
          </label>
            {speakPrefix !== 'off' && (
              <Input
                className="w-52"
                disabled={!readAloud}
                value={speakPrefix === 'front' ? speakFrontTpl : speakBackTpl}
                onChange={(e) => (speakPrefix === 'front' ? setSpeakFrontTpl(e.target.value) : setSpeakBackTpl(e.target.value))}
                onBlur={() =>
                  void window.api.setSettings(
                    speakPrefix === 'front'
                      ? { ttsSpeakFrontTpl: speakFrontTpl.trim() || '{who}说，{body}' }
                      : { ttsSpeakBackTpl: speakBackTpl.trim() || '{body}，{who}表示' }
                  )
                }
                placeholder="{body}，{who}表示"
                title="朗读模板：{who}=说话人，{body}=内容。标点措辞随便改，但必须保留 {body}，否则回默认"
              />
            )}
        </div>

        <GroupLabel text="引擎与嗓子" />
        <div className="flex flex-wrap items-center gap-2">
          {/* 两个下拉：左边选路子（分类），右边选具体嗓子（选项）。
              分类只有三种，选项随分类变；系统嗓子没有选项，右侧控件保持禁用而不是消失——
              消失会让布局跳动，用户也会以为刚选的东西丢了。 */}
          <select
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
            value={engine}
            onChange={(e) => {
              const next = e.target.value as 'system' | 'edge' | 'offline' | 'sovits'
              setEngine(next)
              void window.api.setSettings({ ttsEngine: next })
            }}
            title="语音来源：联网最自然、本地不依赖网络、系统嗓子仅兜底"
          >
            <option value="edge">联网 · 神经语音</option>
            <option value="offline">本地 · 离线模型</option>
            <option value="sovits">本地 · GPT-SoVITS</option>
            <option value="system">兜底 · 系统嗓子</option>
          </select>
          <select
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
            value={engine === 'offline' ? offlineVoice : voice}
            disabled={engine === 'system' || engine === 'sovits'}
            onChange={(e) => {
              if (engine === 'offline') {
                const next = e.target.value as OfflineVoiceId
                setOfflineVoice(next)
                void window.api.setSettings({ ttsOfflineVoice: next })
                return
              }
              setVoice(e.target.value)
              void window.api.setSettings({ ttsVoice: e.target.value })
            }}
            title="挑一个喜欢的嗓子；不满意就到语音页试听当场换"
          >
            {engine === 'offline'
              ? OFFLINE_VOICES.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label} · {option.note}
                  </option>
                ))
              : engine === 'sovits'
                ? <option value="sovits">音色由参考音频决定</option>
              : engine === 'system'
                ? <option value="system">系统嗓子</option>
                : EDGE_VOICES.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
          </select>
          {engine === 'offline' && (
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(offline?.downloading)}
              onClick={() => {
                void window.api.ttsOfflineDownload().then(setOffline)
              }}
              title={
                offline?.ready
                  ? '模型已在本地：再点一次会重新下载（文件损坏时用这个自救）'
                  : '模型约 130 MB，下载后离线可用；存在数据目录 tts-models/ 下'
              }
            >
              {offline?.downloading
                ? `下载中 ${Math.round((offline.progress ?? 0) * 100)}%`
                : offline?.ready
                  ? '重新下载模型'
                  : '下载模型（130 MB）'}
            </Button>
          )}
          {engine === 'offline' && offline?.ready && (
            <span className="text-xs text-muted-foreground" title="模型文件在数据目录 tts-models/vits-zh-hf-keqing 下">
              已就绪 {Math.round((offline.bytes ?? 0) / 1048576)} MB
            </span>
          )}
          {engine === 'offline' && offline?.error !== undefined && offline?.error !== null && !offline?.ready && (
            <span className="text-xs text-destructive" title={offline.error}>
              下载失败：{offline.error}
            </span>
          )}
          <label
            className="flex items-center gap-2 text-xs text-muted-foreground"
            title={
              engine === 'offline'
                ? '语速：本地模型 1.0 正常，0.8 更慢（实测 0.8 以下会变得拖沓）'
                : '语速：1.0 正常'
            }
          >
            语速
            <input
              type="range"
              min={0.7}
              max={1.6}
              step={0.05}
              value={rate}
              disabled={engine === 'system'}
              className="h-1 w-24 accent-primary"
              onChange={(e) => {
                const next = Number(e.target.value)
                setRate(next)
                void window.api.setSettings({ ttsRate: next })
              }}
            />
            <span className="tabular-nums">{rate.toFixed(2)}</span>
          </label>
          <label
            className="flex items-center gap-2 text-xs text-muted-foreground"
            title={
              engine === 'edge'
                ? '音高：1.00 原声，1.10 更尖，0.90 更沉'
                : '音高只对联网嗓子可用：本地模型音高固定，系统嗓子由系统控制'
            }
          >
            音高
            <input
              type="range"
              min={0.7}
              max={1.3}
              step={0.05}
              value={pitch}
              disabled={engine !== 'edge'}
              className="h-1 w-24 accent-primary"
              onChange={(e) => {
                const next = Number(e.target.value)
                setPitch(next)
                void window.api.setSettings({ ttsPitch: next })
              }}
            />
            <span className="tabular-nums">{pitch.toFixed(2)}</span>
          </label>
        </div>

        {engine === 'sovits' && (
          <div className="flex w-full flex-col gap-2">
            <GroupLabel text="GPT-SoVITS · 音色由参考音频决定" />
            {/* 英雄音色包：清单来自魔搭 voicepacks.json（拉不到用内置兜底），选中看详情，不竖排堆列表。 */}
            {sovitsPacks.length > 0 && (() => {
              const selected = sovitsPacks.find((pack) => pack.id === packSel) ?? sovitsPacks[0]
              const remaining = selected.bytes - selected.haveBytes
              const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(0)} MB`
              return (
                <div className="flex flex-col gap-1">
                  <label className="flex items-center gap-2">
                    <span className="shrink-0 text-xs text-muted-foreground">音色包</span>
                    <select
                      className="w-60 max-w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                      value={selected.id}
                      onChange={(e) => {
                        setPackSel(e.target.value)
                        setPackErr(null)
                      }}
                    >
                      {sovitsPacks.map((pack) => (
                        <option key={pack.id} value={pack.id}>
                          {pack.name} · {pack.downloading ? `下载中 ${Math.round(pack.progress * 100)}%` : pack.installed ? '已就绪' : '未下载'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-muted/30 px-2 py-1.5 text-xs">
                    {selected.installed ? (
                      <span className="text-emerald-600 dark:text-emerald-400">● 已就绪</span>
                    ) : selected.downloading ? (
                      <span className="text-amber-600 dark:text-amber-400">↓ 下载中 {Math.round(selected.progress * 100)}%</span>
                    ) : (
                      <span className="text-muted-foreground">○ 未下载</span>
                    )}
                    <span className="text-muted-foreground">v{selected.version}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {selected.installed ? mb(selected.bytes) : `还需 ${mb(remaining)} / ${mb(selected.bytes)}`}
                    </span>
                    {selected.active && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">使用中</span>
                    )}
                    {selected.defaultPack && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">默认</span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-muted-foreground" title={selected.note}>
                      {selected.note}
                    </span>
                    {!selected.installed && !selected.downloading && (
                      <Button size="sm" variant="outline" onClick={() => void window.api.sovitsVoicepackInstall(selected.id).then(setSovitsPacks)}>
                        下载
                      </Button>
                    )}
                    {selected.installed && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={selected.downloading}
                          onClick={() => void window.api.sovitsVoicepackInstall(selected.id).then(setSovitsPacks)}
                        >
                          重新下载
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={selected.active}
                          title={selected.active ? '先在下面的参考音频库切换到其他音色' : undefined}
                          onClick={() => {
                            setPackErr(null)
                            void window.api
                              .sovitsVoicepackDelete(selected.id)
                              .then(setSovitsPacks)
                              .catch((err: unknown) => setPackErr(err instanceof Error ? err.message : String(err)))
                          }}
                        >
                          删除
                        </Button>
                      </>
                    )}
                  </div>
                  {(selected.error ?? packErr) !== null && (
                    <span className="text-xs text-destructive">{selected.error ?? packErr}</span>
                  )}
                </div>
              )
            })()}
            {(sovitsRefs.length === 0 ||
              !sovitsRefs.some((ref) => ref.audio.startsWith(`${SOVITS_SEED_REF_DIR}/`))) && (
              <div className="flex flex-wrap items-center gap-2">
                {sovitsRefs.length === 0 && (
                  <span className="text-xs text-muted-foreground">参考音频库是空的，没有参考音色出不来</span>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  title="用免费的 Edge 嗓子现合成一条晓晓参考写进库里，不下载任何模型；已有音色包也能补，重复点会替换旧的那条"
                  onClick={() =>
                    void window.api.sovitsSeed().then(() => {
                      void window.api.sovitsRefs().then(setSovitsRefs)
                      void window.api.sovitsVoicepacks().then(setSovitsPacks)
                    })
                  }
                >
                  现合成一条保底参考（免费）
                </Button>
              </div>
            )}
            {sovitsRefs.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                  value={sovitsRefs.find((ref) => ref.audioPath === sovitsRef)?.audio ?? ''}
                  onChange={(e) => {
                    const picked = sovitsRefs.find((ref) => ref.audio === e.target.value)
                    if (!picked) return
                    // 激活是主进程的事：写设置 → 切权重 → 预热一气呵成，微调音色不切权重就是错音色。
                    setSovitsRef(picked.audioPath)
                    setSovitsPrompt(picked.promptText)
                    setSovitsPromptLang(picked.promptLang)
                    void window.api.sovitsSelectRef(picked)
                  }}
                  title="参考音频库：选中即整套换参考，下一句朗读就生效；下面的手填框留给临时野路径"
                >
                  <option value="">从参考音频库选择…</option>
                  {sovitsRefs.map((ref) => (
                    <option key={ref.audio} value={ref.audio}>
                      {ref.name}
                      {ref.gptWeightsPath ? ' · 微调' : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="w-56"
                value={sovitsHome}
                onChange={(e) => setSovitsHome(e.target.value)}
                onBlur={() => void window.api.setSettings({ ttsSovitsHome: sovitsHome.trim() })}
                placeholder="D:\AI\GPT-SoVITS-v2pro-20250604"
                title="整合包目录：填了应用启动时就自动拉起 api_v2（模型加载约 40 秒），退出时收掉"
              />
              <Input
                className="w-44"
                value={sovitsUrl}
                onChange={(e) => setSovitsUrl(e.target.value)}
                onBlur={() => void window.api.setSettings({ ttsSovitsUrl: sovitsUrl.trim() || 'http://127.0.0.1:9880' })}
                placeholder="http://127.0.0.1:9880"
                title="api_v2 服务地址：整合包 runtime 起的本地端口"
              />
              <Input
                className="w-64"
                value={sovitsRef}
                onChange={(e) => setSovitsRef(e.target.value)}
                onBlur={() => void window.api.setSettings({ ttsSovitsRefAudio: sovitsRef.trim() })}
                placeholder="参考音频绝对路径，如 D:\AI\ref.wav"
                title="参考音频：决定音色的那段声音，服务端磁盘上的绝对路径"
              />
              <Input
                className="w-44"
                value={sovitsPrompt}
                onChange={(e) => setSovitsPrompt(e.target.value)}
                onBlur={() => void window.api.setSettings({ ttsSovitsPromptText: sovitsPrompt })}
                placeholder="参考音频的逐字转写"
                title="转写：那段参考音频说了什么，一字不差；对不上音质会明显劣化"
              />
              <select
                className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                value={sovitsPromptLang}
                onChange={(e) => {
                  const next = e.target.value as 'zh' | 'en'
                  setSovitsPromptLang(next)
                  void window.api.setSettings({ ttsSovitsPromptLang: next })
                }}
                title="参考音频的语言：转写是什么语言就选什么，克隆时靠它对齐"
              >
                <option value="zh">参考语言 · 中文</option>
                <option value="en">参考语言 · 英文</option>
              </select>
            </div>
            <div className="flex w-full flex-col gap-1">
              {/* 状态行：服务起没起、用的哪个目录、包装没装——一眼能看完，不用问人。 */}
              {sovits === null ? (
                <span className="text-xs text-muted-foreground">正在读取引擎状态…</span>
              ) : (
                <span className="flex flex-wrap items-center gap-2 text-xs" title={`引擎包目录：${sovits.home}\n数据目录：${sovits.installRoot}`}>
                  <span
                    className={
                      sovits.server.phase === 'ready' || sovits.server.phase === 'external'
                        ? 'inline-block h-2 w-2 rounded-full bg-emerald-500'
                        : sovits.server.phase === 'starting'
                          ? 'inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500'
                          : 'inline-block h-2 w-2 rounded-full bg-destructive'
                    }
                  />
                  <span className="text-foreground">
                    {sovits.server.phase === 'ready'
                      ? '服务运行中'
                      : sovits.server.phase === 'external'
                        ? '服务已在跑（外部实例）'
                        : sovits.server.phase === 'starting'
                          ? '正在拉起服务'
                          : '服务未启动'}
                  </span>
                  <span className="text-muted-foreground">{sovits.server.detail}</span>
                  {sovits.server.pid !== null && <span className="tabular-nums text-muted-foreground">PID {sovits.server.pid}</span>}
                  <span className="text-muted-foreground">{sovits.installed ? '引擎包已安装' : '引擎包未安装'}</span>
                </span>
              )}
              {sovits !== null && !sovits.installed && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" disabled={sovits.install.phase === 'downloading' || sovits.install.phase === 'extracting'} onClick={() => void window.api.sovitsInstall().then(setSovits)}>
                    {sovits.install.phase === 'downloading'
                      ? `下载中 ${Math.round(sovits.install.progress * 100)}%`
                      : sovits.install.phase === 'extracting'
                        ? '解压中…'
                        : sovits.archivePresent
                          ? '解压已下载的压缩包'
                          : '下载引擎包（8.2 GB）'}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    也可以自己下载 GPT-SoVITS-v2pro-20250604.7z 放进 {sovits.installRoot}，再点左边按钮
                  </span>
                </div>
              )}
              {sovits !== null && sovits.install.error !== null && (
                <span className="text-xs text-destructive">安装失败：{sovits.install.error}</span>
              )}
              {sovits !== null && sovits.logs.length > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none">日志（最近 {sovits.logs.length} 行）</summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted p-2 text-[11px] leading-4">{sovits.logs.join('\n')}</pre>
                </details>
              )}
            </div>
            </div>
          )}

        <GroupLabel text="对局" />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-amber-500"
              checked={autoStart}
              onChange={(e) => {
                const next = e.target.checked
                setAutoStart(next)
                void window.api.setSettings({ autoStartCapture: next })
              }}
            />
            启动时自动开始（GSI 报进对局也会自动开）
          </label>
          <Input
            className="w-72"
            value={nicknames}
            onChange={(e) => setNicknames(e.target.value)}
            onBlur={() =>
              void window.api.setSettings({
                myNicknames: nicknames
                  .split(',')
                  .map((part) => part.trim())
                  .filter(Boolean)
              })
            }
            placeholder="我的游戏昵称，用逗号分隔"
          />
          <span className="text-xs text-muted-foreground">自己的昵称（只做归属标注，不因它跳过翻译或朗读）</span>
        </div>

        <GroupLabel text="热键" />
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>Alt+Shift+O 显示/隐藏</span>
          <span>Alt+Shift+P 锁定/解锁</span>
          <span>Alt+Shift+B 收起/展开</span>
          <span>Alt+Shift+T 输入直发</span>
          <span>Alt+Shift+Y 回复</span>
          <span>Alt+Shift+V 语音</span>
        </div>
      </CardContent>
    </Card>
  )
}


const REPLY_TONES: { value: ReplyTone; label: string }[] = [
  { value: 'terse', label: '简短（默认）' },
  { value: 'polite', label: '客气' },
  { value: 'hurry', label: '催促' },
  { value: 'firm', label: '强硬' }
]

const DRAFT_KEY = 'oh-my-dota2.replyDraft'

interface ReplyHistoryItem {
  draft: string
  translated: string
  tone: ReplyTone
  at: number
}

function ReplyCard(): React.ReactElement {
  const [text, setText] = useState(() => localStorage.getItem(DRAFT_KEY) ?? '')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ReplyResult | null>(null)
  const [history, setHistory] = useState<ReplyHistoryItem[]>([])
  const [crossTone, setCrossTone] = useState(true)
  const [tone, setTone] = useState<ReplyTone>('terse')
  const [countdown, setCountdown] = useState(0)

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      setTone(s.replyTone)
      setCrossTone(s.crossToneLookup !== false)
    })
  }, [])

  // 草稿落盘：切页签或刷新都不会丢。
  useEffect(() => {
    if (text) localStorage.setItem(DRAFT_KEY, text)
    else localStorage.removeItem(DRAFT_KEY)
  }, [text])

  // 复制成功的 8 秒倒计时提示。
  useEffect(() => {
    if (countdown <= 0) return
    const timer = setTimeout(() => setCountdown((n) => n - 1), 1000)
    return () => clearTimeout(timer)
  }, [countdown])

  const pickTone = (next: ReplyTone): void => {
    setTone(next)
    void window.api.setSettings({ replyTone: next })
  }

  const send = async (draft = text.trim()): Promise<void> => {
    if (!draft || busy) return
    setBusy(true)
    setResult(null)
    try {
      const reply = await window.api.translateReply(draft, tone)
      setResult(reply)
      if (reply.ok && reply.translated) {
        const at = Date.now()
        const head = history[0]
        // 同一句译文 2 秒内重复复制：不重复记账，也不重置倒计时提示。
        const duplicate = Boolean(head) && head.translated === reply.translated && at - head.at < 2000
        if (!duplicate) {
          setHistory((prev) => [{ draft, translated: reply.translated ?? '', tone, at }, ...prev].slice(0, 5))
          setCountdown(8)
        }
        setText('')
      }
    } catch (e) {
      setResult({
        ok: false,
        translated: null,
        copied: false,
        error: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setBusy(false)
    }
  }

  const refill = (item: ReplyHistoryItem): void => {
    setText(item.draft)
    setTone(item.tone)
    void window.api.setSettings({ replyTone: item.tone })
    void send(item.draft)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>回复（中 → 英 → 剪贴板）</CardTitle>
        <CardDescription>
          输入中文，回车翻译。英文会写入剪贴板 —— 切回 Dota 2 按 Ctrl+V 发送。不做任何注入，VAC 安全。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          value={text}
          placeholder="稳住，我们能赢"
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void send()} disabled={busy || !text.trim()}>
            {busy ? '翻译中…' : '翻译并复制'}
          </Button>
          <Select value={tone} onChange={(e) => pickTone(e.target.value as ReplyTone)}>
            {REPLY_TONES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
          <span className="text-xs text-muted-foreground">Enter 发送 · Shift+Enter 换行</span>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={crossTone}
              onChange={(e) => {
                setCrossTone(e.target.checked)
                void window.api.setSettings({ crossToneLookup: e.target.checked })
              }}
            />
            语气不同也查词库
          </label>
        </div>
        {result && !result.ok && (
          <p className="rounded-md border border-destructive p-2 text-sm text-destructive">
            {result.error}
          </p>
        )}
        {result?.ok && result.translated && (
          <div className="space-y-1 rounded-md bg-stone-900/60 p-3">
            <p className="font-mono text-sm text-emerald-400">{result.translated}</p>
            <p className="text-xs text-muted-foreground">
              {result.copied ? '已复制到剪贴板 · 切回游戏按 Ctrl+V 发送' : '未写入剪贴板'}
              {result.copied && countdown > 0 ? '（' + countdown + 's）' : ''}
            </p>
          </div>
        )}
        {history.length > 0 && (
          <div className="space-y-1 border-t border-border pt-2">
            <p className="text-xs text-muted-foreground">最近回复 · 点击回填重译</p>
            {history.map((item) => (
              <button
                key={item.translated + '-' + item.at}
                type="button"
                onClick={() => refill(item)}
                className="block w-full rounded px-1 py-0.5 text-left font-mono text-xs text-stone-400 hover:bg-stone-800/60 hover:text-stone-200"
              >
                {item.translated}
                <span className="ml-2 font-sans text-[10px] text-stone-600">{item.draft}</span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
/**
 * 标题栏右侧的版本号与更新入口。
 * 装好的包里开机就会静默查一次（主进程 updater），这里只负责把状态翻译成人话，
 * 以及在 ready 时把按钮变成「重启并更新」——绝不替用户重启。
 */
function UpdateBadge(): React.ReactElement {
  const [version, setVersion] = useState('')
  const [state, setState] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.appVersion().then(setVersion)
    return window.api.onUpdateStatus(setState)
  }, [])

  const ready = state?.status === 'ready'
  const label = ((): string => {
    if (busy) return '检查中…'
    if (!state) return '检查更新'
    switch (state.status) {
      case 'checking':
        return '检查中…'
      case 'downloading':
        return '下载 ' + (state.percent ?? 0) + '%'
      case 'ready':
        return '重启并更新'
      case 'none':
        return '已是最新'
      case 'error':
        return '检查失败'
      case 'dev':
        return '开发模式'
      default:
        return '检查更新'
    }
  })()

  const run = async (): Promise<void> => {
    if (ready) {
      await window.api.updateInstall()
      return
    }
    setBusy(true)
    setState(await window.api.updateCheck())
    setBusy(false)
  }

  return (
    <div className="app-no-drag flex items-center gap-2">
      {version ? (
        <span className="text-[11px] text-muted-foreground">
          v{version}
          {state?.channel === 'nightly' ? ' · Nightly' : ''}
        </span>
      ) : null}
      <Button
        size="sm"
        variant={ready ? 'default' : 'outline'}
        disabled={busy}
        onClick={() => void run()}
        title={state?.message ?? '从 GitHub Releases 检查新版本'}
      >
        {label}
      </Button>
    </div>
  )
}

export default function App(): React.ReactElement {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [test, setTest] = useState<TestState>({ status: 'idle' })
  const [saveFlash, setSaveFlash] = useState('')
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    window.api
      .getSettings()
      .then(setSettings)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
  }, [])

  const patchProvider = (p: Partial<AppSettings['provider']>): void =>
    setSettings((s) => ({ ...s, provider: { ...s.provider, ...p } }))

  const applyPreset = (id: ProviderId): void => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === id)
    if (!preset) return
    patchProvider({ id, baseUrl: preset.baseUrl, model: preset.model })
  }

  const save = async (): Promise<void> => {
    try {
      // 只落本页拥有的字段。整对象回写会把别的页/主进程后来写的字段（音色包自动激活的
      // 参考路径、引擎选择）按本页挂载时的旧值盖回去——实测：填个 key 保存，就把已配好的
      // sovits 参考清空、引擎打回 edge。setSettings 的契约本来就是 Partial 补丁。
      const next = await window.api.setSettings({
        provider: settings.provider,
        proxyUrl: settings.proxyUrl,
        targetLang: settings.targetLang,
        whisperBinPath: settings.whisperBinPath,
        ttsOutputDevice: settings.ttsOutputDevice,
      })
      setSettings(next)
      setSaveFlash('已保存')
    } catch (e) {
      setSaveFlash(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    }
    setTimeout(() => setSaveFlash(''), 2500)
  }

  const runTest = async (): Promise<void> => {
    setTest({ status: 'running' })
    try {
      setTest({ status: 'done', result: await window.api.testProvider(settings.provider) })
    } catch (e) {
      setTest({
        status: 'done',
        result: { ok: false, message: e instanceof Error ? e.message : String(e) }
      })
    }
  }

  const [voiceBusy, setVoiceBusy] = useState(false)
  const [voiceProbe, setVoiceProbe] = useState<VoiceProbeResult | null>(null)
  const [voiceAssets, setVoiceAssets] = useState<VoiceAssetsResult | null>(null)
  const [ttsResult, setTtsResult] = useState<VoicePreviewResult | null>(null)
  const [voiceProgress, setVoiceProgress] = useState<VoiceAssetProgress | null>(null)

  useEffect(() => window.api.onWhisperProgress((progress) => setVoiceProgress(progress)), [])

  const setupWhisper = async (): Promise<void> => {
    setVoiceBusy(true)
    setVoiceProgress(null)
    try {
      setVoiceAssets(await window.api.whisperSetup())
    } catch (e) {
      setVoiceAssets({
        ok: false,
        binaryPath: null,
        modelPath: null,
        error: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setVoiceBusy(false)
    }
  }

  const probeWhisper = async (): Promise<void> => {
    setVoiceBusy(true)
    try {
      setVoiceProbe(await window.api.whisperProbe(settings.whisperBinPath))
    } catch (e) {
      setVoiceProbe({
        ok: false,
        configured: false,
        error: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setVoiceBusy(false)
    }
  }

  const previewTts = async (): Promise<void> => {
    setVoiceBusy(true)
    setTtsResult(null)
    try {
      const result = await window.api.ttsPreview('小心，他们可能在打肉山，快回来')
      setTtsResult(result)
      if (result.ok && result.audioBase64) {
        const audio = new Audio(`data:${result.audioMime ?? 'audio/mp3'};base64,${result.audioBase64}`)
        void audio.play()
      }
    } catch (e) {
      setTtsResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
    } finally {
      setVoiceBusy(false)
    }
  }

  const preset = PROVIDER_PRESETS.find((p) => p.id === settings.provider.id)

  return (
    <div className="min-h-screen">
      {/* 覆盖式标题栏：整条可拖动，右侧留给系统的三颗按钮（pr-32 让开它们） */}
      <header className="app-drag sticky top-0 z-20 flex h-[38px] items-center justify-between border-b border-border/60 bg-background/85 pr-32 backdrop-blur">
        <div className="flex items-center gap-2 pl-3 text-[13px] font-medium tracking-tight">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          oh-my-dota2
          <span className="font-normal text-muted-foreground">· 零注入的队友沟通工具</span>
        </div>
        <UpdateBadge />
      </header>

      <div className="mx-auto max-w-6xl px-6 pb-12 pt-5">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">控制面板</h1>
          <p className="text-sm text-muted-foreground">
            翻译、捕获、浮层与语音都在这里；改完即时生效，无需重启。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{settings.provider.model || '未设置模型'}</Badge>
          <Badge variant="outline">代理：{settings.proxyUrl || '直连'}</Badge>
        </div>
      </div>

      {loadError ? (
        <p className="mb-4 rounded-md border border-destructive p-3 text-sm text-destructive">
          读取配置失败：{loadError}
        </p>
      ) : null}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">总览</TabsTrigger>
          <TabsTrigger value="provider">翻译模型</TabsTrigger>
          <TabsTrigger value="try">翻译试用</TabsTrigger>
          <TabsTrigger value="capture">浮层与对局</TabsTrigger>
          <TabsTrigger value="voice">语音</TabsTrigger>
          <TabsTrigger value="about">关于</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewCard />
        </TabsContent>

        <TabsContent value="provider">
          <Card>
            <CardHeader>
              <CardTitle>LLM 模型服务</CardTitle>
              <CardDescription>任意 OpenAI 兼容接口。默认预设为 DeepSeek；请求经下方代理发出，留空则直连。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="preset">预设</Label>
                <Select
                  id="preset"
                  value={settings.provider.id}
                  onChange={(e) => applyPreset(e.target.value as ProviderId)}
                >
                  {PROVIDER_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="baseUrl">接口地址</Label>
                <Input
                  id="baseUrl"
                  value={settings.provider.baseUrl}
                  onChange={(e) => patchProvider({ baseUrl: e.target.value })}
                  placeholder="https://api.deepseek.com"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="apiKey">API Key {preset && !preset.needsKey ? '（可不填）' : ''}</Label>
                <Input
                  id="apiKey"
                  type="password"
                  value={settings.provider.apiKey}
                  onChange={(e) => patchProvider({ apiKey: e.target.value })}
                  placeholder="sk-…"
                />
                {preset && preset.needsKey && !settings.provider.apiKey && (
                  <p className="text-xs text-amber-500">
                    还没有填写 API Key：翻译会一直停在「未翻译」。去 {preset.label} 控制台建一个再填进来，安装包里不会带任何人的 key。
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="model">模型</Label>
                <Input
                  id="model"
                  value={settings.provider.model}
                  onChange={(e) => patchProvider({ model: e.target.value })}
                  placeholder="deepseek-chat"
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="proxy">代理</Label>
                  <Input
                    id="proxy"
                    value={settings.proxyUrl}
                    onChange={(e) => setSettings((s) => ({ ...s, proxyUrl: e.target.value }))}
                    placeholder="http://127.0.0.1:7890（留空直连）"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="targetLang">浮层译文语言</Label>
                  <Select
                    id="targetLang"
                    value={settings.targetLang}
                    onChange={(e) => setSettings((s) => ({ ...s, targetLang: e.target.value }))}
                  >
                    <option value="zh-CN">简体中文</option>
                    <option value="zh-TW">繁體中文</option>
                    <option value="en">English</option>
                  </Select>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Button onClick={() => void save()}>保存</Button>
                <Button variant="secondary" onClick={() => void runTest()} disabled={test.status === 'running'}>
                  {test.status === 'running' ? '测试中…' : '测试连接'}
                </Button>
                {saveFlash ? <span className="text-sm text-muted-foreground">{saveFlash}</span> : null}
                {test.status === 'done' ? (
                  <Badge variant={test.result.ok ? 'success' : 'destructive'}>
                    {test.result.ok
                      ? `正常 ${test.result.latencyMs ?? '?'} 毫秒`
                      : `失败：${test.result.message.slice(0, 80)}`}
                  </Badge>
                ) : null}
              </div>
              {test.status === 'done' && test.result.message ? (
                <p className="text-xs text-muted-foreground">{test.result.message}</p>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="try">
          <div className="grid gap-4 md:grid-cols-2">
            <TranslateTryCard
              title="队友发言 → 中文"
              description="游戏内英文聊天，翻译后送到浮层"
              direction="en-zh"
              initial="careful mid, they smoke rosh"
            />
            <TranslateTryCard
              title="我的回复 → 英文"
              description="你输入的内容会翻译后写入剪贴板"
              direction="zh-en"
              initial="小心点，他们可能在打肉山"
            />
          </div>
        </TabsContent>

        <TabsContent value="capture">
          <OverlayCard />
          <div className="mt-4">
            <SendCard />
          </div>
          <div className="mt-4">
            <ReplyCard />
          </div>
        </TabsContent>

        <TabsContent value="voice">
          <Card>
            <CardHeader>
              <CardTitle>语音链路</CardTitle>
              <CardDescription>whisper.cpp 在本机运行（资源自动下载）；麦克风采集与 TTS 均已接通。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="whisperBin">whisper.cpp 可执行文件路径</Label>
                <Input
                  id="whisperBin"
                  value={settings.whisperBinPath}
                  onChange={(e) => setSettings((s) => ({ ...s, whisperBinPath: e.target.value }))}
                  placeholder="C:\\tools\\whisper.cpp\\whisper-cli.exe"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ttsDevice">TTS 输出设备（虚拟声卡）</Label>
                <Input
                  id="ttsDevice"
                  value={settings.ttsOutputDevice}
                  onChange={(e) => setSettings((s) => ({ ...s, ttsOutputDevice: e.target.value }))}
                  placeholder="CABLE Input (VB-Audio Virtual Cable)"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button className="w-fit" onClick={() => void save()}>
                  保存
                </Button>
                <Button
                  variant="outline"
                  disabled={voiceBusy}
                  onClick={() => void probeWhisper()}
                >
                  探测 whisper.cpp
                </Button>
                <Button variant="outline" disabled={voiceBusy} onClick={() => void setupWhisper()}>
                  下载 whisper 资源
                </Button>
                <Button variant="outline" disabled={voiceBusy} onClick={() => void previewTts()}>
                  试听 TTS
                </Button>
              </div>
              {voiceProgress && (
                <p className="text-xs text-muted-foreground">
                  正在下载 {voiceProgress.phase} · {voiceProgress.pct}%
                </p>
              )}
              {voiceAssets && (
                <div className="space-y-1 rounded-md bg-stone-900/60 p-3 text-sm">
                  <p className={voiceAssets.ok ? 'text-emerald-400' : 'text-red-400'}>
                    {voiceAssets.ok ? '资源就绪' : '资源准备失败'}
                  </p>
                  {voiceAssets.binaryPath && (
                    <p className="text-xs text-muted-foreground">可执行文件 · {voiceAssets.binaryPath}</p>
                  )}
                  {voiceAssets.modelPath && (
                    <p className="text-xs text-muted-foreground">模型 · {voiceAssets.modelPath}</p>
                  )}
                  {voiceAssets.error && <p className="text-xs text-destructive">{voiceAssets.error}</p>}
                </div>
              )}
              {ttsResult && (
                <div className="space-y-1 rounded-md bg-stone-900/60 p-3 text-sm">
                  <p className={ttsResult.ok ? 'text-emerald-400' : 'text-red-400'}>
                    {ttsResult.ok ? `TTS 正常 · ${ttsResult.voice ?? ''}` : 'TTS 失败'}
                  </p>
                  {ttsResult.error && <p className="text-xs text-destructive">{ttsResult.error}</p>}
                </div>
              )}
              {voiceProbe && (
                <div className="space-y-1 rounded-md bg-stone-900/60 p-3 text-sm">
                  <p className={voiceProbe.ok ? 'text-emerald-400' : 'text-red-400'}>
                    {voiceProbe.ok ? '正常' : '异常'}
                    {voiceProbe.detail ? ` · ${voiceProbe.detail}` : ''}
                  </p>
                  {voiceProbe.note && (
                    <p className="text-xs text-muted-foreground">{voiceProbe.note}</p>
                  )}
                  {voiceProbe.error && (
                    <p className="text-xs text-destructive">{voiceProbe.error}</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="about">
          <Card>
            <CardHeader>
              <CardTitle>里程碑</CardTitle>
              <CardDescription>完整架构见 docs/DESIGN.md。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>✅ M1 骨架 —— 设置面板、模型服务层</p>
              <p>✅ M2 聊天捕获 —— 游戏内框选、PaddleOCR、去重、透明浮层</p>
              <p>✅ M3 回复链路 —— 中→英翻译 + 剪贴板交付（面板 + 浮层回复栏）</p>
              <p>✅ M4 语音骨架 —— whisper.cpp 探测、TTS 试听</p>
              <p>✅ M5 日常可用 —— 托盘常驻、自动开始捕获、总览自检、过滤自己的发言</p>
              <p>✅ M6 语音链路 —— whisper.cpp 资源、麦克风采集、msedge-tts</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      </div>
    </div>
  )
}
