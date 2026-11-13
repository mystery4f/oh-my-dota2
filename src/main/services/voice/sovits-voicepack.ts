import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { downloadResumable } from '../net/download'
import { createInstallJob, type InstallJob } from '../install-job'
import { SOVITS_SEED_REF_DIR, type SovitsVoicePack } from '@shared/ipc'
import { loadSettings } from '../settings'
import {
  isSafeRelPath,
  listSovitsRefs,
  readRefsRaw,
  sovitsRefsFile,
  sovitsRefsRoot,
  sovitsWeightsRoot,
  writeRefsRaw
} from './sovits-refs'
import { activateSovitsRef, recordSovitsLog } from './sovits-server'
import { synthesizeEdge } from './edge'
import { DEFAULT_EDGE_VOICE } from '@shared/tts-voices'
import { notifyVoiceOutMutation } from './mutations'

/**
 * 英雄音色包：参考音频 + 成对的微调权重，从魔搭公开仓一键拉齐。
 *
 * 权重文件（每个约 230MB）不进 GitHub Release——仓库已 460MB 且国内拉不动，
 * 魔搭直连满速；引擎包同理走魔搭。训练产物只此一个分发源，URL 全在下面的目录里。
 *
 * 落位（全部在数据根，重装引擎包不冲掉）：
 *   - 参考音频 → tts/sovits-refs/<id>/<原名>，refs.json 由这里代写（用户仍可手编）
 *   - 微调权重 → gpt-sovits/weights/<id>/<原名>，条目里的 gptWeights/sovitsWeights 相对这一层
 */

/** 魔搭仓：用户手工建仓上传，文件名与 D:\AI 训练产物一致，上传清单见 .tmp/sovits-plan.md。 */
const VOICEPACK_REPO = 'a1078185271/oh-my-dota2-voicepacks'

export interface VoicePackFileDef {
  url: string
  /** 相对落位路径（POSIX）：参考音频相对 refs 根，权重相对 weights 根。 */
  relPath: string
  bytes: number
}

export interface VoicePackDef {
  id: string
  name: string
  /** 训练轮次标识（e15 = GPT 第 15 轮）。文件名本身就带版本，这里只是给面板看的短号。 */
  version: string
  note: string
  default: boolean
  promptText: string
  promptLang: 'zh' | 'en'
  refAudio: VoicePackFileDef
  gptWeights: VoicePackFileDef
  sovitsWeights: VoicePackFileDef
}

function modelscopeUrl(path: string): string {
  return `https://www.modelscope.cn/models/${VOICEPACK_REPO}/resolve/master/${path}`
}

/** 内置目录：离线兜底音色，远端清单可用时以远端为准；字节数取自训练产物实测。 */
export const VOICE_PACKS: VoicePackDef[] = [
  {
    id: 'mirana',
    name: '米拉娜',
    version: 'e15',
    note: '默认音色，引擎装完自动下载（约 230MB）',
    default: true,
    promptText: '从银夜森林到太阳帝权人们都是怀着敬畏和尊重说出我的名字',
    promptLang: 'zh',
    refAudio: { url: modelscopeUrl('mirana/mira_per_spawn_13.mp3'), relPath: 'mirana/mira_per_spawn_13.mp3', bytes: 73_551 },
    gptWeights: { url: modelscopeUrl('mirana/mirana-e15.ckpt'), relPath: 'mirana/mirana-e15.ckpt', bytes: 155_312_566 },
    sovitsWeights: { url: modelscopeUrl('mirana/mirana_e8_s336.pth'), relPath: 'mirana/mirana_e8_s336.pth', bytes: 85_006_749 }
  }
]

/** 清单里的相对路径规则：与库内路径同源，另加长度上限与「必须两段」（远端文件一定落在子目录里）。 */
export function safePackRelPath(p: unknown): p is string {
  return isSafeRelPath(p, { maxLength: 200, requireDir: true, forbidColon: true }) && p.length > 3
}

