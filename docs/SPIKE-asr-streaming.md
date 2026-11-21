---
created: 2026-11-21
updated: 2026-11-21
tags: [spike, asr, streaming]
---

# 流式识别能不能替代整句识别（#72 量测报告）

问题：识别现在是「说完 → 整句过模型 → 出字」，用户要等整条链跑完才看到字。**流式**（说到一半就出字）能不能用？代价是多少？

结论先说：**能跑，但不是一个免费的升级**——同一批真实录音上，流式比现在离线跑的 paraformer 更慢不到 0 秒（尾巴为 0），代价是错字率从 6% 涨到 9%，而且第一段字要等到说完 1.3 秒之后才稳定，不是「一开口就有」。

## 量测环境

- 机器同产品环境（Windows、CPU 推理、`numThreads: 2`、`provider: cpu`，与 `resources/asr-sherpa-worker.cjs` 一致）。
- 素材：`data/asr-ft/` 里 30 条真实录音（1.2–6 秒，中位 2.9 秒），带读稿原文，所以能算错字率（CER）。
- 流式模型：`sherpa-onnx-streaming-paraformer-bilingual-zh-en` 的 int8 版本（encoder 157.8 MB + decoder 68.3 MB），从 `hf-mirror.com` 下载，放在 `.tmp/` 下量完即删，没有进 `data/asr-models/`。
- 对照：产品里现有的两个离线引擎 `paraformer-zh`（228 MB）与 `qwen3-asr`（942 MB）。
- 分块：100 ms 一块，和麦克风回调一个量级。

## 数字

| 指标 | 流式 paraformer | 离线 paraformer | 离线 qwen3 |
| --- | --- | --- | --- |
| 模型加载 | 1.6 s | 3.1 s | 5.0 s |
| 每 100 ms 音频的计算耗时（中位） | 8.8 ms | — | — |
| 实时系数（计算 / 音频） | 0.09 | — | — |
| 第一段字出现时已消耗的音频（中位） | **1.3 s**（0.7–1.9 s） | — | — |
| 说完之后出最终字（中位） | **0 ms** | 138 ms | 1251 ms |
| 错字率 CER（30 条，均值） | **9.1%** | 6.0% | 6.9% |
| 错字率 CER（中位） | 9.1% | 0% | 0% |

内存：三套引擎同时常驻时进程 RSS 2.0 GB；流式那套光权重就是 226 MB。

## 三个必须留在报告里的坑

- **流式 paraformer 按整块解码，尾巴不补静音就永远缺最后几个字。** 第一轮量测没补，出现的「今天天气不错适合出」（缺「门走走」）让 CER 从 9.1% 虚高到 21.5%。补 0.8 秒静音后才是上面那张表。谁再量一次，别忘了这一步，否则会得出「流式根本不能用」的错误结论。
- **端点检测开关不影响这个误差。** 关掉 `enableEndpoint` 重跑，CER 一模一样（0.215 → 0.215，补静音前），说明截断来自尾块不满，不是分段。
- **第一段字不早。** 1.3 秒才稳定，是因为流式 paraformer 本身按约 1 秒的块累积。想要「开口就有字」得换 zipformer 类模型，那是另一套权重与另一份素材，这次没有量。

## 对产品的意义

- 现在「等结果」的大头不是「离线」这件事，而是**选了哪个引擎**：离线 paraformer 说完 138 ms 就出字，qwen3 要 1.25 秒。短句/长句分流（#122）已经按这个差异分工。
- 流式换来的是「说到一半看得见字」，代价是 50% 相对误差上升（6.0% → 9.1%）和 226 MB 常驻权重，还要额外补尾巴静音这一层。用在对局里播报场景，9% 错字会直接变成错译，收益不划算。
- qwen3 没有在线（流式）版本，所以「流式 + 方言强的 qwen3」目前不存在；要走流式就等于换模型家族。

## 复现

一次性脚本不进仓库，复现步骤：装 `sherpa-onnx-node` 后

- 流式：`new OnlineRecognizer({ featConfig:{sampleRate:16000,featureDim:80}, modelConfig:{ paraformer:{encoder,decoder}, tokens, numThreads:2, provider:'cpu' }, decodingMethod:'greedy_search' })`，`createStream()` 后每 100 ms `acceptWaveform({samples, sampleRate})` + `while(isReady(s)) decode(s)` 取 `getResult(s).text`，**末尾再喂 0.8 秒静音**，最后 `inputFinished()`。
- 离线：`OfflineRecognizer` 一行配置，整条 `acceptWaveform` 后 `decode`。
- 素材与原文：`data/asr-ft/*/Gxx-Lnn.wav` ↔ `resources/asr-ft-script.md` 的编号行。

## 结论与建议

不改成流式。若之后要压「说完到出字」的等待，先做一件更便宜的事：让用户能选默认引擎（paraformer 快 1.1 秒，CER 低 0.9 个百分点），流式留作「开会/长句听写」这类另一套模型家族的备选。本报告不改任何产品默认路径，也没有新增设置项。
