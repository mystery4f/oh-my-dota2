import { useEffect, useState } from 'react'
import type { InPlaceResult, ReplyTone } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Group, Row, CollapsibleGroup, Panel, SaveFlash } from '../components/primitives'
import { selectClass } from '../components/select-class'
import { useSaveFlash, useSettings } from '../use-settings'
import { phrasesLine, type RenderedPhraseGroup } from '@shared/quick-phrases'

const REPLY_TONES: { value: ReplyTone; label: string }[] = [
  { value: 'terse', label: '简短（默认）' },
  { value: 'polite', label: '客气' },
  { value: 'hurry', label: '催促' },
  { value: 'firm', label: '强硬' }
]

/** 快捷短语上限：与 `PhrasesEditor` 的保存逻辑一致，超出的行必须在页面上说出来。 */
const PHRASE_LIMIT = 20

/**
 * 一次直发失败的粗分类（#176）。
 *
 * 只按 `InPlaceResult` 的**字段结构**判断，不从文案里抠字：主进程改了措辞这里也不会误判。
 * 更细的「草稿空 / 焦点丢了」只在那句人话里说得清，所以下面永远原样显示 `error`——标签只是帮人一眼分类，
 * 不替代主进程的话。分类表暂由页面维护，主进程没有可导出的来源。
 */
type SendFailKind = 'no-draft' | 'not-translated' | 'not-sent'

const SEND_FAIL_LABEL: Record<SendFailKind, string> = {
  'no-draft': '没读到草稿',
  'not-translated': '没翻成',
  'not-sent': '没写回'
}

function failKindOf(result: InPlaceResult): SendFailKind {
  if (result.draft === null) return 'no-draft'
  if (result.translated === null) return 'not-translated'
  return 'not-sent'
}

/** 最近几次原地直发的记录：只留在本页，不落设置。 */
interface DirectItem {
  draft: string
  translated: string
  ok: boolean
  kind: SendFailKind | null
  at: number
}

