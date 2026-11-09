---
created: 2026-11-08
updated: 2026-11-09
tags: [docs, index]
---

# 文档索引（docs/INDEX.md）

回答"这件事到底记在哪个文件里"。新增、改名、废弃文档时同步改这张表——`AGENTS.md` 的 Docs 段把这条列为规则，索引漏登等于文档不存在。

## 按问题找

| 我想知道 | 读这个 |
| --- | --- |
| 现在做到哪一步、下一步是什么 | `docs/PLAN.md`（计划真相源）、`docs/TODO.md`（跨会话交接） |
| 这个功能为什么这么设计 | `docs/DESIGN.md`；浮层看 `docs/DESIGN-overlay-v2.md`，面板看 `docs/DESIGN-panel-v2.md`，语音素材看 `docs/DESIGN-voice-corpus.md` |
| 某个决定是怎么定下来的、能不能改 | `docs/adr/`（一个决定一个文件，含数据、决定、后果） |
| 怎么手工验收一遍 | `docs/ACCEPTANCE.md`（中文清单 + 排错表） |
| 某个数字（延迟、耗时、内存）从哪来 | `docs/BENCH.md`；探针清单 `docs/PROBES.md` |
| 出过的坑：症状 → 原因 → 修法 | `docs/NOTES.md`（中文长文） |
| 写代码前该守什么规矩 | `docs/STANDARDS.md`（反重复标准，含三个可照抄的范例） |
| 术语、缩写、英雄中文名 | 根 `GLOSSARY.md`（项目领域词：识别、训练、热词、转正…）；`docs/GLOSSARY.md` 只剩 GV/TTS 那套词表 |
| 离线朗读模型从哪下、怎么加载 | `docs/VOICES.md` |
| 音色包（GV 微调产物）怎么训练、怎么发布 | `docs/VOICEPACKS.md` |
| Dota2 语音怎么变成训练集 | `docs/DESIGN-voice-corpus.md` |
| 项目管理约定（issue / 标签 / 领域文档） | `docs/agents/` 下三个文件 |

## 真相源与待办

| 文件 | 用途 | 状态 |
| --- | --- | --- |
| `docs/PLAN.md` | 计划真相源，里程碑带勾选与证据 | 现行 |
| `docs/PLAN-train-v3.md` | 训练管理 v3 那一轮的执行计划（已落地；现状看 AGENTS.md / ARCH-notes） | 历史快照 |
| `docs/TODO.md` | 跨会话交接的待办 | 现行 |
| `GLOSSARY.md`（根） | 项目领域术语表：识别引擎 / 模型 / 微调腿 / 转正 / 热词 / 推理互斥… | 现行 |
| `docs/IDEAS.md` | 功能想法池（未排期） | 现行 |
| `docs/ACCEPTANCE-PENDING-2026-11-02.md` | 那一轮的待验收项 | 历史快照 |
| `docs/HANDOFF-2026-11-02.md` | 语音管线会话交接 | 历史快照 |

## 设计与规范

| 文件 | 用途 | 状态 |
| --- | --- | --- |
| `docs/DESIGN.md` | 路线决定（零注入）、M1–M4 范围 | 现行 |
| `docs/DESIGN-overlay-v2.md` | 浮层 v2 设计 | 现行 |
| `docs/DESIGN-panel-v2.md` | 面板 v2 设计 | 待签字 |
| `docs/DESIGN-voice-corpus.md` | 语音素材：Dota2 语音 → 训练集，含四引擎实测与选型结论 | 草稿（待签字） |
| `docs/DESIGN-asr-engine-table.md` | ASR 引擎表：换模型 / 接新引擎不再破坏性，四层结构、迁移规则、探针断言与 paraformer 第二行（含 FunASR 微调腿） | 已落地（识别 + 微调双引擎） |
| `docs/DESIGN-asr-script-editor.md` | 读稿编辑器：面板里改组与句子、编号与删除策略、以及「改了稿只能从底模重训」的谱系判据 | 已落地 |
| `docs/STANDARDS.md` | 反重复标准、表与分支的取舍、纯接缝契约 | 现行 |
| `docs/ARCH-notes.md` | 面板文件清单、训练产物与解析、发布流程、Windows 进程检查的坑（从 AGENTS.md 移出） | 现行 |
| `docs/GLOSSARY.md` | GV / 朗读词表（项目领域词见根 `GLOSSARY.md`） | 现行 |

## 音频与训练

| 文件 | 用途 | 状态 |
| --- | --- | --- |
| `docs/VOICES.md` | 离线音色目录：模型来源、三种目录布局、实测采样率与延迟、坑 | 现行 |
| `docs/VOICEPACKS.md` | GPT-SoVITS 微调包的训练、版本、上传与下线 | 现行 |
| `docs/DESIGN-voice-corpus.md` | 语料提取与文本获得方案（含 ASR 准确率实测） | 草稿（待签字） |

