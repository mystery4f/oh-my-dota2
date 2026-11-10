---
created: 2026-11-10
updated: 2026-11-10
tags: [voice, sovits, readiness, events]
---

# ADR：声出就绪的重算由语音域变更点广播，不再由 handler 表逐个包刷新

## 背景

「声出就绪」这一行的输入只有四项：引擎装没装、GV 服务相位、当前音色包装没装、参考音频填没填。判断本身在 `shared/voice-out-readiness.ts` 的纯函数里，主进程只负责凑输入、判一次、变了才广播。

但重算的触发点原来散在 `src/main/ipc.ts` 的 handler 表里：一个 `refreshReadinessAfter` 包裹器包了五个动作，装引擎与拉服务各自手写一行，`setSettings` 一个钩子。这个结构漏过一次——`sovitsSelectRef` 直接调 `activateSovitsRef`（内部 `saveSettings`），绕过了 `setSettings` 的钩子，于是选完参考后那一行不翻牌，只能在 handler 里补一次并写注释解释。注释留下来了，结构问题还在：新加一个变更点就得记得再包一次，忘了只剩 3 秒 tick 兜底。

## 决定（2026-11-10）

- 新建零依赖的 `src/main/services/voice/mutations.ts`：`notifyVoiceOutMutation()` / `onVoiceOutMutation()`。做成独立小模块而不是复用就绪模块的导出，是因为就绪模块已经依赖 server/voicepack，域模块反向 import 会成环（与推理互斥开关的注册式做法同一道理）。
- 广播点放在域模块自己的变更终点：`setPhase` 尾部（相位的唯一漏斗）、`activateSovitsRef` 写完设置后、删音色包结尾、装音色包与装引擎的成功分支、保底参考入库后。
- `voice-out-readiness.ts` 模块级订阅一次，收到就 `void refreshVoiceOutReadiness()`；已有的 inflight 守卫天然去抖，远端清单慢时不会堆请求。
- `ipc.ts` 删掉包裹器与四处手写刷新；`setSettings` 钩子保留（设置保存本身就携带着色/参考的变更，不属于语音域模块）。
- 3 秒 tick 保留：外部起的服务、被外部杀掉的进程只能靠探测发现。

## 否决的备选

- 让每个 handler 调 `refreshVoiceOutReadiness()`：就是现状，靠人记。
- 把 `refreshVoiceOutReadiness` 直接 import 进域模块：value 循环（就绪 → server → 就绪），运行时序不保证。
- 提高 tick 频率代替事件：成本落在每个用户身上，且「点了按钮 3 秒后才翻牌」本身就是体验缺陷。

## 后果

- 新增语音域变更点时，只要在域模块里喊一声，就绪行自动跟随；handler 表回到「一行一个通道」的形态。
- 域模块多一个 import，但它是叶子，不进循环。
- 事件是同步的、无 payload：订阅者拿不到「变了什么」，只能全量重算。当前只有一个订阅者，这样最省。

## 相关文件

| 文件 | 作用 |
| --- | --- |
| `src/main/services/voice/mutations.ts` | 广播器（零依赖叶子） |
| `src/main/services/voice/voice-out-readiness.ts` | 唯一订阅者：收到就重算 |
| `src/main/services/voice/sovits-server.ts` | `setPhase` 与 `activateSovitsRef` 广播 |
| `src/main/services/voice/sovits-install.ts` | 装引擎成功广播 |
| `src/main/services/voice/sovits-voicepack.ts` | 装/删音色包、保底参考广播 |
| `src/main/ipc.ts` | 删掉包裹器与手写刷新 |
