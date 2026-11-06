// Dev helper: spawns `electron-vite dev` with a query string appended to the
// renderer URL, so the dashboard opens straight into a specific view instead of
// the default panel. Used by `npm run dev:panel` and `npm run dev:proto`.
import { spawn } from 'node:child_process'

const query = (process.argv[2] || '').trim()
if (!query) {
  console.error('usage: node scripts/dev-query.mjs <key=value>[&key=value]')
  process.exit(1)
}

const child = spawn('npx', ['electron-vite', 'dev'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, OMD2_QUERY: query }
})
child.on('exit', (code) => process.exit(code ?? 0))
