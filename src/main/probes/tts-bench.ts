import { app } from 'electron'
import { DEFAULT_EDGE_VOICE, synthesizeEdge } from '../services/voice/edge'
import { splitForSpeech } from '../services/voice/speech'

/** 十句典型对局台词：只量「合成一次要多久、成功率多少」，不碰播放。 */
const LINES = [
  '莉娜说，推上路',
  '影魔说，中路没人，小心蹲',
  '队友甲说，插个眼再打',
  '队友乙说，他们打肉山了',
  '队友丙说，我先回去了',
  '队友丁说，谢谢',
  '队友戊说，gg wp',
  '队友己说，把塔推了再说',
  '队友庚说，我残血别跟',
  '队友辛说，马上到'
]

export async function runTtsBenchProbe(): Promise<void> {
  const started = Date.now()
  const rows: { ok: boolean; ms: number; bytes: number }[] = []
  for (const line of LINES) {
    const at = Date.now()
    const audio = await synthesizeEdge(line, DEFAULT_EDGE_VOICE, 1)
    rows.push({ ok: Boolean(audio), ms: Date.now() - at, bytes: audio?.length ?? 0 })
  }
  const ok = rows.filter((row) => row.ok)
  const sorted = ok.map((row) => row.ms).sort((a, b) => a - b)
  const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  // 音高必须真的改变音频：同句同嗓，低音高与高音高各合成一次，字节数与长度都该不同。
  // 只断「两者不同」而不是「多长」——字节数随内容波动，钉死数字只会天天红。
  const [low, high] = await Promise.all([
    synthesizeEdge('莉娜说，推上路', DEFAULT_EDGE_VOICE, 1, 0.75),
    synthesizeEdge('莉娜说，推上路', DEFAULT_EDGE_VOICE, 1, 1.25)
  ])
  const pitchOk = Boolean(low && high && low.length > 0 && high.length > 0 && low.length !== high.length)
  // 分段必须「切完拼回来一字不差」，否则朗读会吞字；第一段还要真的更短，否则等于没切。
  const longLine = '影魔说，中路没人小心蹲一下，他们可能在打肉山了，我们先插个眼再过去，不要分散走'
  const segments = splitForSpeech(longLine)
  const segmentsOk =
    segments.join('') === longLine &&
    segments.length > 1 &&
    segments.every((segment) => segment.length <= 40) &&
    segments[0].length < longLine.length
  // 首段延迟：用户抱怨的「慢半拍」就是这一项，整句 1.2 s 而首段 0.5 s 才算真的改善。
  const firstAt = Date.now()
  const firstAudio = await synthesizeEdge(segments[0], DEFAULT_EDGE_VOICE, 1)
  const firstSegmentMs = Date.now() - firstAt
  const wholeAt = Date.now()
  const wholeAudio = await synthesizeEdge(longLine, DEFAULT_EDGE_VOICE, 1)
  const wholeMs = Date.now() - wholeAt
  console.log(
    'TTS_BENCH',
    JSON.stringify({
      lines: rows.length,
      ok: ok.length,
      rate: Number((ok.length / rows.length).toFixed(2)),
      p50Ms: p50,
      maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
      wallMs: Date.now() - started,
      pitchOk,
      segmentsOk,
      segmentCount: segments.length,
      firstSegmentMs,
      wholeMs,
      firstAudioOk: Boolean(firstAudio),
      wholeAudioOk: Boolean(wholeAudio),
      rows
    })
  )
  // app.exit 会立刻掐断管道，stdout 里的结果就丢了；先让日志刷出去再退。
  await new Promise((resolve) => setTimeout(resolve, 500))
  app.exit(pitchOk && segmentsOk && ok.length > 0 ? 0 : 1)
}
