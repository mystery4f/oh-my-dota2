---
created: 2026-10-31
updated: 2026-10-31
tags: [tts, sovits, gpu, benchmark]
---

# ADR：parallel_infer 保持 false

## 背景

api_v2 的 `parallel_infer` 管的是合成段内部并行；但短句的 GPU 大头是 AR 语义 token 预测，这个参数管不着它。理论上开着能省合成段时间，值得实测定默认值。

## 数据（.tmp/sovits-ab.mjs，10 句 × 开/关，起始配置逐句交替）

| 场景 | off 中位 | on 中位 | 备注 |
| --- | --- | --- | --- |
| 空闲（菜单） | 635 ms | 558 ms | 差距约 12%，均值反而 on 更差（离群 2706ms） |
| 对局（单人试玩，地图渲染吃卡） | 1351 ms | 1522 ms | off 略优；off 含首请求热身 9944ms 已计入均值 |

对局 vs 空闲：整体慢 2.5 倍——争抢才是主要矛盾，参数选择是次要项。

既有数据一致：2026-10-27 实测（`sovits.ts` 注释）关掉服务端分句并行，短句 p50 2.21→1.55s。

## 决定

保持 `parallel_infer: 'false'` 硬编码（`src/main/services/voice/sovits.ts`）。两组数据都没有可靠优势，且历史实测也偏向关闭；不再引入设置项增加面板复杂度。

## 重新评估条件

- 段长上限或 batch_size 调大，合成段占比变高
- 引擎升级后 AR 阶段显著变快

## 相关文件

| 文件 | 作用 |
| --- | --- |
| `src/main/services/voice/sovits.ts` | 请求参数 |
| `.tmp/sovits-ab.mjs` | A/B 基准脚本（结果 `sovits-ab-{idle,ingame}.json`） |
