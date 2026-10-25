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
  type OfflineVoiceId
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
  const [engine, setEngine] = useState<'system' | 'edge' | 'offline'>('edge')
  const [offline, setOffline] = useState<{ ready: boolean; bytes: number; downloading: boolean; progress: number; error: string | null } | null>(null)
  useEffect(() => {
    void window.api.ttsOfflineState().then(setOffline)
  }, [])
  const [voice, setVoice] = useState(DEFAULT_EDGE_VOICE)
  const [offlineVoice, setOfflineVoice] = useState<OfflineVoiceId>('melo')
  const [rate, setRate] = useState(1)
  const [pitch, setPitch] = useState(1)
  const [nicknames, setNicknames] = useState('')
  const [autoStart, setAutoStart] = useState(DEFAULT_SETTINGS.autoStartCapture)

  useEffect(() => {
    // 面板要显示真值而不是初值：朗读默认关，浮层状态平时只靠广播。
    void window.api.getSettings().then((next) => {
      setReadAloud(next.ttsReadAloud)
      setEngine(next.ttsEngine)
      setVoice(next.ttsVoice || DEFAULT_EDGE_VOICE)
      setOfflineVoice(next.ttsOfflineVoice ?? 'keqing')
      setRate(next.ttsRate)
      setPitch(next.ttsPitch)
      setNicknames(next.myNicknames.join(', '))
      setAutoStart(next.autoStartCapture)
    })
    void window.api.overlayReplyState().then(setOverlay)
    return window.api.onOverlayState(setOverlay)
  }, [])

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
          {/* 两个下拉：左边选路子（分类），右边选具体嗓子（选项）。
              分类只有三种，选项随分类变；系统嗓子没有选项，右侧控件保持禁用而不是消失——
              消失会让布局跳动，用户也会以为刚选的东西丢了。 */}
          <select
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
            value={engine}
            onChange={(e) => {
              const next = e.target.value as 'system' | 'edge' | 'offline'
              setEngine(next)
              void window.api.setSettings({ ttsEngine: next })
            }}
            title="语音来源：联网最自然、本地不依赖网络、系统嗓子仅兜底"
          >
            <option value="edge">联网 · 神经语音</option>
            <option value="offline">本地 · 离线模型</option>
            <option value="system">兜底 · 系统嗓子</option>
          </select>
          <select
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
            value={engine === 'offline' ? offlineVoice : voice}
            disabled={engine === 'system'}
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
      setSettings(await window.api.setSettings(settings))
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
        const audio = new Audio(`data:audio/mp3;base64,${result.audioBase64}`)
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
