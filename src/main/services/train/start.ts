import { normalizeTrainKind, type TrainStartRequest, type TrainStartResult } from '@shared/train/task'
import { normalizeAsrFtMode } from '@shared/train/asr-ft'
import { resolveGvTrainRequest } from './gv'
import { buildAsrFtExportPlan, resolveAsrFtTrainRequest } from './asr-ft'
import { getTrainManager } from './manager'

/**
 * 「点开始训练」的完整启动协议：kind 归一 → 对应腿备料（缺口在这里就报出来，不进 manager）
 * → asr-ft 带着「训练完接导出」的链子交给编排器。收口自 ipc.ts 的 handler 表——
 * 传输层只转发，未来任何第二个启动入口（自动重训/探针/CLI）复用同一份顺序。
 */
export async function startTrain(request: TrainStartRequest): Promise<TrainStartResult> {
  const kind = normalizeTrainKind(request.kind)
  // gv-*：先把引擎包/底模/数据集/配置文件备齐，缺口在这里就报出来，不进 manager。
  if (kind === 'gv-gpt' || kind === 'gv-sovits') {
    const resolved = resolveGvTrainRequest(request)
    return resolved.ok && resolved.request
      ? getTrainManager().start(resolved.request)
      : { ok: false, error: resolved.error ?? 'GV 训练备料失败' }
  }
  if (kind !== 'asr-ft') return getTrainManager().start(request)
  // asr-ft：先把环境/数据/目录备齐，再带着「训练完接导出」的链子交给 manager。
  // 开训方式（从底模重训 / 接着上次权重）原样落到 run 记录；增量接不上就拒启动，不静默落回重训。
  const resolved = await resolveAsrFtTrainRequest(normalizeAsrFtMode(request.mode))
  if (!resolved.ok || !resolved.request) return { ok: false, error: resolved.error ?? '微调任务备料失败' }
  const exportRequest = resolved.request
  return getTrainManager().start(exportRequest, () => buildAsrFtExportPlan(exportRequest), resolved.warning)
}
