import { readdir, readFile, stat, unlink, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { FtRecInfo, FtScriptGroup, FtScriptState } from '@shared/ipc'

/**
 * ASR 微调录音（T4a）：内置读稿解析 + 录音存取。
 * 读稿是随包分发的资源（resources/asr-ft-script.md），录音全部落在应用数据目录
 * asr-ft/ 下（安装版是 <安装目录>-data，开发版是项目 data/），绝不引用外置盘路径。
 */

/** 16k mono 16-bit wav：32000 字节/秒，头部 44 字节。 */
const WAV_HEADER_BYTES = 44
const BYTES_PER_MS = 32

export function ftScriptPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'asr-ft-script.md')
  return join(app.getAppPath(), 'resources', 'asr-ft-script.md')
}

/** 解析读稿 markdown：`## Gxx 标题` 开组，`1. 文本` 收句；一组没有编号句就是自由说组。 */
export function parseFtScript(markdown: string): FtScriptGroup[] {
  const groups: FtScriptGroup[] = []
  let current: FtScriptGroup | null = null
  const noteParts: string[] = []
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const groupMatch = /^##\s+(G\d+)\s*(.*)$/.exec(line)
    if (groupMatch) {
      if (current) current.note = noteParts.join(' ')
      current = { id: groupMatch[1], title: groupMatch[2].trim(), mode: 'lines', lines: [], note: '' }
      groups.push(current)
      noteParts.length = 0
      continue
    }
    if (!current) continue
    const lineMatch = /^(\d{1,3})[.、]\s*(.+)$/.exec(line)
    if (lineMatch) current.lines.push({ no: Number(lineMatch[1]), text: lineMatch[2].trim() })
    else noteParts.push(line)
  }
  if (current) current.note = noteParts.join(' ')
  for (const group of groups) if (group.lines.length === 0) group.mode = 'free'
  return groups
}

export async function readFtScript(): Promise<FtScriptState> {
  try {
    const markdown = await readFile(ftScriptPath(), 'utf8')
    const groups = parseFtScript(markdown)
    if (groups.length === 0) return { groups: [], error: '内置读稿解析结果为空（resources/asr-ft-script.md 格式不对）' }
    return { groups, error: null }
  } catch {
    return { groups: [], error: '内置读稿缺失（resources/asr-ft-script.md）——重装或检查应用资源' }
  }
}

function recDir(): string {
  return join(app.getPath('userData'), 'asr-ft')
}

/** 组号/句号白名单，防路径穿越：组 G01，句 L03（逐句）或 T01（自由说段）。 */
function safeKeys(group: string, line: string): { group: string; line: string } {
  const g = /^G\d{2}$/.exec(group)
  const l = /^(?:L|T)\d{2}$/.exec(line)
  if (!g || !l) throw new Error(`非法的组/句号：${group}-${line}`)
  return { group: g[0], line: l[0] }
}

function recPath(group: string, line: string): string {
  const keys = safeKeys(group, line)
  return join(recDir(), keys.group, `${keys.group}-${keys.line}.wav`)
}

function toInfo(bytes: number, key: string): FtRecInfo {
  return { key, bytes, durationMs: Math.max(0, Math.round((bytes - WAV_HEADER_BYTES) / BYTES_PER_MS)) }
}

export async function ftRecList(): Promise<FtRecInfo[]> {
  const root = recDir()
  if (!existsSync(root)) return []
  const infos: FtRecInfo[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^G\d{2}$/.test(entry.name)) continue
    for (const file of await readdir(join(root, entry.name))) {
      if (!file.endsWith('.wav')) continue
      const full = join(root, entry.name, file)
      const info = await stat(full)
      infos.push(toInfo(info.size, file.replace(/\.wav$/, '')))
    }
  }
  return infos.sort((a, b) => a.key.localeCompare(b.key))
}

export async function ftRecSave(group: string, line: string, data: Uint8Array): Promise<FtRecInfo> {
  const keys = safeKeys(group, line)
  const dir = join(recDir(), keys.group)
  await mkdir(dir, { recursive: true })
  const target = join(dir, `${keys.group}-${keys.line}.wav`)
  await writeFile(target, data)
  const info = await stat(target)
  return toInfo(info.size, `${keys.group}-${keys.line}`)
}

export async function ftRecRead(group: string, line: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(recPath(group, line)))
}

export async function ftRecDelete(group: string, line: string): Promise<void> {
  await unlink(recPath(group, line)).catch(() => undefined)
}