interface ManifestFileRaw {
  path: unknown
  bytes: unknown
}

function parseManifestFile(raw: unknown): VoicePackFileDef | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { path, bytes } = raw as ManifestFileRaw
  if (!safePackRelPath(path)) return null
  if (!Number.isInteger(bytes) || (bytes as number) <= 0 || (bytes as number) > 20 * 1024 ** 3) return null
  return { url: modelscopeUrl(path), relPath: path, bytes: bytes as number }
}

/**
 * 远端 voicepacks.json → 包目录。严格校验：schemaVersion 必须是 1，单个包坏就丢这个包
 * （别让一条坏数据废掉整份清单），一条都不剩才算失败（返回 null，走内置兜底）。
 */
export function parseVoicePackManifest(raw: unknown): VoicePackDef[] | null {
  if (typeof raw !== 'object' || raw === null) return null
  const top = raw as { schemaVersion?: unknown; packs?: unknown }
  if (top.schemaVersion !== 1 || !Array.isArray(top.packs)) return null
  const packs: VoicePackDef[] = []
  for (const item of top.packs) {
    if (typeof item !== 'object' || item === null) continue
    const p = item as Record<string, unknown>
    if (typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(p.id)) continue
    if (typeof p.name !== 'string' || p.name.length === 0 || p.name.length > 40) continue
    if (typeof p.version !== 'string' || p.version.length === 0 || p.version.length > 32) continue
    if (typeof p.promptText !== 'string' || p.promptText.length === 0 || p.promptText.length > 500) continue
    if (p.promptLang !== 'zh' && p.promptLang !== 'en') continue
    const refAudio = parseManifestFile(p.refAudio)
    const gptWeights = parseManifestFile(p.gptWeights)
    const sovitsWeights = parseManifestFile(p.sovitsWeights)
    if (!refAudio || !gptWeights || !sovitsWeights) continue
    packs.push({
      id: p.id,
      name: p.name,
      version: p.version,
      note: typeof p.note === 'string' ? p.note.slice(0, 120) : '',
      default: p.default === true,
      promptText: p.promptText,
      promptLang: p.promptLang,
      refAudio,
      gptWeights,
      sovitsWeights
    })
  }
  return packs.length > 0 ? packs : null
}

/** 远端目录与内置目录按 id 合并：远端赢（同 id 覆盖），内置独有的补在后面；没人当默认时保住内置默认包。 */
export function mergeVoicePacks(remote: VoicePackDef[] | null, builtin: VoicePackDef[]): VoicePackDef[] {
  if (!remote) return builtin
  const byId = new Map(builtin.map((pack) => [pack.id, { ...pack }]))
  for (const pack of remote) byId.set(pack.id, pack)
  const merged = [...byId.values()]
  if (!merged.some((pack) => pack.default)) {
    const builtinDefault = merged.find((pack) => pack.id === builtin.find((b) => b.default)?.id)
    if (builtinDefault) builtinDefault.default = true
    else if (merged.length > 0) merged[0].default = true
  }
  return merged
}

const MANIFEST_URL = modelscopeUrl('voicepacks.json')
const MANIFEST_TTL_MS = 5 * 60_000
let manifestCache: { at: number; remote: VoicePackDef[] | null } | null = null

/** 拉一份远端清单（URL 可注入，探针用本地假源）。任何失败都返回 null，绝不抛。 */
export async function fetchVoicePackManifest(url = MANIFEST_URL): Promise<VoicePackDef[] | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    return parseVoicePackManifest(await response.json())
  } catch {
    return null
  }
}

/**
 * 面板/安装/自动装共用的目录来源：远端清单优先（5 分钟缓存），拉不到用内置兜底。
 * force 跳缓存重拉；带 url 时直连该源不落缓存（探针专用）。
 */
