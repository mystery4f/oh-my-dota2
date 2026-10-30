---
created: 2026-10-31
updated: 2026-10-31
tags: [tts, sovits, gpu, queue]
---

# ADR：sovits 朗读丢弃积压（默认开启）

## 背景

GPT-SoVITS 在本机显卡（RTX 4060 Laptop）上推理。实测：菜单里预热一句跑 67 it/s，游戏正吃显卡时同一段推理掉到 4.5 it/s，一句要 5–7 s。旧实现「消息一到就把所有段的合成请求都发出去」，api_v2 服务端排队会把显卡按住几十秒——游戏掉帧，读到的还是过时消息。

## 决定

- sovits 朗读改走专用队列：合成懒启动，同一时刻服务端最多积一段（段间预取保播放连续）
- 新增设置 `ttsDropBacklog`，默认开：新消息一到顶掉整条队列，被顶掉的永不合成（日志 `TTS_SPEAK_DROP`，stage=`queued`）
- 消息合成到一半来了新的，剩余段当场作废（stage=`stale` / `synthesized`）
- 面板开关「积压：只念最新 / 全念」；关闭则恢复 FIFO 全念

## 后果

- 刷屏时 GPU 占用被压到「一条消息」的量级，掉帧窗口明显变短
- 刷屏时旧消息不出声（要完整回放就关掉开关）
- 判定核是纯函数（`applyBacklogPolicy` / `isSpeakStale`），探针钉死 6 用例

## 相关文件

| 文件 | 作用 |
| --- | --- |
| `src/main/services/voice/speech.ts` | 队列与策略实现 |
| `src/shared/ipc.ts` | `ttsDropBacklog` 设置项 |
| `src/main/probes/tts-play.ts` | 积压策略用例 |
