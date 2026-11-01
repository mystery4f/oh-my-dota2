/**
 * SenseVoice 识别的推理进程（普通 Node 子进程，与 tts-offline-worker.cjs 同一套路）。
 *
 * 为什么单开进程：sherpa-onnx 的原生插件在 Electron 主进程里抛
 * `External buffers are not allowed`（N-API 外部缓冲被禁），纯 Node 下正常。
 *
 * 协议：stdin 每行一个请求 `{ id, wav }`（16k 单声道 PCM16 WAV 路径），
 * stdout 每行一个回答 `{ id, ok, text }` 或 `{ id, ok:false, err }`。引擎只加载一次。
 */
const fs = require('node:fs')

let sherpa = null
let recognizer = null
let recognizerKey = null

/**
 * 解析 16k 单声道 PCM16 WAV（编码端 @shared/wav encodeWav16k 产出）。
 * 不整段假设布局：按 RIFF 块走，找到 fmt/ 与 data/，兼容带附加块（LIST/fact）的写法。
 */
function readWav16k(file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let offset = 12
  let sampleRate = 0
  let bitsPerSample = 0
  let channels = 1
  let data = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2)
      sampleRate = buf.readUInt32LE(body + 4)
      bitsPerSample = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length))
    }
    offset = body + size + (size % 2)
  }
  if (!data || sampleRate !== 16000 || bitsPerSample !== 16) {
    throw new Error(`unexpected wav: ${sampleRate}Hz ${bitsPerSample}bit`)
  }
  const count = data.length >> 1
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i++) samples[i] = data.readInt16LE(i * 2) / 32768
  return samples
}

function loadRecognizer(request) {
  const key = `${request.dir}|${request.language ?? ''}`
  if (recognizer && recognizerKey === key) return recognizer
  if (!sherpa) sherpa = require('sherpa-onnx-node')
  const path = require('node:path')
  recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      senseVoice: {
        model: path.join(request.dir, 'model.int8.onnx'),
        // '' = 自动判语种（模型本身支持中英日韩粤）；钉 'zh' 反而伤害偶尔蹦的英文词。
        language: request.language ?? '',
        useInverseTextNormalization: 1
      },
      tokens: path.join(request.dir, 'tokens.txt'),
      numThreads: 2,
      debug: 0,
      provider: 'cpu'
    },
    decodingMethod: 'greedy_search'
  })
  recognizerKey = key
  return recognizer
}

function transcribe(request) {
  const samples = readWav16k(request.wav)
  const engine = loadRecognizer(request)
  const stream = engine.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  engine.decode(stream)
  const result = engine.getResult(stream)
  return (result && typeof result.text === 'string' ? result.text : '').trim()
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    if (!line.trim()) continue
    let request
    try {
      request = JSON.parse(line)
    } catch {
      continue
    }
    let reply
    try {
      reply = { id: request.id, ok: true, text: transcribe(request) }
    } catch (err) {
      reply = { id: request.id, ok: false, err: err instanceof Error ? err.message : String(err) }
    }
    process.stdout.write(`${JSON.stringify(reply)}\n`)
  }
})
process.stdin.on('end', () => process.exit(0))