export async function resolveVoicePacks(opts?: { force?: boolean; url?: string }): Promise<VoicePackDef[]> {
  if (opts?.url) return mergeVoicePacks(await fetchVoicePackManifest(opts.url), VOICE_PACKS)
  if (!opts?.force && manifestCache && Date.now() - manifestCache.at < MANIFEST_TTL_MS) {
    return mergeVoicePacks(manifestCache.remote, VOICE_PACKS)
  }
  const remote = await fetchVoicePackManifest()
  // 拉挂了就继续用手里的旧缓存（哪怕是过期的），比把用户打回内置版强；从没拉到过才落兜底。
  if (remote) manifestCache = { at: Date.now(), remote }
  return mergeVoicePacks(manifestCache?.remote ?? null, VOICE_PACKS)
}

/** 音色包的条目归属规则：同名（包拥有自己的名字）或同音频路径，都算这个包的旧条目。 */
function isPackEntry(item: unknown, pack: VoicePackDef): boolean {
  if (typeof item !== 'object' || item === null) return false
  const entry = item as Record<string, unknown>
  return entry.name === pack.name || entry.audio === pack.refAudio.relPath
}

/** refs.json 落包条目（纯函数）：同名或同音频路径的旧条目先剔掉，顺带报出可删的旧音频。 */
export function packRefsMerge(
  current: unknown,
  pack: VoicePackDef
): { list: unknown[]; staleAudio: string[] } {
  const staleAudio: string[] = []
  const keep: unknown[] = []
  for (const item of Array.isArray(current) ? current : []) {
    if (!isPackEntry(item, pack)) {
      keep.push(item)
      continue
    }
    const audio = (item as Record<string, unknown>).audio
    if (typeof audio === 'string' && audio !== pack.refAudio.relPath) staleAudio.push(audio)
  }
  keep.push(refsEntryFor(pack))
  return { list: keep, staleAudio }
}

/** 换版后的孤儿清理：权重目录里不属于当前版本的文件全删；旧参考音频只删本包目录下的。 */
export function cleanupStalePackFiles(pack: VoicePackDef, staleAudio: string[], refsRoot: string, weightsRoot: string): string[] {
  const deleted: string[] = []
  const weightsDir = join(weightsRoot, pack.id)
  const keepNames = new Set([pack.gptWeights.relPath, pack.sovitsWeights.relPath].map((rel) => rel.split('/').pop() ?? ''))
  try {
    for (const name of readdirSync(weightsDir)) {
      const clean = name.replace(/\.part$/, '')
      if (!keepNames.has(clean)) {
        rmSync(join(weightsDir, name), { force: true })
        deleted.push(`weights/${pack.id}/${name}`)
      }
    }
  } catch {
    // 目录不在 = 没有孤儿，安静通过。
  }
  for (const rel of staleAudio) {
    const segments = rel.split('/')
    if (segments[0] !== pack.id || segments.length < 2) continue // 只动本包目录，用户的参考不碰
    const target = join(refsRoot, ...segments)
    try {
      rmSync(target, { force: true })
      deleted.push(rel)
    } catch {
      // 删不掉就留着，下次清理还会撞见。
    }
  }
  return deleted
}

/** 删除音色包：三件套 + refs.json 条目 + 下载进度一起清；正在使用的包直接拒绝。 */
export async function deleteVoicePack(id: string): Promise<SovitsVoicePack[]> {
  const pack = (await resolveVoicePacks()).find((item) => item.id === id)
  if (!pack) throw new Error(`unknown voicepack: ${id}`)
  const roots = packRoots(app.getPath('userData'))
  const refPath = packRefPath(pack, roots.refsRoot)
  const weightsRoot = roots.weightsRoot
  // 「正在使用」问同一个状态判定：面板上标着「使用中」的包，这里必须删不掉。
  const activeRef = loadSettings().ttsSovitsRefAudio.trim().toLowerCase()
  const state = resolvePackState(pack, roots, activeRef, readRefsRaw(roots.refsRoot))
  if (state.active) throw new Error('正在使用这个音色，先切到其他音色再删除')
  rmSync(refPath, { force: true })
  rmSync(`${refPath}.part`, { force: true })
  rmSync(join(weightsRoot, pack.id), { recursive: true, force: true })
  if (existsSync(sovitsRefsFile(roots.refsRoot))) {
    writeRefsRaw(roots.refsRoot, readRefsRaw(roots.refsRoot).filter((item) => !isPackEntry(item, pack)))
  }
  packRuns.delete(pack.id)
  recordSovitsLog('TTS_SOVITS_PACK_DELETE', { id: pack.id })
  notifyVoiceOutMutation()
  return sovitsVoicePacks()
}