export function ChatoutPage(): React.ReactElement {
  const { settings, update } = useSettings()
  const [busy, setBusy] = useState(false)
  const [direct, setDirect] = useState<InPlaceResult | null>(null)
  const [draft, setDraft] = useState('')
  const [latency, setLatency] = useState('')
  const [history, setHistory] = useState<DirectItem[]>([])
  // #117：分组与变量渲染后的样子（含未分组），只读。
  const [groups, setGroups] = useState<RenderedPhraseGroup[] | null>(null)

  // 只在进页面时读一次：分组改了要重新进页面才刷新，比每帧问一次主进程便宜。
  useEffect(() => {
    void window.api.phraseGroups().then(setGroups)
  }, [])

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
      const at = Date.now()
      const kind = res.ok ? null : failKindOf(res)
      // 同一句译文 2 秒内重复：不重复记账。失败行没有译文，用分类 + 原句去重。
      const head = history[0]
      const same =
        Boolean(head) &&
        at - head.at < 2_000 &&
        head.translated === (res.translated ?? '') &&
        head.ok === res.ok &&
        head.kind === kind
      if (!same) {
        setHistory((prev) =>
          [
            { draft: res.draft ?? '', translated: res.translated ?? '', ok: res.ok, kind, at },
            ...prev
          ].slice(0, 5)
        )
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel>
      <Group label="发一句">
        <Row
          label="发一句"
          hint="读走游戏聊天框里打好未发送的那句中文 → 翻译 → 粘回 → 回车。读不到时会说明原因（游戏没开、焦点不在聊天框、框里是空的）。"
        >
          <Button disabled={busy} onClick={() => void sendInPlace()}>
            {busy ? '处理中…' : '发送游戏聊天框里那句'}
          </Button>
        </Row>
        {direct ? (
          <Row
            label={direct.ok ? '已发送' : '没发出去'}
            stacked
            hint={latency || undefined}
          >
            <p className={direct.ok ? 'text-sm text-emerald-300' : 'text-sm text-destructive'}>
              {direct.ok ? (
                direct.translated ?? ''
              ) : (
                <>
                  <span className="font-mono text-xs">{SEND_FAIL_LABEL[failKindOf(direct)]}</span>
                  <span className="ml-2">{direct.error ?? ''}</span>
                </>
              )}
            </p>
            {direct.translated ? <p className="mt-1 text-xs text-muted-foreground">{direct.draft}</p> : null}
            {direct.ok === false && direct.draft !== null ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {direct.restored === true
                  ? '原文已放回聊天框，可以直接重发或手改'
                  : '原文没救回来，要重新打一遍'}
              </p>
            ) : null}
          </Row>
        ) : null}
        <Row
          label="先写在这里"
          stacked
          hint="这里只是记下来 / 试译用，按上面的按钮不会发这一行：真正发出去的是游戏聊天框里那句。"
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="先把想说的写在这里，免得打一半被打断丢了"
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </Row>
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
          <Row
            label="短语分组"
            hint={
              groups === null
                ? '正在读分组'
                : `${phrasesLine(groups)} · 组名手填（开局 / 团战 / 打野），变量写 {hero} / {time} / {matchid}，发出去前会换成当前对局的值`
            }
            stacked
          >
            {groups === null ? null : (
              <span className="text-xs text-muted-foreground">
                {groups
                  .map((group) => `${group.name}：${group.phrases.slice(0, 2).join(' / ')}`)
                  .join(' · ')}
              </span>
            )}
          </Row>
          <PhrasesEditor phrases={phrases} onChange={(next) => update({ quickPhrases: next })} />
        </Row>
      </Group>

      {history.length > 0 ? (
        <CollapsibleGroup id="chatout.history" label="最近直发">
          {history.map((item) => (
            <button
              key={(item.translated || item.draft) + '-' + item.at}
              type="button"
              className="block w-full px-4 py-2 text-left hover:bg-muted/40"
            >
              <span className="font-mono text-xs text-foreground">
                {item.ok ? '✓ ' : `✕ ${item.kind === null ? '' : SEND_FAIL_LABEL[item.kind]}：`}
                {item.ok ? item.translated : item.draft}
              </span>
              <span className="ml-2 text-[11px] text-muted-foreground">
                {item.ok ? item.draft : '没发出去'}
              </span>
            </button>
          ))}
        </CollapsibleGroup>
      ) : null}

      <p className="text-[11px] text-muted-foreground">
        它按下的只有 Ctrl+A / Ctrl+V / Enter：不注入、不读内存、不改游戏文件。
      </p>
    </Panel>
  )
}

/** 快捷短语编辑：textarea 一行一条，失焦时规范化（去空行、去重、上限 20）。 */
function PhrasesEditor(props: { phrases: string[]; onChange: (next: string[]) => Promise<void> }): React.ReactElement {
  const [text, setText] = useState(props.phrases.join('\n'))
  // 上一次保存丢掉了几行：不写出来，用户就是在第 21 行被静默丢弃的那一刻才发现（#176）。
  const [dropped, setDropped] = useState(0)
  const save = useSaveFlash()
  useEffect(() => {
    setText(props.phrases.join('\n'))
    // 设置从别处更新时同步显示。
  }, [props.phrases])

  const commit = (): void => {
    const seen = new Set<string>()
    const next: string[] = []
    let over = 0
    for (const line of text.split('\n')) {
      const item = line.trim()
      if (!item || seen.has(item)) continue
      if (next.length >= PHRASE_LIMIT) {
        over += 1
        continue
      }
      seen.add(item)
      next.push(item)
    }
    setDropped(over)
    void save.wrap(props.onChange(next))
    setText(next.join('\n'))
  }

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        rows={6}
        // #156：变量用 placeholder 示范，比多一行「支持三个变量」的说明更有用——人看例子会抄。
        placeholder={'{hero} 说：{time}，{matchid}'}
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
      />
      <p className="mt-1 text-[11px] text-muted-foreground">
        {save.flash || save.error ? <SaveFlash flash={save.flash} error={save.error} /> : null}
        {dropped > 0 ? (
          <span className="ml-1">
            已满 {PHRASE_LIMIT} 条：后面 {dropped} 行没加进去，先删一条再加
          </span>
        ) : save.flash || save.error ? null : (
          `失焦保存 · 上限 ${PHRASE_LIMIT} 条 · 现在 ${props.phrases.length} 条`
        )}
      </p>
    </div>
  )
}
