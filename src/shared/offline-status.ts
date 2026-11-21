/**
 * 离线音色模型的可测判定（#153，见 `docs/adr/asr-and-offline-testability.md`）。
 *
 * 拆出来的理由：`offlineReady()` 原先直接 `existsSync` 读 `<userData>/tts-models/…`，
 * 探针要么往真实数据目录写文件、要么什么都验不了。这里只收「文件清单 + 一个 exists 回调」，
 * 判定与 IO 就分开了。
 */
export type OfflineReason = 'dir-missing' | 'file-missing' | 'vocoder-missing' | 'dict-missing' | null

export interface OfflineFiles {
  /** 模型目录里必须存在的文件名（相对目录）。 */
  required: readonly string[]
  /** 该音色是否需要 `dict/` 子目录。 */
  dict: boolean
  /** 声码器文件名（在 `tts-models/` 根下，不在模型目录里）；vits 不需要就 null。 */
  vocoder: string | null
}

export interface OfflineReadyVerdict {
  ready: boolean
  missing: string[]
  reason: OfflineReason
}

/**
 * 判定顺序即「原因」的优先级：整个目录不在 → 模型文件缺 → 声码器缺 → dict 缺。
 * 先报最外层：目录都没下完，说「缺 vocab」只会误导。
 */
export function judgeOfflineReady(files: OfflineFiles, exists: (rel: string) => boolean): OfflineReadyVerdict {
  const missing: string[] = []
  const dirMarker = files.required[0]
  if (dirMarker !== undefined && !exists(dirMarker)) {
    // 目录整个不在：第一件必需文件也没有，说「目录不在」比逐个报缺件更接近真相。
    return { ready: false, missing: [...files.required], reason: 'dir-missing' }
  }
  for (const name of files.required) {
    if (!exists(name)) missing.push(name)
  }
  if (missing.length > 0) return { ready: false, missing, reason: 'file-missing' }
  if (files.vocoder !== null && !exists(`../${files.vocoder}`)) {
    return { ready: false, missing: [files.vocoder], reason: 'vocoder-missing' }
  }
  if (files.dict && !exists('dict')) {
    return { ready: false, missing: ['dict'], reason: 'dict-missing' }
  }
  return { ready: true, missing: [], reason: null }
}

export type OfflineUiState = 'ready' | 'missing' | 'downloading' | 'failed'

export interface OfflineUiView {
  state: OfflineUiState
  text: string
}

/**
 * 四态与判据的对应写在一处（#153）。顺序有意义：**就绪优先**——模型已在本地时，
 * 上一轮留下的 `error` 不该把界面染红；下载中其次；有 error 才算失败；否则未下载。
 */
export function offlineUiView(status: {
  ready: boolean
  downloading: boolean
  bytes: number | null
  error: string | null
}): OfflineUiView {
  if (status.ready) {
    const mb = Math.round((status.bytes ?? 0) / 1048576)
    return { state: 'ready', text: mb > 0 ? `就绪 ${mb} MB` : '就绪' }
  }
  if (status.downloading) return { state: 'downloading', text: '下载中' }
  if (status.error !== null && status.error !== '') {
    return { state: 'failed', text: `下载失败：${status.error}` }
  }
  return { state: 'missing', text: '未下载' }
}
