# 热词候选：只建议，不自动应用

状态: current · 2026-11-21 · 对应 issue #74

## 要解决的问题

纠错样本里藏着人反复改同一类词的事实（`我们打个哈斯卡` → `我们打个马尔斯`），但这份
证据只落成 wav，没人为它回过头去改热词表。结果是同一类识别错误一轮一轮重复。

反过来，把差异词自动写进 `asrHotwords` 又会踩另一个坑：sherpa 的热词是**构造期配置**
（`resources/asr-sherpa-worker.cjs` 的识别器缓存键是 `${kind}|${dir}|${hotwords}`），
每写一次就重载一次识别器。自动写等于每句纠错都让引擎冷启一次。

## 决策

- **一次纠错记一笔，反复出现的词才值得提议**：`recordCorrection()` 从「原句 → 改对
  的句子」里取差异词（复用 `extractHotwordDiff`，≥2 字），落 `<userData>/asr-hotword-candidates.json`。
  单字差异永不进池子——单字差分是识别噪声，做成热词只会污染词表。
- **提案是给人看的清单，不是一个开关**：面板列出 `词 × 次数 + 原句样本`，已经在本里
  的词默认不勾、划掉显示。人勾哪些、要不要现在并，全由人定。
- **合并是显式的，写之前先报数**：`mergePlan()` 先算出 `added / already / dropped / next`
  四个结果再落盘，面板把三个数说出来；表满（`HOTWORD_LIMIT = 50`）时被丢下的词单独
  列一行「表满没写进去：…」。**绝不静默丢弃**。
- **一次提交只写一次 `asrHotwords`**：`applyHotwordCandidates()` 只在 `added.length > 0`
  时调一次 `saveSettings`，也就是最多重载一次识别器。已处理的词从池子里摘掉，同一个
  词不会被反复提议。
- **忽略只清候选，不动设置**：`dismissCandidates()` 从池子摘词，`asrHotwords` 一字不改，
  纠错计数保留（人要能看到「攒了多少次」）。
- **面板必须把新词表接回自己的 state**：`HotwordCandidateBox` 的 `onApplied(hotwords)`
  让 `useSettings` 的 state 跟上来。少了这一步，热词输入框还停在旧值，人再编辑一次就
  把刚并入的词覆盖掉——那是数据丢失，不是显示陈旧。

## 为什么不在别处做

- 不在纠错保存时就写 `asrHotwords`：那会让每一次纠错都重载识别器，而且程序替人做决定。
- 不在渲染进程算候选：样本、计数、去重都要落盘，主进程是唯一持有池子的地方；渲染侧
  只做展示与勾选。
- 不做「自动应用开关」：本条的验收要求就是「从不自动写入」，一个开关会把「默认安全」
  变成「滑一下就危险」。

## 验收与证据

- 探针 `--hotword-candidates-probe`（ci: true，`passed:14`）：池子归并与排序、单字差异
  永不入池、`rankCandidates` 的 `inTable` 标记、`mergePlan` 的三条边界（都已在表 /
  表满 / 差一个）、`dismissCandidates` 计数保留、脏数据当空池、`applyHotwordCandidates`
  恰好写一次且摘掉已处理词。
- `scripts/check-pure.mjs` 对同批纯函数另有一组断言（无需 Electron）。
- 面板：`npm run panel:preview ?s=talk` 人工核过三条路径——正常并入（3 个词进表、
  输入框从 0/50 变 3/50）、忽略（行消失、提示保留计数）、表满（加 1 丢 2，丢的两个
  被列出来）。

## 影响面

- 新文件：`src/shared/asr-hotword-candidates.ts`（纯缝）、`src/main/services/voice/hotword-candidates.ts`
  （池子与提案）、`src/renderer/src/panel/components/hotword-suggestions.tsx`（面板）。
- IPC 三条通道：`asr:hotword-suggestions` / `asr:hotword-apply` / `asr:hotword-dismiss`。
- `corrections.ts` 在 `result.saved` 时把样本交给池子（`options.onCorrection`，默认真实现，
  探针可注入假实现）。
- 数据：`<userData>/asr-hotword-candidates.json`（候选池，可随时删，删了只是重新攒）。
- 热词表本身仍是 `settings.json` 的 `asrHotwords`，面板之外的任何路径都不能写它。
