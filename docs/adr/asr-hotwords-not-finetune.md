---
created: 2026-11-01
updated: 2026-11-01
tags: [asr, qwen3, hotwords, finetune, decision]
---

# ADR：识别个性化走热词注入，不做微调

## 背景

重口音（湖南）用户的识别错误集中在两类：术语选错（「手→守」「肉山」类游戏词）与口音导致的音段偏差。诉求是「把玩家自己说的话喂给模型」。候选路线两条：

- **热词注入**：把词表喂给引擎的偏置接口，改词表即时生效，零训练。
- **微调**：拿录音+文字语料训练模型权重。

引擎侧事实（实测与源码取证）：

| 引擎 | 热词/提示词 | 微调可行性 |
| --- | --- | --- |
| Qwen3-ASR（sherpa-onnx 0.6B int8） | `qwen3Asr.hotwords` 字段，A/B 实测生效（同一段语音，喂词表后标点与选词随词表变化） | ~~不可行~~ **已推翻（2026-11-02）**：`QwenLM/Qwen3-ASR` 开源仓库发布官方 SFT 脚本 `qwen3_asr_sft.py`（JSONL 音频-文本对、torchrun、断点续训）；导出走 `Wasser1462/Qwen3-ASR-onnx`（正是本项目的 0.6B int8 模型的来源脚本）。见文末更正 |
| SenseVoice-small（sherpa-onnx） | 无任何热词/提示词机制（非自回归 CTC，配置仅 model/language/itn） | FunASR 有社区微调路线，但需 GPU + 造语料 + 导出回 ONNX，成本高 |
| whisper ggml-small | `--prompt` 初始提示（已用于简体偏置） | 社区有 LoRA 微调 + 转 ggml 的路线，同样重 |

## 决定

- 识别个性化只走**热词注入**，且只接 **Qwen3**（用户拍板：qwen3 专用，whisper 保持固定简体偏置 prompt，不接词表）。
- **SenseVoice 引擎整体废弃移除**（代码、worker 分支、面板、数据目录指引），`asrEngine` 枚举收窄为 `whisper | qwen3`；旧存档里的 `sensevoice` 值归一化时迁移为 `qwen3`。
- **纠错回路**：识别记录条目支持「纠错」改写，新旧文本差异片段自动并入热词表（有自动化但人工可改，无黑盒）。
- 微调路线**记档不排期**：作为口音适应的远期候选挂 TODO，触发条件见下。

## 重新评估条件（微调何时立项）

- 热词 + Qwen3 在真实口音下仍大面积错词，且错因是音段而非词汇
- 用户愿意固定产出语料（≥1 小时录音+校对文本）
- 有可用 GPU 且接受一次性的训练管线搭建成本

## 更正（2026-11-02）

本 ADR 立项时断言「Qwen3-ASR 不可微调」**是错的**——当时依据的是 Flash API 时代的信息。`QwenLM/Qwen3-ASR` 开源仓库现带官方微调脚本：

- `finetuning/qwen3_asr_sft.py`：JSONL 音频-文本对（`{"audio":..,"text":"language Chinese<asr_text>.."}`），单卡/torchrun 多卡，断点续训
- 导出：`Wasser1462/Qwen3-ASR-onnx` 转 ONNX（本项目在用的 0.6B int8 模型就是它转的），微调产物可原路回到 sherpa-onnx 通道
- 风险点：官方脚本为全量 SFT 非 LoRA，8G 显存跑 0.6B 需小 batch + 梯度累积实测；不行再走社区 QLoRA（已有 0.6B QLoRA→ONNX INT8 先例）

**后果**：微调目标从原计划的 SenseVoice-small 改为 Qwen3-ASR-0.6B（app 现役引擎、实测更准、热词/纠错回路围绕它建）。微调不再「记档不排期」，已立项（#29 训练管理页 + 第一轮手动微调）。

## 数据

热词 A/B（.tmp 已清，配方见会话记录；SAPI Huihui 7s 测试句，hotwords=`dota2,肉山,买活,高地,风暴之灵,反补,正补,帕克`）：

- 无热词：`谁买活了？我先守肉山，你们推上路高地，风暴之灵，别送。`（1206ms）
- 带热词：`谁买活了？我先守肉山，你们推上路高地，风暴之灵别送。`（1312ms）

标点更贴词表意图；选词差异出现在真实口音上（待真声验收）。sherpa 侧注意：`qwen3Asr.tokenizer` 必须指 `tokenizer/` 子目录（校验 vocab.json 落在该路径）。
