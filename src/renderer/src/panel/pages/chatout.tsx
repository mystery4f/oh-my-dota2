import { useEffect, useState } from 'react'
import type { ReplyResult, ReplySendResult, ReplyTone } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Group, Row, StatusPill, CollapsibleGroup, Panel } from '../components/primitives'
import { useSettings } from '../use-settings'

const REPLY_TONES: { value: ReplyTone; label: string }[] = [
  { value: 'terse', label: '简短（默认）' },
  { value: 'polite', label: '客气' },
  { value: 'hurry', label: '催促' },
  { value: 'firm', label: '强硬' }
]

const selectClass = 'h-8 rounded-md border border-input bg-background px-2 text-sm'
const SEND_MODE_HINT: Record<string, string> = {
  inplace: '游戏里按 Enter 打中文 → 按热键 → 后台翻译 → 自动粘回并回车。不切窗口。',
  chat: '打中文 → 回车 → 翻成英文 → 自动切回游戏、粘贴进聊天框并回车。',
  console: '走控制台 say_team，需要 Dota 2 启动项 -console，逐字符发送，慢但不碰聊天框。'
}
/** 草稿跟着人走：切页、重开面板都不丢。键名与旧面板一致，升级不吞草稿。 */
const DRAFT_KEY = 'oh-my-dota2.replyDraft'
/** 复制成功的倒计时提示秒数。 */
const COPY_HINT_SECONDS = 8

interface HistoryItem {
  draft: string
  translated: string
  tone: ReplyTone
  at: number
}

