/**
 * 训练记录 + 数据集账本的唯一存储层：`<userData>/train/runs.db`（node:sqlite，和翻译账本同一个驱动）。
 *
 * 两张表，一次开训一行、一段录音的一个修订一行：
 * - `runs`：TrainRunRecord 的全部字段。身份/排序/过滤（id、kind、status、started_at）是列，
 *   嵌套结构（params/data/artifacts/metrics）原样存 JSON——面板要的是同一个形状，
 *   拆成列再拼回去只会多一处会漂的映射。
 * - `dataset_entries`：主键 (key, revision)，`run_id` = 吃过这条录音的那条 run，NULL = 从没训过。
 *   `revision` 只在标签（稿件文本）变的时候加一：重录同一句不算新样本，改过标签才算。
 *   指纹（bytes + mtime_ms）跟着行走，只在这种子被某个 run 打包时重写——所以「录了但没训」
 *   和「录了又改了稿」都还能靠指纹对出来。
 *   行是「当前工作清单」，会原地更新，历史靠 `runs.packed_ledger` 里那份冻结的打包快照：
 *   续训对账比的是「那次到底打包了哪些指纹」，失败的 run 也照样能续。
 *
 * 旧版落盘是 `train-runs/*.json` 加每个 run 目录里的 `dataset.jsonl`：列表要重读全部文件，
 * 「这段训过没」是线性扫描。第一次打开库时把它们原样导进来一次（meta 表记一笔），
 * 旧文件保持只读归档，不删不改（spec：删除旧文件不在范围内）。库坏了挪成 `.corrupt-<stamp>` 重建——
 * 旧文件还在，重建后能再导一遍。
 */
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { errorMessage } from '@shared/errors'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { FtLedgerEntry } from '@shared/train/asr-ft'
import { TRAIN_RUN_STATUSES, type TrainRunRecord, type TrainRunStatus } from '@shared/train/run'

/** 只留最近这么多条 run：一行几百字节到几十 KB，多到上千条才会明显占盘。 */
export const TRAIN_RUN_KEEP = 200

const FILE_NAME = 'runs.db'
/** 旧文件只导一次：导入完在 meta 里留一笔，之后的启动不再扫盘。 */
const META_LEGACY_IMPORT = 'legacy_import'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    experiment TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    applied INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    params TEXT NOT NULL,
    data TEXT NOT NULL,
    artifacts TEXT NOT NULL,
    metrics TEXT,
    packed_ledger TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
  CREATE TABLE IF NOT EXISTS dataset_entries (
    key TEXT NOT NULL,
    revision INTEGER NOT NULL,
    wav_path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    split TEXT NOT NULL,
    run_id TEXT,
    PRIMARY KEY (key, revision)
  );
  CREATE INDEX IF NOT EXISTS idx_dataset_run ON dataset_entries(run_id);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

/** 账本一行：一段录音的某个修订 + 最近一次吃过它的 run（null = 从没训过）。 */
export interface DatasetEntry {
  key: string
  revision: number
  wavPath: string
  bytes: number
  mtimeMs: number
  text: string
  split: FtLedgerEntry['split']
  runId: string | null
}

interface RunRow {
  id: string
  kind: string
  experiment: string
  status: string
  started_at: number
  ended_at: number | null
  applied: number
  error: string | null
  params: string
  data: string
  artifacts: string
  metrics: string | null
  packed_ledger: string | null
}

interface EntryRow {
  key: string
  revision: number
  wav_path: string
  bytes: number
  mtime_ms: number
  text: string
  split: string
  run_id: string | null
}

type SqlValue = string | number | null

let db: DatabaseSync | null = null
let dbFile: string | null = null
let failedFile: string | null = null
/** 探针专用：把整个存储层指到临时库，生产路径一个字节都不碰。 */
let overrideFile: string | null = null

export function trainDbPath(): string {
  return join(app.getPath('userData'), 'train', FILE_NAME)
}

/** 旧版训练记录归档目录（只读，迁移来源）。 */
export function trainRunsArchiveDir(): string {
  return join(app.getPath('userData'), 'train-runs')
}

