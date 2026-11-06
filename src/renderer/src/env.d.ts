/// <reference types="vite/client" />

import type { WindowApi } from '@shared/ipc'

declare global {
  interface Window {
    api: WindowApi
    /** 只在 `npm run panel:preview` 里存在：假设置对象，供调试脚本读。 */
    __panelStubSettings?: unknown
  }
}

export {}
