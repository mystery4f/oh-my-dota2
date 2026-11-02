/**
 * sherpa 识别（Qwen3-ASR）的推理进程（普通 Node 子进程，与 tts-offline-worker.cjs 同一套路）。
 *
 * 为什么单开进程：sherpa-onnx 的原生插件在 Electron 主进程里抛
 * `External buffers are not allowed`（N-API 外部缓冲被禁），纯 Node 下正常。
 *
 * 协议：stdin 每行一个请求 `{ id, wav, dir, language, hotwords }`，
 * wav 为 16k 单声道 PCM16 WAV 路径；hotwords 是热词表串（逗号分隔，可空）。
 * stdout 每行一个回答 `{ id, ok, text }` 或 `{ id, ok:false, err }`。引擎按 key 只加载一次。
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
  let pos = 12
  let fmt = null
  let data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      fmt = { audioFormat: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), sampleRate: buf.readUInt32LE(pos + 12) }
    } else if (id === 'data') {
      data = buf.subarray(pos + 8, Math.min(pos + 8 + size, buf.length))
    }
    pos += 8 + size + (size % 2)
  }
  if (!fmt || !data || fmt.audioFormat !== 1 || fmt.sampleRate !== 16000 || fmt.channels !== 1) {
    throw new Error(`unsupported wav: ${JSON.stringify(fmt)}`)
  }
  const count = data.length >> 1
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i++) samples[i] = data.readInt16LE(i * 2) / 32768
  return samples
}

function loadRecognizer(request) {
  // 缓存键带上热词：词表变了要重载引擎（sherpa 的 hotwords 是构造期配置）。
  const key = `${request.dir}|${request.language ?? ''}|${request.hotwords ?? ''}`
  if (recognizer && recognizerKey === key) return recognizer
  if (!sherpa) sherpa = require('sherpa-onnx-node')
  const path = require('node:path')
  // Qwen3-ASR（方言/抗噪强，中文更准；自带动词级标点）。tokenizer 是目录不是单文件。
  recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      qwen3Asr: {
        convFrontend: path.join(request.dir, 'conv_frontend.onnx'),
        encoder: path.join(request.dir, 'encoder.int8.onnx'),
        decoder: path.join(request.dir, 'decoder.int8.onnx'),
        tokenizer: path.join(request.dir, 'tokenizer'),
        hotwords: request.hotwords ?? '',
        maxTotalLen: 512,
        maxNewTokens: 512,
        temperature: 1e-6,
        topP: 0.8,
        seed: 42
      },
      tokens: '',
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