/** ASR 微调的 run 目录根：run.json 与 checkpoint 还在这里（训练的副产物，不进库）。 */
export function asrRunDirsRoot(): string {
  return join(app.getPath('userData'), 'asr-ft-runs')
}

function currentFile(): string {
  return overrideFile ?? trainDbPath()
}

/**
 * 探针专用：指向临时库文件。关掉现有句柄，下一次访问时打开新文件；
 * 临时库不走「首次打开导旧文件」那条路，迁移由探针显式调 importLegacyTrainData 验证。
 */
export function useTrainDatabase(file: string): void {
  closeTrainStore()
  overrideFile = file
  failedFile = null
}

/** 关掉句柄，只为探针验证「落盘后重新打开还在」。 */
export function closeTrainStore(): void {
  if (db === null) return
  try {
    db.close()
  } catch {
    // 关不掉也不影响下一次打开
  }
  db = null
  dbFile = null
}

function looksCorrupt(err: unknown): boolean {
  return /malformed|not a database|disk image is malformed|database corruption/i.test(errorMessage(err))
}

/** 坏库挪走再重建：内容全在旧文件里，重建后重新导入就能救回来。 */
function quarantine(file: string, reason: string): void {
  closeTrainStore()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      if (existsSync(path)) renameSync(path, `${path}.corrupt-${stamp}`)
    } catch {
      // 挪不动就让下一次打开继续报错，至少不在这里死循环
    }
  }
  console.log('TRAIN_STORE_QUARANTINED', reason)
}

function openOnce(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true })
  const next = new DatabaseSync(file)
  try {
    next.exec('PRAGMA journal_mode = WAL')
    next.exec(SCHEMA)
    // 索引坏了 prepare/run 会抛，但 SELECT 仍能读到旧行——症状是「列表还在、新记录写不进」，
    // 所以必须在打开时查一次，别等用户发现「训练完列表没变」。
    const check = next.prepare('PRAGMA quick_check(1)').get() as { quick_check?: string } | undefined
    if (check?.quick_check !== undefined && check.quick_check !== 'ok') {
      throw new Error(`database disk image is malformed (quick_check: ${check.quick_check})`)
    }
    return next
  } catch (err) {
    try {
      next.close()
    } catch {
      // 坏库关不掉无所谓，下面按损坏处理
    }
    throw err
  }
}

function open(file = currentFile()): DatabaseSync | null {
  if (db !== null && dbFile === file) return db
  if (db !== null) closeTrainStore()
  if (failedFile === file) return null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      db = openOnce(file)
      dbFile = file
      failedFile = null
      // 生产库第一次打开时把旧文件导进来；临时库（探针）由调用方显式导入。
      if (file === trainDbPath()) importLegacyTrainData()
      return db
    } catch (err) {
      if (attempt === 0 && looksCorrupt(err)) {
        quarantine(file, errorMessage(err))
        continue
      }
      failedFile = file
      console.log('TRAIN_STORE_OPEN_FAILED', errorMessage(err))
      return null
    }
  }
  return null
}

function rows<T>(sql: string, ...params: SqlValue[]): T[] {
  const handle = open()
  if (handle === null) return []
  try {
    return handle.prepare(sql).all(...params) as T[]
  } catch (err) {
    console.log('TRAIN_STORE_READ_FAILED', errorMessage(err))
    return []
  }
}

