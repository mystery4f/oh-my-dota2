/**
 * `npm run panel:preview` — the panel in a plain browser, no Electron and no game.
 *
 * The only thing this config does beyond a normal vite dev server is prepend
 * `src/renderer/src/preview/api-stub.ts`, a typed fake `window.api`, so the renderer can boot
 * outside the main process. Nothing is faked at the IPC layer itself: the stub is checked
 * against `WindowApi`, so a channel the panel calls but the stub forgot is a type error.
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const stubPath = 'src/preview/api-stub.ts'

/** head-prepend 保证桩先于入口脚本执行，否则首帧就是 `window.api is undefined`。 */
function apiStub(): Plugin {
  return {
    name: 'panel-api-stub',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: `/${stubPath}` },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

export default defineConfig({
  root: resolve(projectRoot, 'src/renderer'),
  plugins: [apiStub(), react()],
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src/renderer/src'),
      '@shared': resolve(projectRoot, 'src/shared')
    }
  },
  server: { port: 5199, strictPort: true }
})