/** 下载计划（纯函数，探针用）：每个文件落到哪、已在盘上多少字节、还差多少。 */
export function planVoicePackFiles(pack: VoicePackDef, refsRoot: string, weightsRoot: string): Array<{
  url: string
  dest: string
  bytes: number
  have: number
  /** 目标文件真的在、且字节数与清单一致：`.part` 下满也不算。 */
  present: boolean
}> {
  const dest = (base: string, file: VoicePackFileDef) => join(base, ...file.relPath.split('/'))
  return [pack.refAudio, pack.gptWeights, pack.sovitsWeights].map((file) => {
    const target = file === pack.refAudio ? dest(refsRoot, file) : dest(weightsRoot, file)
    let have = 0
    let present = false
    try {
      present = existsSync(target) && statSync(target).size === file.bytes
      have = present ? file.bytes : existsSync(target) ? statSync(target).size : existsSync(`${target}.part`) ? statSync(`${target}.part`).size : 0
    } catch {
      have = 0
      present = false
    }
    return { url: file.url, dest: target, bytes: file.bytes, have, present }
  })
}

/** 音色包的三件套落点：下载计划、删除、激活、面板状态全都问这一处，别再各拼一遍路径。 */
export function packRoots(userData: string): { refsRoot: string; weightsRoot: string } {
  return { refsRoot: sovitsRefsRoot(userData), weightsRoot: sovitsWeightsRoot(userData) }
}

/** 一个包在 refs 目录里的参考音频路径（绝对）。 */
export function packRefPath(pack: VoicePackDef, refsRoot: string): string {
  return join(refsRoot, ...pack.refAudio.relPath.split('/'))
}

/** 音色包此刻的全部真相：文件齐不齐、是不是正在用、记录过什么版本、能不能升级。 */
export interface VoicePackState {
  files: ReturnType<typeof planVoicePackFiles>
  installed: boolean
  active: boolean
  recordedVersion: string | null
  upgradable: boolean
}

/**
 * 唯一的状态判定：安装、面板列表、删除、升级都读这一份。
 * 以前同一个问题有三种答案（文件字节、refs 条目存在、版本标签），
 * 半截权重能同时是「已装」和「未装」——面板说未装、refs 里却选得中。
 */
export function resolvePackState(
  pack: VoicePackDef,
  roots: { refsRoot: string; weightsRoot: string },
  activeRef: string,
  refs: unknown
): VoicePackState {
  const files = planVoicePackFiles(pack, roots.refsRoot, roots.weightsRoot)
  const installed = files.every((file) => file.present)
  const recordedVersion = packVersionFromEntry(findPackEntry(refs, pack))
  return {
    files,
    installed,
    active: activeRef !== '' && activeRef === packRefPath(pack, roots.refsRoot).toLowerCase(),
    recordedVersion,
    // 文件都不在就不是「可升级」，是「没装」——版本标签只管装好的包换版。
    upgradable: installed && packUpgradable(recordedVersion, pack.version)
  }
}

/** 音色包是否已齐（三个文件都在且字节数对上——半截的 .part 不算）。 */
export function voicePackInstalled(pack: VoicePackDef, refsRoot: string, weightsRoot: string): boolean {
  return planVoicePackFiles(pack, refsRoot, weightsRoot).every((file) => file.present)
}

/**
 * refs.json 里属于这个包的原始条目：名字或音频路径对上就算（与 packRefsMerge 同一套配对规则），
 * 坏索引/没配对返回 null。纯函数，探针用。
 */
