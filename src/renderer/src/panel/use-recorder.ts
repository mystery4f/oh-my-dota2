import * as React from 'react'
import type { FtRecInfo } from '@shared/ipc'
import {
  advanceRecording,
  initialRecordingState,
  shouldKeepTake,
  takeLineId,
  type RecordingStepState
} from '@shared/train/recording'
import { encodeWav16k } from '@shared/wav'
import { startPcmRecorder, type PcmRecorder } from '../lib/pcm-recorder'

/** 一次录音的目标：录哪一组、哪一段。自由说组用 T 段，逐句组用 L 段。 */
export interface RecorderTarget {
  group: string
  mode: 'lines' | 'free'
  line: number
}

/**
 * 录音：采样图用共享的 lib/pcm-recorder（与对讲同一条），判定全走共享纯缝（阈值、自动停、收不收都在 shared）。
 * 与推理的语音采集同款约束，训练数据才和部署时听到的一致。
 * onSaved 只在写盘成功后调用，并且带上刚存下的那条——「存完去哪一句」归调用方，
 * 失败（存不上/没麦克风）压根不会走到回调，所以自动前进不可能踩到已有录音。
 */
export function useRecorder(
  onSaved: (target: RecorderTarget, info: FtRecInfo) => void | Promise<void>
): {
  recording: boolean
  hint: string
  begin: (target: RecorderTarget) => Promise<void>
  stop: () => Promise<void>
} {
  const [recording, setRecording] = React.useState(false)
  const [hint, setHint] = React.useState('')

  const graph = React.useRef<PcmRecorder | null>(null)
  const step = React.useRef<RecordingStepState>(initialRecordingState(0))
  const target = React.useRef<RecorderTarget | null>(null)
  const saved = React.useRef(onSaved)
  saved.current = onSaved

  // 音频回调是异步触发的，拿不到最新的闭包；stop 经 ref 中转。
  const stopRef = React.useRef<(reason?: string) => Promise<void>>(async () => {})

  const teardown = React.useCallback((): void => {
    graph.current?.stop()
    graph.current = null
    setRecording(false)
  }, [])
  const stop = React.useCallback(
    async (reason = ''): Promise<void> => {
      const rec = graph.current
      if (!rec) return
      const { chunks: collected, sampleRate: rate } = rec.stop()
      graph.current = null
      setRecording(false)
      const take = target.current
      const durationMs = Math.round((collected.reduce((sum, c) => sum + c.length, 0) / rate) * 1000)
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
      let info: FtRecInfo
      try {
        const base64 = encodeWav16k(collected, rate)
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
        info = await window.api.ftRecSave(take.group, takeLineId(take.mode, take.line), bytes)
      } catch (err) {
        // 存失败就停在这句：不前进，错误写在提示里。
        setHint(`保存失败：${String(err)}`)
        return
      }
      setHint(`已存 ${info.key}（${(info.durationMs / 1000).toFixed(1)}s）`)
      try {
        await saved.current(take, info)
      } catch (err) {
        // 已经存下了，刷新列表失败不能报成「保存失败」，也别因此停在旧句上重录。
        setHint(`已存 ${info.key}，列表刷新失败：${String(err)}`)
      }
    },
    []
  )
  stopRef.current = stop

  // 录到一半切走 section 不能把麦克风留在占用状态。
  React.useEffect(() => teardown, [teardown])

  const begin = React.useCallback(
    async (next: RecorderTarget): Promise<void> => {
      if (graph.current) return
      target.current = next
      step.current = initialRecordingState(Date.now())
      setHint('录音中…')
      let rec: PcmRecorder
      try {
        // 逐段 RMS 判定仍在共享纯缝（advanceRecording）里，图只管攒 PCM。
        rec = await startPcmRecorder((input) => {
          let energy = 0
          for (const sample of input) energy += sample * sample
          const rms = Math.sqrt(energy / input.length)
          const nextStep = advanceRecording(step.current, { rms, nowMs: Date.now() })
          step.current = nextStep.state
          if (nextStep.stop) void stopRef.current(nextStep.reason ?? '')
        })
      } catch (err) {
        setHint(`拿不到麦克风：${String(err)}`)
        return
      }
      graph.current = rec
      setRecording(true)
    },
    []
  )

  return { recording, hint, begin, stop }
}
