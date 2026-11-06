import { useEffect, useState } from 'react'
import type { InPlaceResult, ReplyTone } from '@shared/ipc'
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

/** 最近几次原地直发的记录：只留在本页，不落设置。 */
interface DirectItem {
  draft: string
  translated: string
  ok: boolean
  at: number
}

export function ChatoutPage(): React.ReactElement {
  const { settings, update } = useSettings()
  const [busy, setBusy] = useState(false)
  const [direct, setDirect] = useState<InPlaceResult | null>(null)
  const [latency, setLatency] = useState('')
  const [history, setHistory] = useState<DirectItem[]>([])

  if (settings === null)
    return (
      <Panel>
        <Row label="配置" hint="读取中…" />
      </Panel>
    )

  const tone = settings.replyTone
  const crossTone = settings.crossToneLookup !== false
  const phrases = settings.quickPhrases

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
      setDirect(res)
      if (res.ok && res.translated && res.draft) {
        const at = Date.now()
        // 同一句译文 2 秒内重复：不重复记账。
        const head = history[0]
        const duplicate = Boolean(head) && head.translated === res.translated && at - head.at < 2000
        if (!duplicate) {
          setHistory((prev) => [{ draft: res.draft ?? '', translated: res.translated ?? '', ok: res.ok, at }, ...prev].slice(0, 5))
        }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel>
      <Group label="文字出口">
        <Row label="原地直发" htmlFor="v2-inplace" hint="游戏里 Enter 打开聊天框 → 打中文（先别回车）→ 按热键 → 后台翻译 → 自动粘回并回车。不切窗口。">
          <StatusPill tone="idle">热键见「热键」页</StatusPill>
        </Row>
        <Row label="现在就发" hint="会先读走聊天框里打好未发送的中文，翻译完粘回并回车">
          <Button disabled={busy} onClick={() => void sendInPlace()}>
            {busy ? '处理中…' : '读取聊天框并直发'}
          </Button>
        </Row>
        {direct ? (
          <Row label={direct.ok ? '已发送' : '失败'} stacked hint={latency || undefined}>
            <p className={direct.ok ? 'text-sm text-emerald-300' : 'text-sm text-destructive'}>
              {direct.ok ? (direct.translated ?? '') : (direct.error ?? '')}
            </p>
            {direct.translated ? <p className="mt-1 text-xs text-muted-foreground">{direct.draft}</p> : null}
          </Row>
        ) : null}
      </Group>

      <Group label="语气">
        <Row label="默认语气" htmlFor="v2-tone" hint="影响英文的措辞，不影响原意；直发与语音回复共用">
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

      <Group label="快捷短语">
        <Row label="浮层呼出面板用" stacked hint="方向键选择、回车复制；一行一条，存进设置立即生效">
          <PhrasesEditor phrases={phrases} onChange={(next) => void update({ quickPhrases: next })} />
        </Row>
      </Group>

      {history.length > 0 ? (
        <CollapsibleGroup id="chatout.history" label="最近直发">
          {history.map((item) => (
            <button
              key={item.translated + '-' + item.at}
              type="button"
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

/** 快捷短语编辑：textarea 一行一条，失焦时规范化（去空行、去重、上限 20）。 */
function PhrasesEditor(props: { phrases: string[]; onChange: (next: string[]) => void }): React.ReactElement {
  const [text, setText] = useState(props.phrases.join('\n'))
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setText(props.phrases.join('\n'))
    // 设置从别处更新时同步显示。
  }, [props.phrases])

  const commit = (): void => {
    const seen = new Set<string>()
    const next: string[] = []
    for (const line of text.split('\n')) {
      const item = line.trim()
      if (!item || seen.has(item)) continue
      seen.add(item)
      next.push(item)
      if (next.length >= 20) break
    }
    props.onChange(next)
    setText(next.join('\n'))
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        rows={6}
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
      />
      <p className="mt-1 text-[11px] text-muted-foreground">{saved ? '已保存' : '失焦保存 · 最多 20 条'}</p>
    </div>
  )
}
