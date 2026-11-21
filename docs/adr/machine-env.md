# 机器级事实（Python / 依赖 / 显存）为什么是一条共享缝

- 状态：current
- 日期：2026-11-22（#179）

## 决定

三件事（解释器、包、显存）由 `src/shared/machine-env.ts` 折叠成固定三行，主进程只负责取数（`src/main/services/machine-env.ts`），识别训练页与音色页读同一份 `machine:env`。

## 为什么不放在各自的页面里

两页都需要判断「这台机器能不能跑」，但它们的口径必须一致：音色页说「能跑」而识别训练页说「缺东西」，用户没法知道该信谁。折叠放在 `src/shared/` 之后，两页只剩下渲染，判据只有一份。

## 为什么不合并进 `env:report`

`envReport(devices)` 是「六行体检」，设备数由渲染层一起传进来（浏览器层才有 `enumerateDevices`）；机器级三行与设备无关，混在一条通道里会逼音色页也去数设备。

## 显存的两个出口（下一票合并）

- 旧：`src/main/services/train/asr-ft.ts:762-782` 的 `ftVramGuard()` → `asrFtFacts().vramNote` → `src/shared/train/preflight.ts:78` 的开训预检 `vram` 项（`level: 'warn'`）。
- 新：`src/shared/machine-env.ts` 的 `vram` 行（`judgeFtVram()` 的数字 + `ftVramNote()` 的原话）。

合并时删**预检那一项**，不要删机器级那行。本票不动旧出口，避免与训练侧在途改动相互牵制。

## 验收

`--machine-env-probe`（ci）：三行顺序固定、三种缺失三句不同且都说得出下一步、显存四档（够用 / 偏紧 / 测不到）、测不到不算 ready、汇总句三种输入三个样。纯缝不读盘、不跑命令，探针只喂事实。
