---
created: 2026-11-05
updated: 2026-11-05
tags: [provider, settings, keys, reasoning, decision]
---

# ADR：翻译供应商按家记忆（密钥归档 + 预设归位）

- 状态：已接受（2026-11-05）
- 关联：oh-my-dota2#41（规格）、#42（漂移仲裁）、#43（按家推理开关）、#44（本文档）。决策来自一次真机排障（智谱 401 根因是旧预设时代残留的 `authStyle`；MiMo 401 根因是各家共用一格 key 互踩），不是原型代码。

## 背景

翻译供应商此前只有一格共用 API Key：换供应商（MiMo → 智谱 → 回去）时面板只留最后粘贴的那把，智谱的 key 被发给 MiMo（401 Invalid API Key），MiMo 的 key 又被智谱的顶掉，而错 key 失败和网络失败长得一模一样。另有 `authStyle` 一桩：存档里躺着旧时代的野值，智谱就发 `api-key` 头而不是 `Authorization: Bearer`，key 明明有效也 401——没有任何东西告诉用户存档已经和内置预设表漂移。推理开关同理是全局一格：MiMo 要开推理，智谱 glm-4-flash 不用，换家就悄悄错。

## 决定

- **双字段真理模型**：`provider.apiKey` 是「当前生效」的那把，也是面板 key 框的编辑面；`providerKeys`（settings 里按供应商 id 各记一把，含 custom）是换供应商时的取回来源。推理开关同构：`provider.reasoning` 是当前格，`providerReasoning` 是按家归档。写路径只有面板 key 框与开关——一处改动两处记。
- **漂移仲裁（#42）**：载入（`loadSettings`）时活值非空就永远写回归档（`providerKeys[id] = provider.apiKey`）——用户手编 settings.json 的 key 以手编的为准，不会被归档里的旧 key 阴回去；活值为空串/缺失则不碰归档——空值不许顶掉已记住的 key。
- **旧档迁移是仲裁的特例**：早先「归档无条目 + 活值非空才播种」的迁移逻辑自然并入上面这条规则，没有独立路径。
- **预设归位**：载入时内置预设表（`PROVIDER_PRESETS`）声明过的字段以声明为准——`authStyle` 直接归位（面板从不单独编辑它），治好旧时代残留，无需迁移脚本；custom 保留存档值。推理开关同款（#43）：预设声明了 `reasoning` 的，活值与归档一起归位（`healProviderReasoning`）；没声明的预设与 custom 归用户管，开关仍可各家各编辑。面板层 `applyPreset` 也盖一遍声明字段（含 `authStyle`），并按 id 从归档换入该家 key（没记过的给空串让用户填）。
- **深合并不互踩**：`saveSettings` 对两张归档表都按 id 展开合并（`{ ...current.xxx, ...patch.xxx }`），面板「只落本页字段」的保存不可能抹掉别家的条目。
- **测试缝不新增**：全部行为收进现有纯探针——`--settings-persist-probe` 扩按家归档用例（换家两把都在、手编采纳、旧档播种、深合并不互踩、重启幸存），推理决策表进 `--provider-reasoning-probe`（预设 vs custom、野值归位、按家记忆）。探针套路照旧：纯函数、零网络、退出码定判。

## 否决的备选

- **每家多把 key / 轮换**：超出范围，没有轮换与故障转移的诉求，每家一把。
- **检测旧 key 属于哪家（ownership detection）**：做不到——载入期不为对 key 联网探各家接口；接受「旧 key 可能被记在当前家名下、直到被覆盖」这一局限。
- **一次性迁移脚本**（修 `authStyle`/推理残留）：载入时按预设表归位永远生效，脚本只修一次，不要。
- **只留归档、去掉活值字段**：请求路径与面板都读 `provider.apiKey`；双字段让面板外观零改动（「面板不加解释文案」本就在范围外），保留。

## 后果

- 换供应商永不发错 key；key 框里看到的就是将要发出的。
- 手编文件里的旧值再也毒不到请求：`authStyle`、预设声明的推理状态载入即归位。
- 接受的局限：不检测 key 归属（旧 key 可能记错家，直到被覆盖）；每家只有一把 key；面板不解释 key 存在哪，外观不变。
- custom 家二等公民是故意的：预设表里那一行什么都不声明，`authStyle` 与推理开关全归用户自己管。

## 相关文件

| 文件 | 作用 |
| --- | --- |
| `src/shared/ipc.ts` | `ProviderConfig`/`ProviderPreset`/`AppSettings.providerKeys`/`providerReasoning`，`PROVIDER_PRESETS` |
| `src/main/services/settings.ts` | `loadSettings` 漂移仲裁 + `authStyle` 归位 + 推理归位，`saveSettings` 深合并 |
| `src/shared/provider-reasoning.ts` | `healProviderReasoning` |
| `src/renderer/src/App.tsx` | `applyPreset`（换家换 key + 盖声明字段）、key 框一处改动两处记 |
| `src/main/probes/settings-persist.ts` | 设置持久化探针（按家归档用例） |
| `src/main/probes/provider-reasoning.ts` | 推理决策探针 |
