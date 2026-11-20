---
created: 2026-11-21
updated: 2026-11-21
tags: [adr, asr, train, model-swap]
---

# 底模副本：转正只轮换现役与备份

## 背景

换模（转正）只保留一个前任：`rm-bak` → `bak-active` → `promote-next`。第一次转正把出厂权重推进
`<engine>.bak`，第二次转正又把那个 `.bak` 删掉——出厂权重就此从盘上消失。`planFtTuning` 的
`fresh`（全量重训）于是没有起点，唯一的恢复手段是重新下载（qwen3 约 980 MB，paraformer 约 217 MB）。

同一台机器上已经出过一次事故：qwen3 的底模被重下过一遍。

## 决定

- 每个引擎在自己的目录旁留一份不可变的**底模副本** `asr-models/<engine>-base/`。
- 副本只在「首次使用」时写入：`applyAsrFtModel()` 开头与 `fresh` 开训前各调一次 `ensureBaseCopy()`，
  来源优先对讲下载的官方模型（`voice-runtime/models/<engine>`），其次仍是原样的现役目录。
  写入后按引擎表的 `requiredPaths` 逐件校验，不全就整目录删掉并报原因——不留半份。
- 已经存在（哪怕缺件）就**什么都不做**：缺件只在 `asrFtStatus().target.baseCopy` 与面板上报出来。
  一旦允许"顺手修一下"，唯一那份原件就会被半份覆盖。
- 转正只轮换 `<engine>` ↔ `<engine>.bak`，任何一步都不碰 `<engine>-base`。
- 「重置为底模」把副本铺成 `<engine>.next` 后走**同一套** `asrFtSwapSteps`：当前权重因此变成 `.bak`，
  点错了还能用「回滚」找回来。
- `fresh` 开训前建不成都写进请求的 `warning`，并在面板「底模副本」行显示目录与缺件。

## 不这样做的地方

- 不把副本放进 `asr-models/` 的扫描范围：`dirPatterns` 是给"现役候选"用的，副本一旦被扫进去，
  面板会多出一个可以选中的假模型。
- 不在 `asrFtStatus()` 里补建副本：状态查询必须只读，否则面板刷新一次就可能动几 GB 数据。
- 不因为副本缺失就拒绝转正：人能继续用新模型，缺的那份原件下次 `fresh` 前还会再试一次。

## 验收

`npm run probe -- --train-probe` 的四条断言（临时目录里跑真的 rename，碰不到 userData）：

- 两次转正之后副本仍在且内容未变，`.bak` 是上一代（`rm-bak` 删的是它，不是副本）。
- 重置为底模之后现役是出厂权重、上一版留在 `.bak`。
- 副本缺件时按引擎表列出缺哪几件，没有任何"补一补"的分支替它修。
- 副本目录名 `-base` 与现役/`.bak`/`.next` 三槽都不撞（qwen3 与 paraformer 各验一遍）。

面板侧：训练目标下方「底模副本」一格显示目录与缺件，右侧「重置为底模」按钮在副本不就绪时置灰。

## 后果

- 磁盘上每个引擎多占一份推理权重（qwen3 约 940 MB、paraformer 约 217 MB）。
- 现役被手工删掉时，`fresh` 仍能起跑：副本是独立来源，不依赖 `.bak` 是否还在。
- 副本本身被删 = 该引擎失去出厂起点，只能重新下载；这件事在面板与状态里都会先说出来。
