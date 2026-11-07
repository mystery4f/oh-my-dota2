import * as React from 'react'
import {
  advanceRecording,
  initialRecordingState,
  shouldKeepTake,
  takeLineId,
  type RecordingStepState
} from '@shared/train/recording'
import { encodeWav16k } from '@shared/wav'

/** 一次录音的目标：录哪一组、哪一段。自由说组用 T 段，逐句组用 L 段。 */
export interface RecorderTarget {
  group: string
  mode: 'lines' | 'free'
  line: number
}

interface MicGraph {
  stream: MediaStream
  ctx: AudioContext
  node: ScriptProcessorNode
}

/**
 * 录音：采样管线留在渲染端，判定全走共享纯缝（阈值、自动停、收不收都在 shared）。
 * 与推理的语音采集同款约束，训练数据才和部署时听到的一致。
 */
export function useRecorder(onSaved: () => void | Promise<void>): {
  recording: boolean
  hint: string
  begin: (target: RecorderTarget) => Promise<void>
  stop: () => Promise<void>
} {
  const [recording, setRecording] = React.useState(false)
  const [hint, setHint] = React.useState('')

  const graph = React.useRef<MicGraph | null>(null)
  const chunks = React.useRef<Float32Array[]>([])
  const sampleRate = React.useRef(48_000)
  const step = React.useRef<RecordingStepState>(initialRecordingState(0))
  const target = React.useRef<RecorderTarget | null>(null)
  const saved = React.useRef(onSaved)
  saved.current = onSaved

  // 音频回调是异步触发的，拿不到最新的闭包；stop 经 ref 中转。
  const stopRef = React.useRef<(reason?: string) => Promise<void>>(async () => {})

  const teardown = React.useCallback((): void => {
    const current = graph.current
    graph.current = null
    current?.node.disconnect()
    current?.stream.getTracks().forEach((track) => track.stop())
    if (current) void current.ctx.close()
    setRecording(false)
  }, [])

  const stop = React.useCallback(
    async (reason = ''): Promise<void> => {
      if (!graph.current) return
      teardown()
      const take = target.current
      const collected = chunks.current
      chunks.current = []
      const durationMs = Math.round((collected.reduce((sum, c) => sum + c.length, 0) / sampleRate.current) * 1000)
      const verdict = shouldKeepTake({ durationMs, speechSeen: step.current.speechSeen })
      if (!take) {
        setHint(verdict.reason ?? '没有录音目标')
        return
      }
      if (!verdict.keep) {
        setHint(reason ? `${reason}，${verdict.reason ?? ''}` : (verdict.reason ?? ''))
        return
      }
      setHint(reason ? `${reason}，保存中…` : '保存中…')
      try {
        const base64 = encodeWav16k(collected, sampleRate.current)
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
        const info = await window.api.ftRecSave(take.group, takeLineId(take.mode, take.line), bytes)
        setHint(`已存 ${info.key}（${(info.durationMs / 1000).toFixed(1)}s）`)
        await saved.current()
      } catch (err) {
        setHint(`保存失败：${String(err)}`)
      }
    },
    [teardown]
  )
  stopRef.current = stop

  const begin = React.useCallback(
    async (next: RecorderTarget): Promise<void> => {
      if (graph.current) return
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
        })
      } catch (err) {
        setHint(`拿不到麦克风：${String(err)}`)
        return
      }
      target.current = next
      chunks.current = []
      step.current = initialRecordingState(Date.now())
      setHint('录音中…')
      try {
        const ctx = new AudioContext()
        sampleRate.current = ctx.sampleRate
        const node = ctx.createScriptProcessor(4096, 1, 1)
        node.onaudioprocess = (event): void => {
          const input = event.inputBuffer.getChannelData(0)
          chunks.current.push(new Float32Array(input))
          let energy = 0
          for (const sample of input) energy += sample * sample
          const rms = Math.sqrt(energy / input.length)
          const nextStep = advanceRecording(step.current, { rms, nowMs: Date.now() })
          step.current = nextStep.state
          if (nextStep.stop) void stopRef.current(nextStep.reason ?? '')
        }
        ctx.createMediaStreamSource(stream).connect(node)
        node.connect(ctx.destination)
        graph.current = { stream, ctx, node }
        setRecording(true)
      } catch (err) {
        // 图建不起来就把状态退干净，别留下「录音中…」的僵尸态。
        stream.getTracks().forEach((track) => track.stop())
        setHint(`录音初始化失败：${String(err)}`)
        setRecording(false)
      }
    },
    []
  )

  return { recording, hint, begin, stop }
}
