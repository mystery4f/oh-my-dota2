import { ASR_ENGINE_LIST, type AsrEngineSpec } from '@shared/asr/engines'
import { loadSettings } from '../settings'
import { activeAsrModel } from '../voice/asr-model'

/**
 * 训练目标的解析点：`asrTrainEngine` 显式选的 ＞ 现役模型所属引擎 ＞ 表里第一个声明 finetune 的。
 *
 * 「训练目标」和「现役模型」是两件事（见 docs/adr/asr-train-rewrite.md）：显式那一档是为了
 * 「引擎还在、运行时模型没装」的场景（删掉旧权重只留底模），也让「识别用 A、训练 B」成立——
 * 否则删掉权重后现役静默回落到别的引擎，qwen3 就再也选不回来了。
 *
 * 这条链只在这里写一次：转正、打包格式、面板都读它，别各抄一份（抄散过一次，见
 * ft-dataset 的 activeFtDatasetFormat 跟着现役走，结果 qwen3 训练吃到了 funasr 的 jsonl）。
 */
export function finetuneEngine(): AsrEngineSpec {
  const pinned = loadSettings().asrTrainEngine
  if (pinned) {
    const spec = ASR_ENGINE_LIST.find((item) => item.id === pinned && item.finetune !== null)
    if (spec) return spec
  }
  const active = activeAsrModel()
  const spec = active ? ASR_ENGINE_LIST.find((item) => item.id === active.engineId) : undefined
  if (spec?.finetune != null) return spec
  const fallback = ASR_ENGINE_LIST.find((item) => item.finetune !== null)
  if (fallback === undefined) throw new Error('引擎表里没有任何引擎声明 finetune')
  return fallback
}

export function finetuneSpec(): NonNullable<AsrEngineSpec['finetune']> {
  return finetuneEngine().finetune as NonNullable<AsrEngineSpec['finetune']>
}
