/**
 * 离线朗读的推理进程（普通 Node，由 `ELECTRON_RUN_AS_NODE=1` 唤起）。
 *
 * 为什么要单开进程：sherpa-onnx 的原生插件在 Electron 主进程里返回音频时会抛
 * `External buffers are not allowed`（Electron 的 Node 不允许 N-API 创建外部缓冲），
 * 同样的调用在纯 Node 下完全正常。所以合成放到子进程，主进程只收一条「WAV 写好了」的 JSON。
 *
 * 协议：stdin 每行一个请求 `{ id, text, speed, dir, out }`，stdout 每行一个回答
 * `{ id, ok, sampleRate }` 或 `{ id, ok:false, err }`。引擎只加载一次，后续请求复用。
 */
const fs = require('node:fs')
const path = require('node:path')

let sherpa = null
let engine = null
let engineKey = null

function loadEngine(request) {
  const dir = request.dir
  const kind = request.kind === 'matcha' ? 'matcha' : 'vits'
  const key = `${dir}|${kind}|${request.model ?? ''}|${request.vocoder ?? ''}`
  if (engine && engineKey === key) return engine
  if (!sherpa) sherpa = require('sherpa-onnx-node')

  // 两套架构，字段名不一样：
  // - vits（MeloTTS / piper / hf-eula…）：单个 onnx + tokens + lexicon，中文分词靠 dict 目录。
  // - matcha（icefall baker…）：声学模型 + 单独一个声码器（vocos/hifigan），少一个都建不起引擎。
  // 中文单语模型没有 espeak-ng-data，dataDir 一律不传——传了 sherpa 会去找 phontab 然后报错。
  const shared = { tokens: path.join(dir, 'tokens.txt') }
  const lexicon = path.join(dir, 'lexicon.txt')
  if (fs.existsSync(lexicon)) shared.lexicon = lexicon
  const dictDir = path.join(dir, 'dict')
  if (fs.existsSync(dictDir)) shared.dictDir = dictDir

  const model =
    kind === 'matcha'
      ? {
          matcha: {
            acousticModel: path.join(dir, request.model || 'model-steps-3.onnx'),
            vocoder: request.vocoder,
            ...shared
          }
        }
      : {
          vits: {
            model: path.join(dir, request.model || 'model.onnx'),
            ...shared,
            lengthScale: 1
          }
        }

  // 数字/时间读法：这几个 .fst 不是每个包都有，缺哪个就少传哪个，别给不存在的路径。
  const ruleFsts = ['phone.fst', 'date.fst', 'number.fst']
    .map((name) => path.join(dir, name))
    .filter((file) => fs.existsSync(file))

  engine = new sherpa.OfflineTts({
    model,
    ruleFsts: ruleFsts.join(','),
    numThreads: 2,
    provider: 'cpu',
    maxNumSentences: 1
  })
  engineKey = key
  return engine
}

function toWav(samples, sampleRate) {
  const data = Buffer.alloc(44 + samples.length * 2)
  data.write('RIFF', 0)
  data.writeUInt32LE(36 + samples.length * 2, 4)
  data.write('WAVE', 8)
  data.write('fmt ', 12)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(sampleRate, 24)
  data.writeUInt32LE(sampleRate * 2, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    data.writeInt16LE(Math.round(value * 32767), 44 + i * 2)
  }
  return data
}

// 线性重采样：pitch>1 音高升高且变短；先按 1/pitch 慢放、再按 pitch 重采样，时长基本不变。
function resample(samples, factor) {
  const out = new Float32Array(Math.floor(samples.length / factor))
  for (let i = 0; i < out.length; i += 1) {
    const pos = i * factor
    const left = Math.floor(pos)
    const right = Math.min(left + 1, samples.length - 1)
    const frac = pos - left
    out[i] = samples[left] * (1 - frac) + samples[right] * frac
  }
  return out
}

function handle(line) {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (!request || typeof request.text !== 'string') return
  try {
    const tts = loadEngine(request)
    const pitch = request.pitch ?? 1
    // 多说话人模型靠 sid 选嗓子；单说话人模型传任何值都一样。
    const audio = tts.generate({
      text: request.text.trim(),
      sid: request.sid ?? 0,
      speed: (request.speed ?? 1) / pitch
    })
    const samples = pitch === 1 ? audio.samples : resample(audio.samples, pitch)
    if (!audio.samples.length) {
      process.stdout.write(`${JSON.stringify({ id: request.id, ok: false, err: 'empty' })}\n`)
      return
    }
    fs.writeFileSync(request.out, toWav(samples, audio.sampleRate))
    process.stdout.write(
      `${JSON.stringify({ id: request.id, ok: true, sampleRate: audio.sampleRate, secs: samples.length / audio.sampleRate })}\n`
    )
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: false, err: err && err.message ? err.message : String(err) })}\n`)
  }
}

process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    handle(buffer.slice(0, index))
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
