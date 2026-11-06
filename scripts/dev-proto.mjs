// PROTOTYPE (throwaway): spawns electron-vite dev with OMD2_PROTO=<a|b|c> so the
// dashboard opens straight into the panel-redesign prototype variant.
import { spawn } from 'node:child_process'

const variant = (process.argv[2] || 'a').toLowerCase()
if (!['a', 'b', 'c'].includes(variant)) {
  console.error(`unknown variant "${variant}" (use a|b|c)`)
  process.exit(1)
}

const child = spawn('npx', ['electron-vite', 'dev'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, OMD2_PROTO: variant }
})
child.on('exit', (code) => process.exit(code ?? 0))