export function findPackEntry(current: unknown, pack: VoicePackDef): Record<string, unknown> | null {
  if (!Array.isArray(current)) return null
  for (const item of current) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    if (entry.name === pack.name || entry.audio === pack.refAudio.relPath) return entry
  }
  return null
}

/** 条目里记录的安装版本；缺失/类型不对返回 null（功能上线前的旧安装没有这个字段）。 */
export function packVersionFromEntry(entry: Record<string, unknown> | null): string | null {
  return typeof entry?.packVersion === 'string' && entry.packVersion.length > 0 ? entry.packVersion : null
}

/** 升级判定（纯函数）：记录过版本且与清单版本不同才算可升级——版本只是短标签，只比相等。 */
export function packUpgradable(installedVersion: string | null, manifestVersion: string): boolean {
  return installedVersion !== null && installedVersion !== manifestVersion
}

/**
 * refs.json 合并（纯函数，探针用）：按 audio 键 upsert——同路径的旧条目整条替换
 * （音色包升级后转写/权重可能都变了），别人的条目原样保留，顺序稳定（追加在尾部）。
 */
export function mergeRefsJson(current: unknown, entry: Record<string, unknown>): unknown[] {
  const list = Array.isArray(current) ? [...current] : []
  const index = list.findIndex(
    (item) => typeof item === 'object' && item !== null && (item as Record<string, unknown>).audio === entry.audio
  )
  if (index >= 0) list.splice(index, 1)
  list.push(entry)
  return list
}

/** refs.json 里音色包对应的那条手写形状（字段名与手编文件完全一致）。 */
function refsEntryFor(pack: VoicePackDef): Record<string, unknown> {
  return {
    name: pack.name,
    audio: pack.refAudio.relPath,
    promptText: pack.promptText,
    promptLang: pack.promptLang,
    gptWeights: pack.gptWeights.relPath,
    sovitsWeights: pack.sovitsWeights.relPath,
    packId: pack.id,
    packVersion: pack.version
  }
}

const packRuns = new Map<string, { downloading: boolean; progress: number; error: string | null }>()


/** 面板视图：目录 + 本地状态（在不在、下没下、进度、错误）合成一张表。 */
export async function sovitsVoicePacks(): Promise<SovitsVoicePack[]> {
  const roots = packRoots(app.getPath('userData'))
  const activeRef = loadSettings().ttsSovitsRefAudio.trim().toLowerCase()
  const packs = await resolveVoicePacks()
  const rawRefs = readRefsRaw(roots.refsRoot)
  return packs.map((pack) => {
    const run = packRuns.get(pack.id)
    // 一个包只问一次状态：已装、使用中、可升级必须来自同一份判定，不能各算各的。
    const state = resolvePackState(pack, roots, activeRef, rawRefs)
    const haveBytes = state.files.reduce((sum, file) => sum + Math.min(file.have, file.bytes), 0)
    return {
      id: pack.id,
      name: pack.name,
      version: pack.version,
      note: pack.note,
      defaultPack: pack.default,
      bytes: state.files.reduce((sum, file) => sum + file.bytes, 0),
      haveBytes,
      installed: state.installed,
      installedVersion: state.recordedVersion,
      upgradable: state.upgradable,
      downloading: run?.downloading ?? false,
      progress: run?.progress ?? 0,
      active: state.active,
      error: run?.error ?? null
    }
  })
}

/** 小文件断点续传下载：.part 在就带 Range 接着下（魔搭 206），完事原子改名。 */
export async function downloadPackFile(
  url: string,
  dest: string,
  expectedBytes: number,
  onProgress: (done: number) => void
): Promise<void> {
  // 续传、原子改名、尺寸校验都在 downloadResumable 里；这里只留这个口子的日志标签。
  await downloadResumable({
    url,
    dest,
    expectedBytes,
    onProgress: (done) => onProgress(done),
    onLog: (tag, detail) => {
      if (tag === 'RESTART') recordSovitsLog('TTS_SOVITS_PACK_RESTART', detail)
    }
  })
}

