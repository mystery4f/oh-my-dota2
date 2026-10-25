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
let engineDir = null

function loadEngine(dir, modelName) {
  if (engine && engineDir === dir) return engine
  if (!sherpa) sherpa = require('sherpa-onnx-node')
  // MeloTTS 是 VITS 架构：单个 model.onnx（fp32；官方包的 .int8.onnx 只是 133 字节的
  // Git LFS 指针，加载会直接崩进程，所以别指过去）。dict 目录给中文分词/多音字用。
  // ruleFsts 负责「19 → 十九」「10:30 → 十点半」这类数字与时间读法。
  engine = new sherpa.OfflineTts({
    model: {
      vits: {
        model: path.join(dir, modelName || 'model.onnx'),
        lexicon: path.join(dir, 'lexicon.txt'),
        tokens: path.join(dir, 'tokens.txt'),
        dictDir: path.join(dir, 'dict'),
        lengthScale: 1
      },
      numThreads: 2,
      provider: 'cpu'
    },
    ruleFsts: [
      path.join(dir, 'phone.fst'),
      path.join(dir, 'date.fst'),
      path.join(dir, 'number.fst')
    ].join(','),
    maxNumSentences: 1
  })
  engineDir = dir
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
    const tts = loadEngine(request.dir, request.model)
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
