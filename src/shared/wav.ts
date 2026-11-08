/** Target sample rate for whisper.cpp (16 kHz mono PCM16). */
export const WAV_SAMPLE_RATE = 16_000

/** 标准 PCM 的 44 字节头（RIFF / fmt / data 三段）：编码与「字节数 → 时长」共用这一份。 */
export const WAV_HEADER_BYTES = 44

/** 一个采样的字节数（16 bit）。 */
export const WAV_BYTES_PER_SAMPLE = 2

/** 16 kHz 单声道 16 bit = 32000 字节/秒 = 32 字节/毫秒（别的地方不要再写 32）。 */
export const WAV_BYTES_PER_MS = (WAV_SAMPLE_RATE * WAV_BYTES_PER_SAMPLE) / 1000

/**
 * Downmix captured audio chunks to 16 kHz mono PCM16 and wrap them in a WAV
 * container. Returns base64 so the bytes can cross the IPC boundary.
 */
export function encodeWav16k(chunks: Float32Array[], inputRate: number): string {
  const ratio = inputRate / WAV_SAMPLE_RATE
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  const outLength = Math.floor(total / ratio)
  const samples = new Int16Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.min(merged.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j += 1) sum += merged[j]
    const value = end > start ? sum / (end - start) : 0
    samples[i] = Math.max(-1, Math.min(1, value)) * 0x7fff
  }
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + samples.length * WAV_BYTES_PER_SAMPLE)
  const view = new DataView(buffer)
  const writeText = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, WAV_HEADER_BYTES - 8 + samples.length * WAV_BYTES_PER_SAMPLE, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, WAV_SAMPLE_RATE, true)
  view.setUint32(28, WAV_SAMPLE_RATE * WAV_BYTES_PER_SAMPLE, true)
  view.setUint16(32, WAV_BYTES_PER_SAMPLE, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, samples.length * WAV_BYTES_PER_SAMPLE, true)
  for (let i = 0; i < samples.length; i += 1) view.setInt16(WAV_HEADER_BYTES + i * WAV_BYTES_PER_SAMPLE, samples[i], true)
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}
