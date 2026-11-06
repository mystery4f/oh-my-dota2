import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '@shared/errors'
import type { AppSettings } from '@shared/ipc'

/**
 * 设置读写钩子：v2 面板全部设置交互只走这一个入口。
 *
 * 做三件事：
 * - 挂载时拉一次真值（翻译引擎页那种「面板要显示真值而不是初值」的老坑就没了）
 * - update(patch) 乐观更新 + 只提交本页拥有的字段；setSettings 的契约本来就是 Partial 补丁，
 *   整对象回写会把主进程后来写的字段（音色包自动激活的参考路径）按旧值盖回去
 * - 失败回滚并带回一句人话原因
 *
 * 返回值只有三样，页组件拿不到裸 setter，也就没法绕过反馈机制直接改。
 */
export function useSettings(): {
  settings: AppSettings | null
  update: (patch: Partial<AppSettings>) => Promise<void>
  loadError: string
} {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    window.api
      .getSettings()
      .then(setSettings)
      .catch((e) => setLoadError(errorMessage(e)))
  }, [])

  const update = useCallback(async (patch: Partial<AppSettings>): Promise<void> => {
    // 乐观更新前留档：失败时按字段回滚，别的字段不动。
    setSettings((prev) => (prev === null ? prev : { ...prev, ...patch }))
    try {
      const next = await window.api.setSettings(patch)
      setSettings(next)
    } catch (e) {
      setSettings((prev) => {
        if (prev === null) return prev
        const restored = { ...prev }
        for (const key of Object.keys(patch) as (keyof AppSettings)[]) delete restored[key]
        return restored
      })
      throw e
    }
  }, [])

  return { settings, update, loadError }
}

/**
 * 「已保存」微反馈：update 成功后闪 1.2 秒，失败常驻红字。
 * 一行一实例，反馈就长在触发行旁边，不再挤在页面角落的全局 flash 条里。
 */
export function useSaveFlash(): {
  flash: string
  error: string
  wrap: (p: Promise<void>) => Promise<void>
} {
  const [flash, setFlash] = useState('')
  const [error, setError] = useState('')
  const timer = useRef<number | null>(null)

  const wrap = useCallback(async (p: Promise<void>): Promise<void> => {
    try {
      await p
      setError('')
      setFlash('已保存')
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setFlash(''), 1200)
    } catch (e) {
      setFlash('')
      setError(errorMessage(e))
    }
  }, [])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  return { flash, error, wrap }
}
