import { readdir, readFile, stat, unlink, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { FtRecInfo } from '@shared/ipc'
import { parseRecordingKeyParts, RECORDING_GROUP_SHAPE, resolveFtScript } from '@shared/train/recording'
import type { FtScriptCandidate, FtScriptState } from '@shared/train/recording'

/**
 * ASR 微调录音（T4a）：读稿定位 + 录音存取。
 * 读稿优先用数据目录里的 asr-ft-script.md（用户自己的句子，改完重启生效），没有或解析不了才回落
 * 随包资源 resources/asr-ft-script.md——回落判断在纯缝里，探针锁着。录音全部落在应用数据目录
 * asr-ft/ 下（安装版是 <安装目录>-data，开发版是项目 data/），绝不引用外置盘路径。
 */

/** 16k mono 16-bit wav：32000 字节/秒，头部 44 字节。 */
const WAV_HEADER_BYTES = 44
const BYTES_PER_MS = 32

/** 随包自带的读稿：打包后在 resources/ 下，开发时在仓库 resources/。 */
export function ftScriptPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'asr-ft-script.md')
  return join(app.getAppPath(), 'resources', 'asr-ft-script.md')
}

/** 数据目录里的自定义读稿：存在就顶掉自带那份，用户不必改仓库文件。 */
export function ftUserScriptPath(): string {
  return join(app.getPath('userData'), 'asr-ft-script.md')
}

/** 读一份候选读稿：不存在/读不动就交 null，选哪份由纯缝决定。 */
async function readScriptCandidate(path: string): Promise<FtScriptCandidate> {
  try {
    return { path, markdown: await readFile(path, 'utf8') }
  } catch {
    return { path, markdown: null }
  }
}

export async function readFtScript(): Promise<FtScriptState> {
  const [data, bundled] = await Promise.all([readScriptCandidate(ftUserScriptPath()), readScriptCandidate(ftScriptPath())])
  return resolveFtScript(data, bundled)
}

function recDir(): string {
  return join(app.getPath('userData'), 'asr-ft')
}

function recPath(group: string, line: string): string {
  const keys = parseRecordingKeyParts(group, line)
  return join(recDir(), keys.group, `${keys.group}-${keys.line}.wav`)
}

function toInfo(bytes: number, key: string, mtimeMs: number): FtRecInfo {
  return { key, bytes, durationMs: Math.max(0, Math.round((bytes - WAV_HEADER_BYTES) / BYTES_PER_MS)), mtimeMs }
}

export async function ftRecList(): Promise<FtRecInfo[]> {
  const root = recDir()
  if (!existsSync(root)) return []
  const infos: FtRecInfo[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RECORDING_GROUP_SHAPE.test(entry.name)) continue
    for (const file of await readdir(join(root, entry.name))) {
      if (!file.endsWith('.wav')) continue
      const full = join(root, entry.name, file)
      const info = await stat(full)
      infos.push(toInfo(info.size, file.replace(/\.wav$/, ''), Math.round(info.mtimeMs)))
    }
  }
  return infos.sort((a, b) => a.key.localeCompare(b.key))
}

export async function ftRecSave(group: string, line: string, data: Uint8Array): Promise<FtRecInfo> {
  const keys = parseRecordingKeyParts(group, line)
  const dir = join(recDir(), keys.group)
  await mkdir(dir, { recursive: true })
  const target = join(dir, `${keys.group}-${keys.line}.wav`)
  await writeFile(target, data)
  const info = await stat(target)
  return toInfo(info.size, `${keys.group}-${keys.line}`, Math.round(info.mtimeMs))
}

export async function ftRecRead(group: string, line: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(recPath(group, line)))
}

export async function ftRecDelete(group: string, line: string): Promise<void> {
  await unlink(recPath(group, line)).catch(() => undefined)
}

/** 训练窗口「识别测试」用：把已存录音的磁盘路径给 ASR 路由复用（键同样过白名单）。 */
export function ftRecPath(group: string, line: string): string {
  return recPath(group, line)
}
