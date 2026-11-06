/**
 * 折叠组的展开状态：localStorage 一份，读写都走这里。
 * 拆成独立文件是因为组件文件不许再导出普通函数（react-refresh 警告）。
 *
 * 订阅这一层是为搜索服务的：命中折叠组里的行时，那页可能已经挂载，
 * 只写 localStorage 不会让已挂载的组自己翻开——必须通知它。
 */
const COLLAPSE_KEY = 'oh-my-dota2.collapse'
const listeners = new Set<() => void>()

export function readCollapseOpen(id: string, fallback: boolean): boolean {
  try {
    const saved = window.localStorage.getItem(`${COLLAPSE_KEY}.${id}`)
    if (saved !== null) return saved === '1'
  } catch {
    // localStorage 不可用（隐私模式等）就退回默认收起。
  }
  return fallback
}

export function writeCollapseOpen(id: string, open: boolean): void {
  try {
    window.localStorage.setItem(`${COLLAPSE_KEY}.${id}`, open ? '1' : '0')
  } catch {
    // 存不进去也只是这次会话内记得，不值得报错。
  }
  for (const listener of listeners) listener()
}

export function subscribeCollapse(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 搜索命中折叠组里的行时，跳转前把它展开（已挂载的组靠订阅跟上）。 */
export function openCollapseGroup(id: string): void {
  writeCollapseOpen(id, true)
}
