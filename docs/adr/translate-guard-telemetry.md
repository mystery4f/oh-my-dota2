# ADR：保真守卫只报三段计数，没有「漏检率」

- 状态：已接受（2026-11-20）
- 关联：`src/shared/translate-fidelity.ts`（判定本体）、`src/shared/guard-telemetry.ts`（口径与解析）、`src/main/services/session/guard-telemetry.ts`（攒批落盘）、`src/main/services/session/translate-cache.ts`（记账本战绩快照）

## 背景

翻译质量一直靠感觉：守卫把写坏的缩写（bkb → bkg）和吞掉的数字抓出来重试一次，但**抓了多少次没有任何落盘数字**，只有 `TRANSLATE_GUARD_RETRY` / `TRANSLATE_GUARD_GIVEUP` 两行 console。产品侧要一个能贴进周报的数，最初的提法是「命中/漏检率」。

「漏检率」在现有结构下不可测：模型把 bkb 译成 bkg 而守卫没判出来时，代码里没有第二个判官。要造一个就得再跑一遍模型（或另训一个小模型），成本和延迟都不成立；拿「重试后通过率」冒充漏检率则是把两个完全不同的东西混成一个数字。

## 决定

- **口径固定三段**：`blocked`（判违例次数 = 事件行数）／`recovered`（重试后通过）／`gaveUp`（重试后仍违例，译文退回原文）。对外只能说「抓到 X 次」，不出现「漏检率」。
- **一条违例一行**：`logs/translate-guard.jsonl`，字段 `at` / `via`（session｜direct）/ `direction` / `tokens` / `retryTokens` / `outcome`。正常译文一行都不写——守卫事件本身稀疏，所以这一点不影响可观测性。
- **攒批写盘**：事件先进内存，满 20 条、60 秒定时或进程退出时整批 append 一次（`appendCappedJsonlMany`）。逐条 `appendFileSync` 是拿磁盘延迟换一条日志，inplace 热路径不接受。
- **坏的半行直接丢**：进程被 kill 时文件末尾常有截断行，`parseGuardEvent` 返回 null，汇总从 jsonl 重算，不让一条脏数据带塌整份统计。
- **同一套批次里带上记账本战绩**：`logs/translate-cache.jsonl` 每 60 秒一行快照（`pairs` / `lifetimeHits` / `hitRatio` / `sessionHits` / `sessionMisses`），周报要的「省了多少次模型调用」与守卫数字同目录可查。

## 后果

- 周报能写的只有「这周守卫抓到 N 次，其中 M 次重试救回、K 次退回原文」，以及违例 token 排行（bkb/tp 这类缩写被写坏的频次）。这足以判断词表是否需要补词，但**不能**用来宣称翻译准确率。
- 面板暂时不展示这两个数字（产品只要周报数字）；要展示时读 jsonl 的 `summarizeGuardLog` 即可，口径只有一份。
- 守卫失败会在两份地方留痕：console 的 `TRANSLATE_GUARD_*`（开发时一眼看到）与 jsonl（事后统计）。两边都必须保留——前者是即时反馈，后者是唯一历史。
- 上限 256 KB 与其它证据日志一致，超出时整份清空重写；一批本身超限就只留最新的那几条（丢证据比越线更糟）。
