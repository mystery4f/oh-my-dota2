import type { SovitsVoicePack } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { StatusPill } from './primitives'

/**
 * 音色包行内容：当前包名 + 下载进度 + 清单错误 + 「音色包…」入口。
 * 朗读和声出共用这一份——两页各写一遍已经漂移过一次（声出页丢了进度和错误显示）。
 */
export function VoicePackDisplay({
  current,
  error,
  onOpenVoicePacks
}: {
  current: SovitsVoicePack | undefined
  error: string | null
  onOpenVoicePacks?: () => void
}): React.ReactElement {
  return (
    <>
      <span className="text-sm">{current ? current.name : '还没选音色包'}</span>
      {current?.downloading ? (
        <StatusPill tone="warn">↓ {Math.round(current.progress * 100)}%</StatusPill>
      ) : null}
      {error ? <StatusPill tone="bad">{error}</StatusPill> : null}
      {onOpenVoicePacks ? (
        <Button size="sm" variant="outline" onClick={onOpenVoicePacks}>
          音色包…
        </Button>
      ) : null}
    </>
  )
}