export function ChatoutPage(): React.ReactElement {
  const { settings, update } = useSettings()
  const [draft, setDraft] = useState(() => localStorage.getItem(DRAFT_KEY) ?? '')
  const [busy, setBusy] = useState(false)
  const [sendResult, setSendResult] = useState<ReplySendResult | null>(null)
  const [reply, setReply] = useState<ReplyResult | null>(null)
  const [latency, setLatency] = useState('')
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [countdown, setCountdown] = useState(0)

  useEffect(() => {
    if (draft) localStorage.setItem(DRAFT_KEY, draft)
    else localStorage.removeItem(DRAFT_KEY)
  }, [draft])

  useEffect(() => {
    if (countdown <= 0) return
    const timer = setTimeout(() => setCountdown((n) => n - 1), 1000)
    return () => clearTimeout(timer)
  }, [countdown])

  if (settings === null)
    return (
      <Panel>
        <Row label="配置" hint="读取中…" />
      </Panel>
    )

  const mode = settings.sendMode
  const tone = settings.replyTone
  const crossTone = settings.crossToneLookup !== false
  const inplace = mode === 'inplace'

  const sendInPlace = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await window.api.translateInPlace()
      setLatency(
        [
          res.grabMs === undefined ? null : `读聊天框 ${res.grabMs}ms`,
          res.translateMs === undefined ? null : `翻译 ${res.translateMs}ms`,
          res.sendMs === undefined ? null : `写回 ${res.sendMs}ms`
        ]
          .filter(Boolean)
          .join(' · ')
      )
      setSendResult({
        ok: res.ok,
        draft: res.draft ?? '',
        translated: res.translated,
        command: res.translated,
        error:
          res.restored === false && res.error
            ? `${res.error}（原文没放回聊天框，需要自己再打一遍）`
            : res.error
      })
    } finally {
      setBusy(false)
    }
  }

  const sendAndCopy = async (text = draft.trim()): Promise<void> => {
    if (!text || busy) return
    setBusy(true)
    setReply(null)
    try {
      const result = await window.api.translateReply(text, tone)
      setReply(result)
      if (result.ok && result.translated) {
        const at = Date.now()
        const head = history[0]
        // 同一句译文 2 秒内重复：不重复记账，也不重置倒计时。
        const duplicate = Boolean(head) && head.translated === result.translated && at - head.at < 2000
        if (!duplicate) {
          setHistory((prev) => [{ draft: text, translated: result.translated ?? '', tone, at }, ...prev].slice(0, 5))
          setCountdown(COPY_HINT_SECONDS)
        }
        setDraft('')
      }
    } catch (e) {
      setReply({ ok: false, translated: null, copied: false, error: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const handleSend = async (): Promise<void> => {
    if (inplace) return sendInPlace()
    if (!draft.trim()) return
    setBusy(true)
    try {
      setSendResult(await window.api.sendReply(draft))
    } finally {
      setBusy(false)
    }
  }

  return (
      <Panel>
        <Group label="怎么发">
          <Row label="发送通道" htmlFor="v2-sendMode" hint={SEND_MODE_HINT[mode]}>
            <select
              id="v2-sendMode"
              value={mode}
              onChange={(e) => void update({ sendMode: e.target.value as 'inplace' | 'chat' | 'console' })}
              className={`${selectClass} max-w-64`}
            >
              <option value="inplace">原地替换游戏聊天框（推荐）</option>
              <option value="chat">浮层输入后粘贴发送</option>
              <option value="console">控制台 say_team（需 -console，慢）</option>
            </select>
          </Row>
          {mode === 'console' ? (
            <Row label="控制台开关键" hint="默认反斜杠；你改过启动项就填同一个键">
              <input
                maxLength={1}
                value={settings.consoleKey}
                onChange={(e) => void update({ consoleKey: e.target.value })}
                onBlur={() => void update({ consoleKey: settings.consoleKey.trim().slice(0, 1) || '\\' })}
                className="h-8 w-12 rounded-md border border-input bg-background px-2 text-center font-mono text-sm"
              />
            </Row>
          ) : null}
        </Group>

        <Group label="发什么">
          {inplace ? (
            <Row label="打中文的位置" hint="游戏里 Enter 打开聊天框 → 打中文（先别回车）→ 按「发送消息」热键">
              <StatusPill tone="idle">热键见「热键」页</StatusPill>
            </Row>
          ) : (
            <Row label="要发的话" stacked hint="回车发送 · Shift+回车换行">
              <textarea
                value={draft}
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void handleSend()
                  }
                }}
                placeholder="稳住，我们能赢"
                className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <div className="mt-2 flex items-center gap-2">
                <Button disabled={busy || !draft.trim()} onClick={() => void handleSend()}>
                  {busy ? '翻译中…' : '翻译并发送'}
                </Button>
                <Button variant="outline" disabled={busy || !draft.trim()} onClick={() => void sendAndCopy()}>
                  只翻译并复制
                </Button>
              </div>
            </Row>
          )}
          {inplace ? (
            <Row label="现在就发" hint="会先读走聊天框里的中文，翻译完再粘回并回车">
              <Button disabled={busy} onClick={() => void handleSend()}>
                {busy ? '处理中…' : '读取聊天框并直发'}
              </Button>
            </Row>
          ) : null}
        </Group>

        <Group label="语气">
          <Row label="默认语气" htmlFor="v2-tone" hint="影响英文的措辞，不影响原意">
            <select
              id="v2-tone"
              value={tone}
              onChange={(e) => void update({ replyTone: e.target.value as ReplyTone })}
              className={selectClass}
            >
              {REPLY_TONES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="跨语气查词库" hint="同一句话换个语气也能命中之前译过的结果">
            <input
              type="checkbox"
              checked={crossTone}
              onChange={(e) => void update({ crossToneLookup: e.target.checked })}
              className="size-4"
            />
          </Row>
        </Group>

        {sendResult || reply ? (
          <Group label="上次结果">
            {sendResult ? (
              <Row
                label={sendResult.ok ? '已发送' : '失败'}
                stacked
                hint={latency || undefined}
              >
                <p className={sendResult.ok ? 'text-sm text-emerald-300' : 'text-sm text-destructive'}>
                  {sendResult.ok ? (sendResult.command ?? '') : (sendResult.error ?? '')}
                </p>
                {sendResult.translated && sendResult.translated !== sendResult.command ? (
                  <p className="mt-1 font-mono text-xs text-muted-foreground">译文：{sendResult.translated}</p>
                ) : null}
              </Row>
            ) : null}
            {reply && !reply.ok ? (
              <Row label="翻译失败" stacked>
                <p className="text-sm text-destructive">{reply.error}</p>
              </Row>
            ) : null}
            {reply?.ok && reply.translated ? (
              <Row
                label={reply.copied ? '已复制到剪贴板' : '未写入剪贴板'}
                stacked
                hint={
                  reply.copied
                    ? `切回游戏按 Ctrl+V 发送${countdown > 0 ? `（${countdown}s 后提示消失）` : ''}`
                    : '可以直接点上面的「翻译并发送」走聊天框'
                }
              >
                <p className="font-mono text-sm text-emerald-300">{reply.translated}</p>
              </Row>
            ) : null}
          </Group>
        ) : null}

        {history.length > 0 ? (
          <CollapsibleGroup id="chatout.history" label="最近回复">
            {history.map((item) => (
              <button
                key={item.translated + '-' + item.at}
                type="button"
                onClick={() => {
                  setDraft(item.draft)
                  void update({ replyTone: item.tone })
                  void sendAndCopy(item.draft)
                }}
                className="block w-full px-4 py-2 text-left hover:bg-muted/40"
              >
                <span className="font-mono text-xs text-foreground">{item.translated}</span>
                <span className="ml-2 text-[11px] text-muted-foreground">{item.draft}</span>
              </button>
            ))}
          </CollapsibleGroup>
        ) : null}
      </Panel>
  )
}
