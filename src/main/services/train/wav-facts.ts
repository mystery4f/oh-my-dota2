import { readFileSync } from 'node:fs'
import { captureLevel, capturePeak } from '@shared/voice-capture-gate'
import { WAV_BYTES_PER_SAMPLE, WAV_SAMPLE_RATE } from '@shared/wav'

/** 一条录音的声学事实：采样点、采样率、整段与最响一窗的音量。 */
export interface WavFacts {
  frames: number
  sampleRate: number
  rms: number
  peak: number
}

const EMPTY: WavFacts = { frames: 0, sampleRate: WAV_SAMPLE_RATE, rms: 0, peak: 0 }

/**
 * 读一条 PCM16 wav 的事实（体检用）。
 *
 * 为什么要自己走 chunk：录音头不一定正好 44 字节（ffmpeg 的 LIST 块、手机的 extra 块都会插队），
 * 按偏移硬读 data 在别人的文件上会读到 0 音量，于是「有声音」被判成「静音」——那是最坏的一种错。
 * 读不懂的文件给全 0：体检据此说「这条录不出话」，总比静默跳过强。
 */
export function readWavFacts(path: string): WavFacts {
  let buffer: Buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return EMPTY
  }
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return EMPTY
  }
  let offset = 12
  let sampleRate = WAV_SAMPLE_RATE
  let channels = 1
  let bits = 16
  let dataAt = -1
  let dataBytes = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(body + 2) || 1
      sampleRate = buffer.readUInt32LE(body + 4) || WAV_SAMPLE_RATE
      bits = buffer.readUInt16LE(body + 14) || 16
    } else if (id === 'data') {
      dataAt = body
      dataBytes = Math.min(size, buffer.length - body)
      break
    }
    offset = body + size + (size % 2)
  }
  if (dataAt < 0 || bits !== 16 || channels < 1) return EMPTY
  const samples = Math.floor(dataBytes / WAV_BYTES_PER_SAMPLE)
  const frames = Math.floor(samples / channels)
  if (frames <= 0) return { ...EMPTY, sampleRate }
  const mono = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      sum += buffer.readInt16LE(dataAt + (index * channels + channel) * WAV_BYTES_PER_SAMPLE)
    }
    mono[index] = sum / channels / 0x8000
  }
  return {
    frames,
    sampleRate,
    rms: captureLevel([mono], frames),
    peak: capturePeak([mono], frames, sampleRate)
  }
}
