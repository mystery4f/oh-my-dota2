---
created: 2026-10-31
updated: 2026-10-31
tags: [glossary, sovits, tts]
---

# 术语表

本项目的领域词汇，写作与烤问时保持同一套说法。

| 术语 | 含义 |
| --- | --- |
| api_v2 | GPT-SoVITS 整合包自带的 TTS HTTP 服务（`runtime/python.exe api_v2.py`），应用托管启动，默认端口 9880 |
| 预热（warmup） | 服务就绪后自动合成一句「预备」。首次推理的一次性开销（显存分配、算子调优），每次重启只慢这一次，模型参数不变 |
| 参考音频（ref） | 音色克隆源 wav + 转写文本，api_v2 每次合成请求都要带 |
| 微调权重 | GPT（`*.ckpt`）+ SoVITS（`*.pth`）训练产物对，决定「像谁」。切换走 `/set_gpt_weights` + `/set_sovits_weights`，免重启 |
| 底座权重 | 官方包自带的三件套（零样本克隆用），微调权重的起点 |
| 语义 token 预测 | AR 推理阶段，GPU 大头；api_v2 日志里 0/1500 的进度条就是它 |
| 段（segment） | `splitForSpeech` 按标点切出的 ≤20 字合成单元，段间预取保播放连续 |
| 积压（backlog） | 已翻译、排队等朗读的消息 |
| 丢弃积压（backlog drop） | 「只念最新一条」的队列策略，见 ADR `tts-backlog-drop` |
| LRU | 最近最少使用淘汰；重复句缓存的容量策略，50 条 |
| 音色包（voice pack） | 参考音频 + 微调权重对 + 清单条目，从魔搭分发，见 `docs/VOICEPACKS.md` |
| 数据根 | 安装版的可携数据目录（如 `G:\oh-my-dota2-data`），引擎、权重、参考、设置全在里面 |
