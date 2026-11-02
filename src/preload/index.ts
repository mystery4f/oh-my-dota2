// 预加载桥（#30）：不再手写 78 个映射——两个契约表循环绑定，
// 漏通道/错签名直接在 tsc 处爆炸，运行时只剩「通道名 → ipcRenderer 调用」一层。
import { contextBridge, ipcRenderer } from 'electron'
import { ipcContract, voiceOutContract, type ApiTable, type ChannelDef, type WindowApi } from '@shared/ipc'

function bindChannels<T extends Record<string, ChannelDef>>(table: T): ApiTable<T> {
  const bound = {} as ApiTable<T>
  for (const [name, def] of Object.entries(table)) {
    switch (def.kind) {
      case 'invoke':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bound[name as keyof ApiTable<T>] = ((...args: any[]) => ipcRenderer.invoke(def.channel, ...args)) as any
        break
      case 'send':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bound[name as keyof ApiTable<T>] = ((...args: any[]) => ipcRenderer.send(def.channel, ...args)) as any
        break
      case 'listen': {
        const listen = (callback: (payload: unknown) => void) => {
          const wrapped = (_event: unknown, payload: unknown): void => callback(payload)
          ipcRenderer.on(def.channel, wrapped)
          return () => ipcRenderer.removeListener(def.channel, wrapped)
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bound[name as keyof ApiTable<T>] = listen as any
        break
      }
    }
  }
  return bound
}

const api: WindowApi = { ...bindChannels(ipcContract), voiceOut: bindChannels(voiceOutContract) }

contextBridge.exposeInMainWorld('api', api)