/**
 * 安装一个音色包：三个文件下载 → refs.json 落条目 → 自动选中（当前没选别的音色时）
 * → 切权重 + 预热。已在盘上就只做落条目/激活，不重下。
 */
/** 音色包按包 id 键控：不同包可以同时装，同一个包内还是单飞。 */
const packJobs = new Map<string, InstallJob>()
function jobFor(id: string): InstallJob {
  const found = packJobs.get(id)
  if (found) return found
  const job = createInstallJob()
  packJobs.set(id, job)
  return job
}

/**
 * 安装一个音色包：三个文件下载 → refs.json 落条目 → 自动选中（当前没选别的音色时）
 * → 切权重 + 预热。已在盘上就只做落条目/激活，不重下。
 */
export async function installVoicePack(id: string): Promise<SovitsVoicePack[]> {
  const pack = (await resolveVoicePacks()).find((item) => item.id === id)
  if (!pack) throw new Error(`unknown voicepack: ${id}`)
  const roots = packRoots(app.getPath('userData'))
  const run = packRuns.get(pack.id) ?? { downloading: false, progress: 0, error: null }
  await jobFor(pack.id).run({
    busyError: '这个音色包正在下载，等它结束',
    onStart: () => {
      run.downloading = true
      run.error = null
      run.progress = voicePackInstalled(pack, roots.refsRoot, roots.weightsRoot) ? 1 : 0
      packRuns.set(pack.id, run)
    },
    onProgress: (progress) => {
      run.progress = progress
    },
    onSettled: (ok, error) => {
      run.downloading = false
      if (!ok) {
        run.error = error
        recordSovitsLog('TTS_SOVITS_PACK_FAIL', { id: pack.id, err: error })
      }
      if (ok) notifyVoiceOutMutation()
    },
    work: async (report) => {
      // 三件套的落点与「在不在」只问状态判定：下载、清理、面板不可能再各说一套。
      const plan = planVoicePackFiles(pack, roots.refsRoot, roots.weightsRoot)
      const totalBytes = plan.reduce((sum, file) => sum + file.bytes, 0)
      let doneBytes = 0
      for (const file of plan) {
        if (!file.present) {
          await downloadPackFile(file.url, file.dest, file.bytes, (done) => {
            report((doneBytes + done) / totalBytes)
          })
        }
        doneBytes += file.bytes
        report(doneBytes / totalBytes)
      }
      // refs.json 落条目：换版时同名/同路径的旧条目先剔掉（包拥有自己的名字），旧参考音频记下来给清理步骤。
      const merged = packRefsMerge(readRefsRaw(roots.refsRoot), pack)
      writeRefsRaw(roots.refsRoot, merged.list)
      const stale = cleanupStalePackFiles(pack, merged.staleAudio, roots.refsRoot, roots.weightsRoot)
      if (stale.length > 0) recordSovitsLog('TTS_SOVITS_PACK_CLEANUP', { id: pack.id, files: stale })
      recordSovitsLog('TTS_SOVITS_PACK_READY', { id: pack.id, name: pack.name })
      // 自动选中：当前没配参考（或配的还是空）就选它；用户已经挑了别的音色则不动。
      const settings = loadSettings()
      if (!settings.ttsSovitsRefAudio.trim()) {
        const entry = listSovitsRefs(roots.refsRoot, roots.weightsRoot).find((item) => item.audio === pack.refAudio.relPath)
        if (entry) {
          recordSovitsLog('TTS_SOVITS_PACK_AUTO_SELECT', { id: pack.id })
          await activateSovitsRef(entry)
        }
      }
    }
  })
  return sovitsVoicePacks()
}

/**
 * 选中一个音色包：条目取自 refs.json 里装包时写下的那条，激活统一走 activateSovitsRef
 * （写设置 → 切微调权重 → 预热），与参考音频下拉、启动恢复是同一条路径。
 * 没装好的包激活不了——调用方应先装；升级会重写条目，装完再选一次即可。
 */