## 验收、基准、探针

| 文件 | 用途 | 状态 |
| --- | --- | --- |
| `docs/ACCEPTANCE.md` | 手工验收清单 + 排错表（中文） | 现行 |
| `docs/BENCH.md` | 实测基线与复现方法 | 现行 |
| `docs/PROBES.md` | 探针一览：一行一个，写清它钉住什么 | 现行 |

## 工程笔记

| 文件 | 用途 | 状态 |
| --- | --- | --- |
| `docs/NOTES.md` | 症状 → 原因 → 修法（中文，长文） | 现行 |

## 决定记录（ADR）

一个决定一个文件；小修先在旧文件末尾追加「更正」。只有整条决定被推翻、继续按旧文件写会误导时，才新开一份并在标题下写明「取代：<旧文件>」，同时回旧文件顶部标注「已被 <新文件> 取代」——两条互相指认，索引里两份都留着。

| 文件 | 决定 |
| --- | --- |
| `docs/adr/asr-train-rewrite.md` | 识别训练重写：只训现役引擎（腿退回引擎内部）、三源数据全吃、状态卡驱动页面、迁移只留数据与底模 |
| `docs/adr/asr-ft-run-retention.md` | 训练目录只留增量起点：换模成功后才清，留当前轮 + 下一轮起点，清目录不删历史行 |
| `docs/adr/train-crash-reconcile.md` | 训练被中断后的收尾：退出时杀进程树并记失败，启动时把僵住的 running 行改判、删掉没有产物的 .next，脚本开训前从仓库刷新 |
| `docs/adr/asr-ft-disk-reclaim.md` | 训练残留的统一回收：启动时只留最新一份导出产物与一份能接着训的 run 目录，其余连半成品删掉 |
| `docs/adr/asr-check-batch.md` | 全量识别比对：数据步一个按钮 + 弹层，用现役模型跑全库、归一化后判一致，结果不落库 |
| `docs/adr/asr-finetune-leg.md` | 识别微调成为正式训练腿（两引擎、增量、底模保留、转正/回滚）；热词只给支持提示的引擎。取代 `asr-hotwords-not-finetune.md` |
| `docs/adr/asr-hotwords-not-finetune.md` | 识别个性化走热词注入；两次更正（Qwen3 可微调、后续切 FunASR paraformer）。**已被 `asr-finetune-leg.md` 取代**，留作决策历史 |
| `docs/adr/overlay-reply-and-send-channels-removed.md` | 移除浮层回复框与两条非原地文出通道 |
| `docs/adr/provider-keys-per-provider.md` | 翻译供应商按家记忆密钥 |
| `docs/adr/train-manager-orchestrator.md` | 训练管理页采用编排器定位 |
| `docs/adr/train-run-model-and-panel-pages.md` | 训练记录成为一等公民 |
| `docs/adr/tts-backlog-drop.md` | sovits 朗读丢弃积压（默认开启） |
| `docs/adr/tts-length-cap-rejected.md` | 念白限长 40 的提案被否决 |
| `docs/adr/tts-parallel-infer.md` | `parallel_infer` 保持 false |
| `docs/adr/tts-repeat-cache.md` | sovits 重复句缓存 |
| `docs/adr/voice-out-vb-cable.md` | 声出经 VB-Cable 进游戏语音：检测放主进程（驱动层，不靠空 label）、面板四步引导、测试结果报实际设备 |
| `docs/adr/voice-capture-hold.md` | 语音对讲按住说：`voiceCaptureMode` 默认 hold，松开靠常驻 PowerShell 轮询 GetAsyncKeyState（不挂钩子），失败退回敲一下 |

## 协作约定

| 文件 | 用途 |
| --- | --- |
| `docs/agents/issue-tracker.md` | 用 `gh` 管 GitHub Issue 的流程 |
| `docs/agents/triage-labels.md` | 五个分诊标签的含义 |
| `docs/agents/domain.md` | 单上下文领域文档：根 `GLOSSARY.md` + `docs/adr/` |

## 历史快照

保留归档，不再更新；引用它们时注意日期，里面的路径和结论可能已经失效。

| 文件 | 内容 |
| --- | --- |
| `docs/HANDOFF-2026-11-02.md` | 语音管线会话交接（2026-11-02 晨） |
| `docs/ACCEPTANCE-PENDING-2026-11-02.md` | 2026-11-02 那轮待验收清单 |
| `docs/agents/handoff-asr-finetune-2026-11-02.md` | ASR 微调闭环 + 一键环境安装器的交接 |
| `docs/agents/retro-asr-finetune-2026-11.md` | 同一次的复盘 |
