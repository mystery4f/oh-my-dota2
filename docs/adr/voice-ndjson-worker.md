---
created: 2026-11-10
updated: 2026-11-10
tags: [voice, worker, ndjson, ipc]
---

# ADR：语音子进程 NDJSON 协议收成一个 harness

## 背景

ASR（sherpa）与离线 TTS 各有一个常驻 node 子进程 worker，协议一模一样：spawn 时挂 stdio 管道、按行解析回复、按 id 配对、超时放弃、崩溃时清算所有待回复请求。差异只有四处：脚本名、回复内容（文本 / WAV 字节）、超时（15 秒 / 10 秒）、日志前缀。

两处实现逐字平行（约 60 行 × 2），改一处必忘另一处；而且两边都没有任何协议层测试——配对错位、半行丢弃、崩溃后 pending 泄漏这些故障在真机上只表现为「识别没反应」。

## 决定（2026-11-10）

- 新建 `src/main/services/voice/worker.ts`：`createNdjsonWorker({ script, timeoutMs, tag })` → `{ request(payload), reset() }`。脚本定位、node 二进制、spawn 参数、行缓冲、超时、崩溃清算、日志标签全部在 harness 里，两个引擎各自只剩一层薄适配（请求字段、成功判定）。
- `script` 允许绝对路径：探针据此注入假 worker，不碰真模型也能测协议。
- 超时差异保留在参数里（ASR 15 秒、离线 TTS 10 秒），不统一：两条链的模型大小与冷启动差一个量级。
- 统一加了「脚本不存在」的前置检查（ASR 原来没有）：缺文件会立刻报 `<TAG>_WORKER_MISSING`，而不是等一个注定超时的请求。
- 探针 `--voice-worker-probe` 用假 worker 钉住五件事：回声配对、并发不串号、崩溃后 pending 清算并重启、超时后返回 timeout 且 worker 还能用、缺脚本报 MISSING。

## 否决的备选

- 保留两份、只抽一个公共工具函数：协议本体（缓冲与配对）仍在两处，删除测试过不了。
- 把两个 worker 合成一个进程：两种运行时（sherpa onnx / 离线 TTS）与显存占用完全不同，合起来只会让一方拖累另一方。

## 后果

- 协议改动只改一个文件；两个引擎的差异一眼可见（只剩请求/回复那一层）。
- 顺带得到的能力：任何新 worker 只要说 NDJSON，就能复用同一套超时与崩溃语义。
- 探针不依赖真模型，协议回归随时可跑。

## 相关文件

| 文件 | 作用 |
| --- | --- |
| `src/main/services/voice/worker.ts` | harness：spawn、缓冲、配对、超时、清算 |
| `src/main/services/voice/sherpa-asr.ts` | ASR 薄适配 |
| `src/main/services/voice/offline.ts` | 离线 TTS 薄适配 |
| `src/main/probes/voice-worker.ts` | `--voice-worker-probe`，五个行为断言 |
