import { app } from 'electron'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { judgeVisionReadiness, isVisionModel, visionLine, visionShotLine, VISION_PROMPT } from '@shared/vision'
import { askScreen, buildVisionMessages, captureScreen } from '../services/vision'
import { exitProbe, finishProbe, probeCases } from './harness'

/**
 * 看图（#135）的探针：钉住「发出去的形状」「换不了模型时说人话」「截不到也不静默」。
 *
 * 这里不调真模型（一次调用就是一次账单）：payload 由纯构造函数给，探针断言它的形状；
 * 真实截屏只用来证明「图片进了 data URL 而没进磁盘」，那一步在没显示器的机器上会 SKIP。
 */
export async function runVisionProbe(): Promise<void> {
  const { cases, push } = probeCases()

  const shaped = buildVisionMessages('data:image/png;base64,AAAA')
  const content = shaped[0]?.content
  const parts = Array.isArray(content) ? content : []
  push('一次请求只有一条消息', shaped.length === 1 && shaped[0].role === 'user', String(shaped.length))
  push('这条消息装两块内容', parts.length === 2, String(parts.length))
  push(
    '第一块是提示词原文',
    parts[0]?.type === 'text' && 'text' in (parts[0] ?? {}) && (parts[0] as { text: string }).text === VISION_PROMPT,
    parts[0]?.type ?? '(none)'
  )
  push(
    '第二块是 data URL 图片（不引用磁盘路径）',
    parts[1]?.type === 'image_url' &&
      'image_url' in (parts[1] ?? {}) &&
      (parts[1] as { image_url: { url: string } }).image_url.url.startsWith('data:image/png;base64,'),
    parts[1]?.type ?? '(none)'
  )
  push(
    '提示词要位置、要「看不清就说」',
    VISION_PROMPT.includes('上路') && VISION_PROMPT.includes('看不清'),
    'prompt'
  )

  push('名字像视觉模型的认，也认得 vl', isVisionModel('qwen2.5-vl-7b') && isVisionModel('gpt-4o'), 'vl/gpt-4o')
  push('纯文本模型不认', !isVisionModel('deepseek-chat') && !isVisionModel('glm-4-plus'), 'deepseek/glm-4')

  const noKey = judgeVisionReadiness({ id: 'deepseek', model: 'gpt-4o', apiKey: '' })
  push('没 key 先拦，说的是去填 key', !noKey.ready && noKey.reason !== null && noKey.reason.includes('API key'), noKey.reason ?? '')
  const wrongModel = judgeVisionReadiness({ id: 'deepseek', model: 'deepseek-chat', apiKey: 'k' })
  push(
    '模型不收图时说「换一个能看图的」',
    !wrongModel.ready && wrongModel.reason !== null && wrongModel.reason.includes('换一个能看图'),
    wrongModel.reason ?? ''
  )
  const ok = judgeVisionReadiness({ id: 'deepseek', model: 'gpt-4o', apiKey: 'k' })
  push('能看时没有理由字段', ok.ready && ok.reason === null, ok.model)

  const failed = await askScreen({ id: 'deepseek', baseUrl: 'https://example.invalid', apiKey: 'k', model: 'deepseek-chat' })
  push('换不了模型时 askScreen 直接说不，不去截屏', !failed.ok && failed.text === '' && (failed.error ?? '').includes('换一个能看图'), failed.error ?? '')

  push(
    '成功那行写清了尺寸、用时和模型',
    visionLine({ ok: true, text: 'x', model: 'gpt-4o', providerId: 'deepseek', ms: 1234, shot: { width: 1280, height: 720, bytes: 900_000 } }) ===
      '1280×720 · 用时 1.2 秒 · gpt-4o',
    'line'
  )
  push(
    '失败那行原样给原因，不给空串',
    visionLine({ ok: false, text: '', model: 'm', providerId: 'p', ms: null, shot: null, error: '截不到画面：系统没有给出任何屏幕' }).includes('截不到画面'),
    'line'
  )
  push('体积说明写了「不落盘」', visionShotLine({ width: 1280, height: 720, bytes: 1_048_576 }).includes('不落盘'), 'shot line')

  // 真截一帧：证明图片只走 data URL，日志目录里不许多出任何文件。
  const logs = join(app.getPath('userData'), 'logs')
  const before = existsSync(logs) ? readdirSync(logs).sort().join(',') : ''
  let captured = 'skipped'
  try {
    const frame = await captureScreen()
    captured = frame.dataUrl.startsWith('data:image/png;base64,') ? 'ok' : 'bad-prefix'
    push('截到的图有像素、有字节数', frame.shot.width > 0 && frame.shot.height > 0 && frame.shot.bytes > 0, JSON.stringify(frame.shot))
  } catch (err) {
    // 这台机器拿不到桌面（无显示器/会话被锁）不是代码错，记 SKIP 但不掩盖。
    captured = 'skipped: ' + (err instanceof Error ? err.message : String(err))
  }
  const after = existsSync(logs) ? readdirSync(logs).sort().join(',') : ''
  push('截图不进 logs 目录', before === after, captureDiff(before, after))

  finishProbe('VISION_PROBE', cases, { captured, shape: parts.map((part) => part.type).join('+') })
  exitProbe(cases.every((item) => item.ok), cases)
}

/** 目录差异写成一句话：探针失败时要能立刻看出多出来的是哪个文件。 */
function captureDiff(before: string, after: string): string {
  if (before === after) return 'unchanged'
  const a = new Set(before.split(',').filter(Boolean))
  const extra = after.split(',').filter((name) => name !== '' && !a.has(name))
  return 'new: ' + (extra.join(',') || '(removed)')
}
