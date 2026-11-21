# 原型 ↔ main 落地差集（2026-11）

这张表回答一件事：**原型（`src/renderer/src/prototype/`）里画了、main 上没有；或者 main 上已有、原型没画**——到底哪边缺，缺的那件事要动什么。

结论先说：绝大多数条目是**原型落后**，不是代码缺功能。真面板早就上线了，原型停在几周前。四列缺一列都不行，尤其「哪个探针覆盖」那一列——它决定改完能不能自称对。

## A 关于页（`src/renderer/src/panel/pages/about.tsx`）

| 差集项 | 真面板位置 | settings 键 | 已有探针 | 落地要动什么 |
| --- | --- | --- | --- | --- |
| 自己说话时的回声 | `about.tsx:139` | 无（读 `voiceHalfDuplex()` 快照） | `--half-duplex-probe` | 原型补一行 |
| 模型调用 | `about.tsx:149` | 无（读 `logs/provider-metrics.jsonl`） | `--provider-board-probe` | 原型补一行 |
| 探针清单 | `about.tsx:167` | 无（读登记表） | `--probe-catalog-probe` | 原型补一行；这行**只列不跑**（探针要单实例锁且跑完自己退出） |

## B 念页（`src/renderer/src/panel/pages/read.tsx`）

| 差集项 | 真面板位置 | settings 键 | 已有探针 | 落地要动什么 |
| --- | --- | --- | --- | --- |
| 播报游戏状态 | `read.tsx:99` | `announceTotal`（默认 false）+ `announceTriggers{wisdom,rosh,stack,pull}` | `--announce-probe`、`check:pure` | 形状一致，无需改 |
| 念什么（自己的话 / 刷屏积压 / 分句字数） | `read.tsx:251/265/279` | `ttsReadOwn`、`ttsDropBacklog`、`ttsSpeakSegmentChars`（30） | `--tts-pipeline-probe`、`--speech-split-probe` | 只是命名不同 |
| 说话人念法 | `read.tsx:302` | `ttsSpeakPrefix`（front）+ `ttsSpeakFrontTpl` / `ttsSpeakBackTpl` | `--tts-play-probe` | 原型只画了「带说话人」一行，比真面板粗；要补两个模板输入 |
| 离线模型状态 / 下载 | `read.tsx:351/368` | `ttsOfflineVoice` | **无** → 见 #153 | 先补探针，再让原型对齐四态 |

## C 识别训练（`src/renderer/src/panel/pages/asr-train.tsx`）

| 差集项 | 真面板位置 | settings 键 | 已有探针 | 落地要动什么 |
| --- | --- | --- | --- | --- |
| 训练目标 | `asr-train.tsx:352` | 读 `asrActiveModel`（页面不写） | `--train-probe` | 原型补一行 |
| 录音组 | `asr-train.tsx:487` | 无（账本 `dataset_entries`） | `--train-probe`、`--dataset-health-probe` | 原型补一行 |
| 录制 / 自定义录音 | `asr-train.tsx:537/633` | 无（写读稿 `G99` 组） | `--train-probe`（`resolveFtScript`） | 原型补 |
| 短句/长句分流 | `asr-train.tsx:852` | `asrRouteShortLong`（默认 false） | **接线无探针** → 见 #154 | 先补探针 |
| 还缺的依赖 | `asr-train.tsx:416` | 无（`detectAsrFtEnv`） | `--train-probe` | 原型补一行 |

## D 直发（`src/renderer/src/panel/pages/chatout.tsx`）

| 差集项 | 真面板位置 | settings 键 | 已有探针 | 落地要动什么 |
| --- | --- | --- | --- | --- |
| 短语分组 | `chatout.tsx:128` | 无设置键（#159 已删 `quickPhraseGroups`） | `--quick-phrases-probe`（`renderGroups`/`renderPhrase`） | 变量用 placeholder 提示，见 #156 |

## E 它怎么听·说（`src/renderer/src/panel/pages/talk.tsx`）

| 差集项 | 真面板位置 | settings 键 | 已有探针 | 落地要动什么 |
| --- | --- | --- | --- | --- |
| 影子模式 | `talk.tsx:579` | `shadowFirstMatch`（默认 **true**） | `--shadow-voice-probe` | 原型补一行 |
| 切段策略 | `talk.tsx:562` | `speechSplitStrategy`（punctuation）+ `ttsSpeakSegmentChars` | `--speech-split-probe` | 原型补一行 |
| 这条链走到哪 | `talk.tsx:676`（带 `note` 槽，#151） | `interpretMode` | `--interpret-leg-probe`、`--interpret-switch-probe` | 原型补一行 |

## F 体检（`src/renderer/src/panel/pages/overview.tsx`）

| 差集项 | 真面板位置 | settings 键 | 已有探针 | 落地要动什么 |
| --- | --- | --- | --- | --- |
| 游戏发来了新东西 | `overview.tsx:313` | 无（`patch` 快照） | `--patch-watch-probe` | 原型补一行 |
| 上手检查 | `overview.tsx:271` | 无 | `--first-run-probe` | 原型补 |
| 这台机器 | `overview.tsx:317` | 无（`envReport()`） | **无** → 见 #155 | 先补探针 |
| Steam 库 | `overview.tsx:369` | `gsiLibraryRoot` | `--gsi-probe` | 原型补 |

## 分工

- **原型那半缺行**（A/B/C/E/F 的缺行）归 pm，不单独开票。
- **要开票的四件**：#153 离线模型三态探针、#154 分流接线探针、#155 体检探针、#156 直发变量 placeholder。
- 三处「先拆纯缝」的理由写在 `docs/adr/asr-and-offline-testability.md`，四张票引用它。
