import { useRef, useState } from 'react'
import { HOTWORD_LIMIT, joinHotwords, mergeHotwords, parseHotwords } from '@shared/asr-hotwords'
import { Input } from '@/components/ui/input'

/**
 * Hotword chip editor: Enter (or a separator, or a pasted comma string) commits a word, x removes one, Backspace pops the last.
 * Every commit goes through parse→merge→join so storage always holds a canonical string; commits are per word,
 * never per keystroke, so the worker's recognizer does not reload while typing.
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
  const composingRef = useRef(false)
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

  const settle = (raw: string): void => {
    // One settlement pass: a separator (CJK/ASCII comma, dunhao, semicolon, whitespace) commits the finished words; a pasted string takes the same path.
    if (/[,，、;；\s]/.test(raw)) commit(raw)
    else setDraft(raw)
  }

  const onDraftChange = (raw: string): void => {
    // While the IME composition is live (pinyin not yet committed), only mirror it into the draft — never settle.
    if (composingRef.current) {
      setDraft(raw)
      return
    }
    settle(raw)
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
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false
            settle(e.currentTarget.value)
          }}
          onKeyDown={(e) => {
            // Every keypress during an IME composition belongs to the composition, not to the editor.
            if (composingRef.current || e.nativeEvent.isComposing) return
            if (e.key === 'Enter') commit(draft)
            else if (e.key === 'Backspace' && draft === '' && words.length > 0) remove(words[words.length - 1])
            else if (e.key === 'Escape') setDraft('')
          }}
          onBlur={() => {
            if (!composingRef.current && draft.trim() !== '') commit(draft)
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
