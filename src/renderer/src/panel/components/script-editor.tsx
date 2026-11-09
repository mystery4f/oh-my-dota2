import * as React from 'react'
import { Button } from '@/components/ui/button'
import type { FtScriptGroup } from '@shared/ipc'
import {
  addScriptGroup,
  appendScriptLine,
  deleteScriptGroup,
  deleteScriptLine,
  nextGroupId,
  recordingKey,
  renameScriptGroup,
  updateScriptLine,
  type FtScriptEdit
} from '@shared/train/recording'
import { Row } from './primitives'

/**
 * 读稿编辑器：组和句子都能增删改，改完点保存才落盘。
 *
 * 三条规矩：
 * 1. 断号合法 —— 删掉的编号不再复用，新句子永远是「这一组最大的编号 + 1」；
 * 2. 改文本不删录音 —— 旧 wav 留在磁盘上，只是不再对得上稿子（标成「需重录」），
 *    因为「从底模重训」随时可选，删了就没法回头比；
 * 3. 保存前把要发生的后果说清楚 —— 几条录音会失去归属、几句要重录。
 */
export function ScriptEditor({
  groups,
  recordedKeys,
  onClose,
  onSaved
}: {
  groups: readonly FtScriptGroup[]
  recordedKeys: readonly string[]
  onClose: () => void
  onSaved: (groups: FtScriptGroup[]) => void
}): React.ReactElement {
  const [draft, setDraft] = React.useState<FtScriptGroup[]>(() => groups.map((group) => ({ ...group })))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  const apply = (edit: FtScriptEdit): void => {
    if (!edit.ok) {
      setError(edit.error)
      return
    }
    setError(null)
    setSaved(false)
    setDraft(edit.groups)
  }

  const keys = new Set(draft.flatMap((group) => group.lines.map((line) => recordingKey(group.id, group.mode, line.no))))
  const orphanKeys = recordedKeys.filter((key) => !keys.has(key))
  const nextId = nextGroupId(draft)

  const saveScript = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.api.ftScriptSave(draft)
      setSaved(true)
      setError(null)
      onSaved(next.groups)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {draft.map((group) => (
          <div key={group.id} className="border-b border-border/60 last:border-b-0">
            <Row
              label={group.id}
              hint={group.mode === 'free' ? '自由说组：只有标题，句子现录现想' : `${group.lines.length} 句`}
            >
              <input
                className="w-56 rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                value={group.title}
                aria-label={`${group.id} 标题`}
                onChange={(event) => apply(renameScriptGroup(draft, group.id, event.target.value))}
              />
              <Button
                size="sm"
                variant="ghost"
                title="删掉整组（已经录下的 wav 不删，只是不再进数据集）"
                onClick={() => apply(deleteScriptGroup(draft, group.id))}
              >
                删组
              </Button>
            </Row>
            {group.mode === 'free' ? null : (
              <div className="px-4 pb-3">
                {group.lines.map((line) => {
                  const stale = recordedKeys.includes(recordingKey(group.id, 'lines', line.no))
                  return (
                    <div key={line.no} className="flex items-center gap-2 py-1">
                      <span className={stale ? 'w-10 text-xs text-amber-300' : 'w-10 text-xs text-muted-foreground'}>
                        L{String(line.no).padStart(2, '0')}
                      </span>
                      <input
                        className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                        value={line.text}
                        aria-label={`${group.id} 第 ${line.no} 句`}
                        onChange={(event) => apply(updateScriptLine(draft, recordingKey(group.id, 'lines', line.no), event.target.value))}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        title={`删掉第 ${line.no} 句（编号不复用）`}
                        onClick={() => apply(deleteScriptLine(draft, recordingKey(group.id, 'lines', line.no)))}
                      >
                        ✕
                      </Button>
                    </div>
                  )
                })}
                <Button size="sm" variant="outline" className="mt-1" onClick={() => apply(appendScriptLine(draft, group.id, '新的一句'))}>
                  加一句
                </Button>
              </div>
            )}
          </div>
        ))}
        <div className="px-4 py-3">
          <Button
            size="sm"
            variant="outline"
            disabled={nextId === null}
            title={nextId === null ? 'G01–G99 的编号用完了' : `新增 ${nextId}`}
            onClick={() => apply(addScriptGroup(draft, '新的一组'))}
          >
            新增组{nextId === null ? '' : `（${nextId}）`}
          </Button>
        </div>
      </div>
      <div className="shrink-0 border-t border-border/70 px-4 py-3">
        {error ? <p className="mb-2 text-xs text-destructive">{error}</p> : null}
        {orphanKeys.length > 0 ? (
          <p className="mb-2 text-xs text-amber-300">
            {orphanKeys.length} 条录音不再对应稿子（wav 还留着，只是不进数据集）：{orphanKeys.slice(0, 6).join('、')}
            {orphanKeys.length > 6 ? ' …' : ''}
          </p>
        ) : null}
        <p className="mb-2 text-xs text-muted-foreground">
          改过的句子要重录；只在末尾加新句才能「接着上次权重」训练，其余改动都要「从底模重训」。
        </p>
        <div className="flex items-center justify-end gap-2">
          {saved ? <span className="text-xs text-emerald-300">已保存</span> : null}
          <Button size="sm" variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void saveScript()}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  )
}