function transact(handle: DatabaseSync, work: () => void): boolean {
  try {
    handle.exec('BEGIN IMMEDIATE')
    work()
    handle.exec('COMMIT')
    return true
  } catch (err) {
    try {
      handle.exec('ROLLBACK')
    } catch {
      // 回滚失败也要把真正的错误报出去
    }
    console.log('TRAIN_STORE_WRITE_FAILED', errorMessage(err))
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 容错解析：字段缺就补默认，类型不对就整条丢掉（旧版本文件不该让列表炸掉）。 */
function normalizeRun(value: unknown): TrainRunRecord | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' ? value.id : ''
  const kind = typeof value.kind === 'string' ? value.kind : ''
  const status = value.status
  if (!id || !kind) return null
  if (typeof status !== 'string' || !TRAIN_RUN_STATUSES.includes(status as TrainRunStatus)) return null
  const data = isRecord(value.data) ? value.data : {}
  return {
    id,
    kind: kind as TrainRunRecord['kind'],
    experiment: typeof value.experiment === 'string' ? value.experiment : '',
    params: isRecord(value.params) ? (value.params as TrainRunRecord['params']) : {},
    data: {
      files: typeof data.files === 'number' ? data.files : 0,
      durationMs: typeof data.durationMs === 'number' ? data.durationMs : 0,
      bytes: typeof data.bytes === 'number' ? data.bytes : 0
    },
    status: status as TrainRunStatus,
    startedAt: typeof value.startedAt === 'number' ? value.startedAt : 0,
    endedAt: typeof value.endedAt === 'number' ? value.endedAt : null,
    artifacts: isRecord(value.artifacts) ? (value.artifacts as TrainRunRecord['artifacts']) : {},
    metrics: isRecord(value.metrics) ? (value.metrics as unknown as TrainRunRecord['metrics']) : null,
    applied: value.applied === true,
    error: typeof value.error === 'string' ? value.error : null
  }
}

/** 行 → 记录：嵌套结构原样取回，数字列落成 number（sqlite 可能回 bigint）。 */
function runFromRow(row: RunRow): TrainRunRecord | null {
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  return normalizeRun({
    id: row.id,
    kind: row.kind,
    experiment: row.experiment,
    status: row.status,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    applied: Number(row.applied) === 1,
    error: row.error,
    params: parse(row.params),
    data: parse(row.data),
    artifacts: parse(row.artifacts),
    metrics: row.metrics === null ? null : parse(row.metrics)
  })
}

function entryFromRow(row: EntryRow): DatasetEntry {
  return {
    key: row.key,
    revision: Number(row.revision),
    wavPath: row.wav_path,
    bytes: Number(row.bytes),
    mtimeMs: Number(row.mtime_ms),
    text: row.text,
    split: row.split === 'eval' ? 'eval' : 'train',
    runId: row.run_id
  }
}

/** 一条 run 落库（同 id 覆盖）：终态、指标、应用标记都是后来的写入盖掉前面的。 */
function writeRun(handle: DatabaseSync, run: TrainRunRecord): void {
  handle
    .prepare(
      `INSERT INTO runs (id, kind, experiment, status, started_at, ended_at, applied, error, params, data, artifacts, metrics)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         experiment = excluded.experiment,
         status = excluded.status,
         started_at = excluded.started_at,
         ended_at = excluded.ended_at,
         applied = excluded.applied,
         error = excluded.error,
         params = excluded.params,
         data = excluded.data,
         artifacts = excluded.artifacts,
         metrics = excluded.metrics`
    )
    .run(
      run.id,
      run.kind,
      run.experiment,
      run.status,
      run.startedAt,
      run.endedAt ?? null,
      run.applied ? 1 : 0,
      run.error,
      JSON.stringify(run.params),
      JSON.stringify(run.data),
      JSON.stringify(run.artifacts),
      run.metrics === null ? null : JSON.stringify(run.metrics)
    )
}

/** 开训即落记录，收场再覆盖一次；追加与「按上限裁掉最旧的」在同一个事务里，断电不留半条。 */
export function saveTrainRun(run: TrainRunRecord): void {
  const handle = open()
  if (handle === null) return
  transact(handle, () => {
    writeRun(handle, run)
    handle
      .prepare('DELETE FROM runs WHERE id IN (SELECT id FROM runs ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?)')
      .run(TRAIN_RUN_KEEP)
  })
}

export function loadTrainRun(id: string): TrainRunRecord | null {
  const row = rows<RunRow>('SELECT * FROM runs WHERE id = ?', id)[0]
  return row === undefined ? null : runFromRow(row)
}

/** 最新在前：面板的列表顺序就是这个顺序，不靠调用方再排。 */
export function listTrainRuns(): TrainRunRecord[] {
  return rows<RunRow>('SELECT * FROM runs ORDER BY started_at DESC, id DESC')
    .map(runFromRow)
    .filter((run): run is TrainRunRecord => run !== null)
}

/** 读改写一次：manager 收场时补指标与产物，找不到记录就跳过。 */
export function patchTrainRun(id: string, patch: (run: TrainRunRecord) => TrainRunRecord): TrainRunRecord | null {
  const current = loadTrainRun(id)
  if (!current) return null
  const next = patch(current)
  saveTrainRun(next)
  return next
}

export function deleteTrainRun(id: string): void {
  const handle = open()
  if (handle === null) return
  try {
    handle.prepare('DELETE FROM runs WHERE id = ?').run(id)
  } catch (err) {
    console.log('TRAIN_STORE_WRITE_FAILED', errorMessage(err))
  }
}

/** 只留最近 keep 条，返回裁掉的条数。 */
export function pruneTrainRuns(keep = TRAIN_RUN_KEEP): number {
  const handle = open()
  if (handle === null) return 0
  const before = rows<{ n: number }>('SELECT COUNT(*) AS n FROM runs')[0]?.n ?? 0
  const limit = Math.max(0, Math.floor(keep))
  try {
    handle
      .prepare('DELETE FROM runs WHERE id IN (SELECT id FROM runs ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?)')
      .run(limit)
  } catch (err) {
    console.log('TRAIN_STORE_WRITE_FAILED', errorMessage(err))
    return 0
  }
  const after = rows<{ n: number }>('SELECT COUNT(*) AS n FROM runs')[0]?.n ?? 0
  return Number(before) - Number(after)
}

/**
 * 写一条账本行。同一 key 的标签变了就开新修订（旧修订留着，历史不改写）；
 * 标签没变只更新指纹与路径——重录同一句仍然是同一个修订，它训过就还是训过。
 * runId 为 null 表示「这次只是打包，还没训完」：已有的训过标记保持不变。
 */
function writeEntry(handle: DatabaseSync, entry: FtLedgerEntry, runId: string | null): 'insert' | 'update' {
  const latest = handle
    .prepare('SELECT * FROM dataset_entries WHERE key = ? ORDER BY revision DESC LIMIT 1')
    .get(entry.key) as EntryRow | undefined
  if (latest === undefined || latest.text !== entry.text) {
    handle
      .prepare(
        `INSERT INTO dataset_entries (key, revision, wav_path, bytes, mtime_ms, text, split, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.key,
        latest === undefined ? 1 : Number(latest.revision) + 1,
        entry.wavPath,
        entry.bytes,
        entry.mtimeMs,
        entry.text,
        entry.split,
        runId
      )
    return 'insert'
  }
  handle
    .prepare(
      `UPDATE dataset_entries SET wav_path = ?, bytes = ?, mtime_ms = ?, run_id = COALESCE(?, run_id)
       WHERE key = ? AND revision = ?`
    )
    .run(entry.wavPath, entry.bytes, entry.mtimeMs, runId, entry.key, Number(latest.revision))
  return 'update'
}

/**
 * 打包时记账：这一段录音现在长什么样（指纹 / 路径 / 训练或验证集）。
 * 已有的 split 不覆盖——验证集是那次划分定下的，换个 run 重新打包不该把它挪回训练集。
 * run_id 不在这里落：行是「当前工作清单」，会原地更新，标已训要等那次 run 收场成功。
 * packedBy 给的是这次打包的 run：run 行上留一份冻结快照，续训对账要的是「那次到底打包了什么」。
 */
export function saveDatasetLedger(entries: readonly FtLedgerEntry[], packedBy?: string): void {
  const handle = open()
  if (handle === null || entries.length === 0) return
  transact(handle, () => {
    for (const entry of entries) writeEntry(handle, entry, null)
    if (packedBy !== undefined) {
      handle
        .prepare('UPDATE runs SET packed_ledger = ? WHERE id = ?')
        .run(JSON.stringify(entries), packedBy)
    }
  })
}

/**
 * 录一条音就落账（run_id 空 = 还没训过）：待训数字直接读这张表，不重走录音目录。
 * 稿子没变的同 key 重录还是同一个修订（run_id 由 COALESCE 保留），所以不算新数据；
 * 改稿才是新修订。split 这里只是占位（录音时还没分验证集），权威划分冻在 runs.packed_ledger。
 */
export function recordDatasetTake(entry: FtLedgerEntry): void {
  const handle = open()
  if (handle === null) return
  transact(handle, () => writeEntry(handle, entry, null))
}

/**
 * 删掉一条录音时把未训的行一起删：否则待训数字会指着一条已经不存在的 wav。
 * 已训过的行（run_id 非空）是历史，留着。
 */
export function forgetDatasetTake(key: string): void {
  const handle = open()
  if (handle === null) return
  transact(handle, () => {
    handle.prepare('DELETE FROM dataset_entries WHERE key = ? AND run_id IS NULL').run(key)
  })
}

/** 把一条录音标成「吃过」：run_id 落到行上，NULL 才算「从没训过」。 */
export function markDatasetEntryTrained(key: string, revision: number, runId: string): boolean {
  return markDatasetEntriesTrained(runId, [{ key, revision }])
}

/** 一次 run 收场（训练成功）：把它打包的那些条目全部标成吃过——按行里的标签对，不靠重算指纹。 */
export function markDatasetEntriesTrained(
  runId: string,
  entries: readonly { key: string; text?: string; revision?: number }[]
): boolean {
  const handle = open()
  if (handle === null || entries.length === 0) return false
  const byRevision = handle.prepare('UPDATE dataset_entries SET run_id = ? WHERE key = ? AND revision = ?')
  const byText = handle.prepare('UPDATE dataset_entries SET run_id = ? WHERE key = ? AND text = ?')
  let marked = 0
  const ok = transact(handle, () => {
    for (const entry of entries) {
      const result =
        entry.revision === undefined
          ? byText.run(runId, entry.key, entry.text ?? '')
          : byRevision.run(runId, entry.key, entry.revision)
      marked += Number(result.changes)
    }
  })
  return ok && marked > 0
}

export function listDatasetEntries(): DatasetEntry[] {
  return rows<EntryRow>('SELECT * FROM dataset_entries ORDER BY key, revision').map(entryFromRow)
}

/** 按 key 找一条：给 revision 就是那一个修订，不给就是同一 key 的最新修订。 */
export function findDatasetEntry(key: string, revision?: number): DatasetEntry | null {
  const row =
    revision === undefined
      ? rows<EntryRow>('SELECT * FROM dataset_entries WHERE key = ? ORDER BY revision DESC LIMIT 1', key)[0]
      : rows<EntryRow>('SELECT * FROM dataset_entries WHERE key = ? AND revision = ?', key, revision)[0]
  return row === undefined ? null : entryFromRow(row)
}

/**
 * 一次 run 打包的快照（冻结副本）：续训对账拿它和当前账本逐条比。
 * 账本行会原地更新，所以历史只能从 run 这边的快照读；没有快照（老 run / 没打包）就是 null。
 */
export function packedLedgerForRun(runId: string): FtLedgerEntry[] | null {
  const raw = rows<{ packed_ledger: string | null }>('SELECT packed_ledger FROM runs WHERE id = ?', runId)[0]
  if (raw?.packed_ledger == null) return null
  try {
    const value: unknown = JSON.parse(raw.packed_ledger)
    if (!Array.isArray(value)) return null
    return value.filter(isRecord).flatMap((line) => {
      if (typeof line.key !== 'string' || typeof line.wavPath !== 'string') return []
      return [
        {
          key: line.key,
          wavPath: line.wavPath,
          bytes: typeof line.bytes === 'number' ? line.bytes : 0,
          mtimeMs: typeof line.mtimeMs === 'number' ? line.mtimeMs : 0,
          text: typeof line.text === 'string' ? line.text : '',
          split: line.split === 'eval' ? ('eval' as const) : ('train' as const)
        }
      ]
    })
  } catch {
    return null
  }
}

/** 已经训过的条目（覆盖标记的清单）：哪句训过、哪句重录过，都对着它比。 */
export function trainedDatasetEntries(): DatasetEntry[] {
  return rows<EntryRow>(
    'SELECT * FROM dataset_entries WHERE run_id IS NOT NULL ORDER BY key, revision'
  ).map(entryFromRow)
}

export interface LegacyImportResult {
  /** 新导入的 run 条数。 */
  runs: number
  /** 新导入的账本条目数。 */
  entries: number
  /** 已导过（meta 有标记）或库打不开，整件事跳过。 */
  skipped: boolean
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function readLegacyRun(file: string): TrainRunRecord | null {
  try {
    return normalizeRun(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

function readLegacyLedger(file: string): FtLedgerEntry[] {
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const value: unknown = JSON.parse(line)
          if (!isRecord(value) || typeof value.key !== 'string') return []
          return [
            {
              key: value.key,
              wavPath: typeof value.wavPath === 'string' ? value.wavPath : '',
              bytes: typeof value.bytes === 'number' ? value.bytes : 0,
              mtimeMs: typeof value.mtimeMs === 'number' ? value.mtimeMs : 0,
              text: typeof value.text === 'string' ? value.text : '',
              split: value.split === 'eval' ? ('eval' as const) : ('train' as const)
            }
          ]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

/**
 * 把旧版散文件导进库：`train-runs/*.json` 一条一个 run，
 * `asr-ft-runs/<目录>/dataset.jsonl` 是那次 run 吃过的录音。
 * 目录名按字典序（= 时间序）走，所以同一句录音被后来的 run 重训时，run_id 落在最后一次。
 * 幂等靠住主键：run 用 INSERT OR IGNORE，条目用「同 key 同标签就更新」——导两次不会多出任何一行。
 * 旧 run 记录里有 artifacts.runDir 的，条目挂到那条 run 的 id 上（面板/续训能直接 join）；
 * 对不上的（run 记录早被裁掉）退回目录名，至少保留「训过」这个事实。
 * 旧目录里的 dataset.jsonl 同时充作那条 run 的打包快照，所以迁移完续训也对得上。
 */
export function importLegacyTrainData(roots?: { runsDir?: string; asrRunsDir?: string }): LegacyImportResult {
  const handle = open()
  if (handle === null) return { runs: 0, entries: 0, skipped: true }
  const marker = handle.prepare('SELECT value FROM meta WHERE key = ?').get(META_LEGACY_IMPORT) as
    | { value?: string }
    | undefined
  // 生产库导过一次就不再扫盘；探针传了显式根目录，专门用来验证第二次导入是空转。
  if (marker !== undefined && roots === undefined) return { runs: 0, entries: 0, skipped: true }
  const runsDir = roots?.runsDir ?? trainRunsArchiveDir()
  const asrRunsDir = roots?.asrRunsDir ?? asrRunDirsRoot()
  let importedRuns = 0
  let importedEntries = 0
  const ok = transact(handle, () => {
    const runIdByDir = new Map<string, string>()
    for (const name of readdirSafe(runsDir)) {
      if (!name.endsWith('.json')) continue
      const run = readLegacyRun(join(runsDir, name))
      if (run === null) continue
      const before = handle.prepare('SELECT id FROM runs WHERE id = ?').get(run.id)
      if (before === undefined) {
        writeRun(handle, run)
        importedRuns++
      }
      const runDir = run.artifacts.runDir
      if (typeof runDir === 'string' && runDir.length > 0) runIdByDir.set(basename(runDir), run.id)
    }
    for (const name of readdirSafe(asrRunsDir).sort()) {
      const ledger = readLegacyLedger(join(asrRunsDir, name, 'dataset.jsonl'))
      if (ledger.length === 0) continue
      const runId = runIdByDir.get(name) ?? name
      for (const entry of ledger) {
        if (writeEntry(handle, entry, runId) === 'insert') importedEntries++
      }
      handle.prepare('UPDATE runs SET packed_ledger = ? WHERE id = ?').run(JSON.stringify(ledger), runId)
    }
    handle
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(META_LEGACY_IMPORT, String(Date.now()))
  })
  return ok ? { runs: importedRuns, entries: importedEntries, skipped: false } : { runs: 0, entries: 0, skipped: true }
}
