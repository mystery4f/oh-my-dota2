import { useCallback, useEffect, useState } from 'react'
import type { SovitsVoicePack } from '@shared/ipc'

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export interface VoicePacksApi {
  /** null = 还没拿到清单（首次请求在路上） */
  packs: SovitsVoicePack[] | null
  /** 当前生效的那个包；没有参考音频时为 undefined */
  current: SovitsVoicePack | undefined
  error: string | null
  /** 选用/装包进行中：这一次要等下载，按钮得按不住 */
  busy: boolean
  select: (id: string) => void
  install: (id: string) => void
  remove: (id: string) => void
  reload: () => void
}

const POLL_MS = 2000

/**
 * 音色包的唯一取数入口：清单、下载进度、选用、删除都从这里走。
 * `active` 为假时一个请求都不发——朗读页只在 engine=sovits 时开，
 * 弹窗只在打开时开，所以平时不会有人 2 秒敲一次本地 IPC。
 *
 * 轮询不自己停：装了包之后进度要接着报，停了就看不到正在下的那个。
 * 界面关掉时 effect 清理会把定时器带走。
 */
export function useVoicePacks(active: boolean): VoicePacksApi {
  const [packs, setPacks] = useState<SovitsVoicePack[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!active) return
    let alive = true
    const pull = (): void => {
      void window.api
        .sovitsVoicepacks()
        .then((list) => {
          if (alive) setPacks(list)
        })
        .catch((err: unknown) => {
          if (alive) setError(asMessage(err))
        })
    }
    pull()
    const timer = window.setInterval(pull, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [active, version])

  /**
   * 选包：已就绪的直接激活；没装/可升级的先装完再激活——
   * 装包只在「还没配任何参考」时自动选中，用户主动挑的这条得自己补。
   */
  const select = useCallback(
    (id: string): void => {
      const pack = packs?.find((item) => item.id === id)
      if (!pack) return
      setError(null)
      setBusy(true)
      const job = pack.installed && !pack.upgradable
        ? window.api.sovitsSelectPack(id)
        : window.api.sovitsVoicepackInstall(id).then(() => window.api.sovitsSelectPack(id))
      void job
        .catch((err: unknown) => setError(asMessage(err)))
        .then((list) => {
          setBusy(false)
          if (list) setPacks(list)
        })
    },
    [packs]
  )

  const install = useCallback((id: string): void => {
    setError(null)
    void window.api
      .sovitsVoicepackInstall(id)
      .then(setPacks)
      .catch((err: unknown) => setError(asMessage(err)))
  }, [])

  const remove = useCallback((id: string): void => {
    setError(null)
    void window.api
      .sovitsVoicepackDelete(id)
      .then(setPacks)
      .catch((err: unknown) => setError(asMessage(err)))
  }, [])

  const reload = useCallback((): void => {
    setVersion((n) => n + 1)
  }, [])

  return {
    packs,
    current: packs?.find((pack) => pack.active),
    error,
    busy,
    select,
    install,
    remove,
    reload
  }
}
