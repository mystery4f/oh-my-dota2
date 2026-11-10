import { useState } from 'react'
import { HOTWORD_LIMIT, joinHotwords, mergeHotwords, parseHotwords } from '@shared/asr-hotwords'
import { Input } from '@/components/ui/input'

/**
 * 热词 chip 编辑器：打词回车（或打出分隔符、粘贴逗号串）成词，× 删除，Backspace 删末词。
 * 每次提交都过 parse→merge→join，落盘的永远是规范串，存储里不会再留全角逗号；
 * 提交按词发生、没有逐键保存，worker 的识别器不会跟着敲键重载。
 * @author mystery4f
 */
export function HotwordEditor({
  value,
  onChange,
  disabled
}: {
  /** 存储里的热词串（可能是没规范化的旧值，显示前先 parse）。 */
  value: string
  /** 提交规范化后的新串；面板规则即时保存，这里没有保存按钮。 */
  onChange: (next: string) => void
  /** 引擎不吃热词时整体只读：词表照显示，改不动。 */
  disabled: boolean
}): React.ReactElement {
  const [draft, setDraft] = useState('')
  const words = parseHotwords(value)
  const full = words.length >= HOTWORD_LIMIT

  const commit = (raw: string): void => {
    const next = mergeHotwords(value, parseHotwords(raw))
    if (next !== value) onChange(next)
    setDraft('')
  }

  const remove = (word: string): void => {
    onChange(joinHotwords(words.filter((w) => w !== word)))
  }

  const onDraftChange = (raw: string): void => {
    // 打到分隔符（中英文逗号、顿号、分号、空白）就把已成的词直接收下，粘贴整串也走这条路。
    if (/[,，、;；\s]/.test(raw)) commit(raw)
    else setDraft(raw)
  }

  return (
    <div className="space-y-1.5">
      {words.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {words.map((word) => (
            <span key={word} className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs">
              {word}
              <button
                type="button"
                disabled={disabled}
                onClick={() => remove(word)}
                aria-label={`删除 ${word}`}
                className="text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          disabled={disabled || full}
          placeholder={full ? `已达上限 ${HOTWORD_LIMIT} 词，先删一个再加` : '容易认错的词，回车收下一个'}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(draft)
            else if (e.key === 'Backspace' && draft === '' && words.length > 0) remove(words[words.length - 1])
            else if (e.key === 'Escape') setDraft('')
          }}
          onBlur={() => {
            if (draft.trim() !== '') commit(draft)
          }}
          className="h-8 w-64 text-sm"
        />
        <span className="text-xs text-muted-foreground">
          {words.length}/{HOTWORD_LIMIT}
        </span>
      </div>
    </div>
  )
}
