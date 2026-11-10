---
created: 2026-11-10
updated: 2026-11-10
tags: [ipc, settings, providers, voices, architecture, decision]
---

# ADR：领域模型迁出 IPC 契约文件

- 状态：已接受（2026-11-10）
- 关联：架构扫描 2026-11-10；`docs/adr/provider-keys-per-provider.md`（漂移仲裁细节）、`docs/STANDARDS.md`（anti-duplication 自检）。

## 背景

`src/shared/ipc.ts` 1,177 行里住着两类东西：通道契约（`ipcContract`/`voiceOutContract`，窗口两侧共享的唯一真理）和三类领域模型——供应商（`ProviderConfig`/`ProviderPreset`/`PROVIDER_PRESETS` 七家预设）、离线音色（`OFFLINE_VOICES` 三家）、设置形状（`AppSettings` 52 字段 + `DEFAULT_SETTINGS`）。改一个供应商字段要动契约文件、`settings.ts` 归一化、面板多处；近三周 `shared/ipc.ts` 是全仓库改动次数最多的文件（67 次）。

## 决定

- 契约文件只留通道表：`ipc.ts` 改为 import + 再导出（`export type { ProviderConfig } from './providers'` 等），全部旧 import 路径继续可用，`ChannelMap` 一行不动——契约是红线。
- 领域模型各归各家：`src/shared/providers.ts`（供应商三件套 + `healProvider`——漂移仲裁唯一入口，`normalizeSettings` 只调它，即「特殊规则走插件位」）、`src/shared/voices.ts`（离线音色表 + `VoiceOutEngine`）、`src/shared/settings-shape.ts`（`AppSettings` + `DEFAULT_SETTINGS`）。
- 设置字段声明表方案否决：迁移后「三处同步」塌成「settings-shape.ts（形状+默认）+ settings.ts（规则）」两处；规则文件里每条守卫的注释（迁移原因、坏值后果）是领域知识，而约 30 个字段刻意不设守卫，表格会把它们变成闭包仪式；所有 normalize 助手本就在 shared 侧，表格也没有依赖方向的收益。按删除测试放弃。
- 合并知识收敛成一份：读盘与写盘的嵌套深合并（provider/key 表/推理表/热键表）统一进 `mergeSettings(base, patch)`，`loadSettings` 与 `saveSettings` 共用——原来两份拷贝的差异只是基座不同（缺省值 vs 现值）。

## 后果

- `ipc.ts` 1,177 → 817 行；新增三个 shared 模块，零运行时 import 环（`npm run check:shared` 钉住）。
- 新增字段仍是在 `settings-shape.ts` 加两行（类型 + 默认值），需要守卫才动 `normalizeSettings`——漏写默认值是编译错误；漏写守卫只影响手编文件，与「设置文件是用户数据，按需守卫」的既有立场一致。
- 同批扫描的相邻收敛（各自文件头注释带 why）：六族资产安装的忙碌/错误收拢进 `src/main/services/install-job.ts`（顺带删除上一代 qwen3 下载栈死代码 131 行）；翻译延迟记账独立成 `src/main/services/session/translator-latency.ts`，`instructionsFor` 归位 `src/main/services/providers/index.ts`。

## 相关文件

| 文件 | 作用 |
| --- | --- |
| `src/shared/ipc.ts` | 只剩通道契约 + 再导出（兼容旧 import 路径） |
| `src/shared/providers.ts` | 供应商模型 + 预设 + `healProvider` |
| `src/shared/settings-shape.ts` | `AppSettings` + `DEFAULT_SETTINGS` |
| `src/shared/voices.ts` | 离线音色表 + `VoiceOutEngine` |
| `src/main/services/settings.ts` | `mergeSettings` 单份深合并 + `normalizeSettings`（仲裁委托 `healProvider`） |
