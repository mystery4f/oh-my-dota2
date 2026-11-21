/**
 * --offline-status-probe：离线音色模型的三态判定（#153）。
 *
 * 票面三条验收钉在这里：【三种缺件原因分得开】、【四态与判据的对应落在纯缝里】、
 * 【探针不往真实 tts-models/ 写一个字节】。第三条靠「本探针全程只用假的 exists 回调」成立——
 * 这里从头到尾没有一次 `existsSync`、没有一次 `mkdir`，跑完比对目录的活儿由 CI 的 probes 卫生检查兜。
 */
import { judgeOfflineReady, offlineUiView, type OfflineFiles } from '@shared/offline-status'
import { finishProbe, probeCases } from './harness'

export function runOfflineStatusProbe(): void {
  const { cases, push } = probeCases()
  const files: OfflineFiles = {
    required: ['model.onnx', 'tokens.txt', 'lexicon.txt'],
    dict: true,
    vocoder: 'vocos-22khz-univ.onnx'
  }
  const all = (rel: string): boolean => rel !== ''

  const full = judgeOfflineReady(files, all)
  push('文件齐了就是就绪', full.ready && full.reason === null, JSON.stringify(full))

  const gone = judgeOfflineReady(files, () => false)
  push('整个目录不在报 dir-missing', !gone.ready && gone.reason === 'dir-missing', String(gone.reason))
  push('目录不在时把该有的文件都列出来', gone.missing.length === files.required.length, gone.missing.join(','))

  const noVocoder = judgeOfflineReady(files, (rel) => rel !== '../vocos-22khz-univ.onnx')
  push('只缺声码器时报 vocoder-missing，不混成 file-missing', !noVocoder.ready && noVocoder.reason === 'vocoder-missing', String(noVocoder.reason))
  push('缺声码器时 missing 只有那一个名字', noVocoder.missing.join(',') === 'vocos-22khz-univ.onnx', noVocoder.missing.join(','))

  const noDict = judgeOfflineReady(files, (rel) => rel !== 'dict')
  push('只缺 dict/ 时报 dict-missing', !noDict.ready && noDict.reason === 'dict-missing', String(noDict.reason))

  const noTokens = judgeOfflineReady(files, (rel) => rel !== 'tokens.txt')
  push('缺一个普通文件时报 file-missing 并点名', !noTokens.ready && noTokens.reason === 'file-missing' && noTokens.missing.join(',') === 'tokens.txt', JSON.stringify(noTokens))

  // 三种原因必须两两不同——这条是票面「界面才有资格说缺哪一个」的依据。
  const reasons = new Set([gone.reason, noVocoder.reason, noDict.reason])
  push('三种缺件原因是三个不同的值', reasons.size === 3, [...reasons].join('|'))

  const ready = offlineUiView({ ready: true, downloading: false, bytes: 136_000_000, error: '旧的失败' })
  push('就绪时即使还留着上一轮 error 也显示就绪', ready.state === 'ready', ready.text)
  push('就绪文案带 MB', ready.text.includes('MB'), ready.text)

  const downloading = offlineUiView({ ready: false, downloading: true, bytes: 0, error: null })
  push('下载中是 downloading', downloading.state === 'downloading', downloading.text)

  const failed = offlineUiView({ ready: false, downloading: false, bytes: 0, error: 'HTTP 404' })
  push('有 error 且未就绪 → failed 且文案带原因', failed.state === 'failed' && failed.text === '下载失败：HTTP 404', failed.text)

  const missing = offlineUiView({ ready: false, downloading: false, bytes: 0, error: null })
  push('没下过是 missing，不是 failed', missing.state === 'missing', missing.text)

  const zeroBytes = offlineUiView({ ready: true, downloading: false, bytes: 0, error: null })
  push('就绪但字节数为 0 时不写「0 MB」', zeroBytes.text === '就绪', zeroBytes.text)

  push('四种界面态互不相同', new Set([ready.state, downloading.state, failed.state, missing.state]).size === 4)

  finishProbe('OFFLINE_STATUS_PROBE', cases, { files: files.required.length })
}