export async function selectVoicePack(id: string): Promise<SovitsVoicePack[]> {
  const pack = (await resolveVoicePacks()).find((item) => item.id === id)
  if (!pack) return sovitsVoicePacks()
  const refsRoot = sovitsRefsRoot(app.getPath('userData'))
  const weightsRoot = sovitsWeightsRoot(app.getPath('userData'))
  const entry = listSovitsRefs(refsRoot, weightsRoot).find((item) => item.name === pack.name)
  if (!entry) {
    recordSovitsLog('TTS_SOVITS_SELECT_PACK_SKIP', { id: pack.id, reason: 'not-installed' })
    return sovitsVoicePacks()
  }
  const ok = await activateSovitsRef(entry)
  recordSovitsLog(ok ? 'TTS_SOVITS_SELECT_PACK' : 'TTS_SOVITS_SELECT_PACK_FAIL', { id: pack.id, name: pack.name })
  return sovitsVoicePacks()
}

/** 保底参考（幂等）：库里还没有晓晓保底条目时用 Edge 现合成一条；有别的参考（音色包）不拦着。 */
export const SEED_REF_DIR = SOVITS_SEED_REF_DIR
export const SEED_REF_TEXT = '队友们小心，敌人可能在中路埋伏，我们先撤一下再来打。'

export async function ensureSovitsSeedRef(force = false): Promise<boolean> {
  const refsRoot = sovitsRefsRoot(app.getPath('userData'))
  const weightsRoot = sovitsWeightsRoot(app.getPath('userData'))
  if (!force && listSovitsRefs(refsRoot, weightsRoot).some((ref) => ref.audio === `${SEED_REF_DIR}/seed.mp3`))
    return false
  const audioPath = join(refsRoot, SEED_REF_DIR, 'seed.mp3')
  const mp3 = await synthesizeEdge(SEED_REF_TEXT, DEFAULT_EDGE_VOICE, 1)
  if (!mp3 || mp3.length === 0) {
    recordSovitsLog('TTS_SOVITS_SEED_FAIL', { reason: 'edge-empty' })
    return false
  }
  mkdirSync(join(refsRoot, SEED_REF_DIR), { recursive: true })
  writeFileSync(audioPath, mp3)
  const entry = {
    name: '晓晓（保底）',
    audio: `${SEED_REF_DIR}/seed.mp3`,
    promptText: SEED_REF_TEXT,
    promptLang: 'zh'
  }
  writeRefsRaw(refsRoot, mergeRefsJson(readRefsRaw(refsRoot), entry))
  recordSovitsLog('TTS_SOVITS_SEED_READY', { bytes: mp3.length })
  notifyVoiceOutMutation()
  return true
}

/**
 * 引擎装好后的一键拉齐（装包完成钩子 + 启动钩子共用）：
 * 默认音色包从没装过才自动下它（换版留给面板手动升级）；晓晓保底参考缺了就现合成一条（自带幂等，已有则秒返回）——失败也不拦主流程。
 */
export async function autoVoicePackSetup(): Promise<void> {
  const refsRoot = sovitsRefsRoot(app.getPath('userData'))
  const weightsRoot = sovitsWeightsRoot(app.getPath('userData'))
  const fallback = (await resolveVoicePacks()).find((pack) => pack.default)
  // 从没装过（refs 里没有记录）才自动装；换版留给面板手动升级，绝不悄悄重下 230MB。
  if (!fallback) {
    await ensureSovitsSeedRef()
    return
  }
  const everInstalled = findPackEntry(readRefsRaw(refsRoot), fallback) !== null
  if (!voicePackInstalled(fallback, refsRoot, weightsRoot) && !everInstalled) {
    recordSovitsLog('TTS_SOVITS_PACK_AUTO_INSTALL', { id: fallback.id })
    await installVoicePack(fallback.id)
    return
  }
  await ensureSovitsSeedRef()
}
