/** 训练日志行 → 进度解析纯缝：epoch 百分比 → tqdm 进度条 → step → 裸百分比，取先命中者。 */
export interface TrainProgress {
  percent: number
  stage: string
}

function stageOf(text: string): string {
  return text.length > 48 ? text.slice(0, 48) : text
}

/**
 * 已知训练日志格式 → 进度。命中不了返回 null（这种行只进日志环，不动进度条）。
 * 优先级：epoch a/b（分式算百分比）→ tqdm 进度条 → step a/b → 裸百分比。
 */
export function parseTrainProgress(line: string): TrainProgress | null {
  const text = line.trim()
  if (!text) return null
  const epoch = /epoch\s+(\d+)\s*\/\s*(\d+)/i.exec(text)
  if (epoch) {
    const total = Number(epoch[2])
    if (total <= 0) return null
    return { percent: Math.min(100, Math.floor((Number(epoch[1]) / total) * 100)), stage: `epoch ${epoch[1]}/${epoch[2]}` }
  }
  const tqdm = /(\d{1,3})%\s*\|/.exec(text)
  if (tqdm) return { percent: Math.min(100, Number(tqdm[1])), stage: stageOf(text) }
  const step = /step\s+(\d+)\s*\/\s*(\d+)/i.exec(text)
  if (step) {
    const total = Number(step[2])
    if (total <= 0) return null
    return { percent: Math.min(100, Math.floor((Number(step[1]) / total) * 100)), stage: `step ${step[1]}/${step[2]}` }
  }
  const bare = /\b(\d{1,3})\s*%/.exec(text)
  if (bare) return { percent: Math.min(100, Number(bare[1])), stage: stageOf(text) }
  return null
}

/** 打包给训练脚本的一条数据：录音绝对路径 + 稿子原文。 */
