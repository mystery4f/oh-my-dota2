# 设置一致性巡检（2026-11）

这张报告回答一个问题：**今天这 71 个设置项，每一个是不是都还有人在读、还有人在写，改完什么时候生效。**

它不是重构，也不动任何代码。产物是这份报告加一个能重复跑的检查器 `scripts/check-settings.mjs`，接在 `npm run lint` 末尾。

## 为什么重开 #84

`#84` 票面写的是「有一个设置面板，把新字段接进去」。那已经不成立：60 → 71 个字段，14 个分区，四个窗口（主面板、浮层、副屏驾驶室、呼出面板）。所以这张票不是接线，是一次巡检。

票面那 60 没有当时的清单，**无法精确复现差集**。下面按「字段引入时间」给出最可能的后 11 个，用的命令可复跑：

```
git log -S " <键名>:" --format=%ct -- src/shared/settings-shape.ts
```

按引入提交的 committer 时间倒序，最新 11 个（也就是比 60 多出来的那 11 个的最可能候选）：

- `boardVisible`、`boardBounds`（`011470e`，#124a 副屏）
- `targetLang2`（`0fd5919`，#120 目标语言）
- `captureSilencePreset`（`c5361d1`，#97 静音收尾）
- `ttsMuteHeroes`、`ttsMuteNames`（`307751c`，#93 逐人静音）
- `speechSplitStrategy`（`428a3a3`，#85 切段策略）
- `shadowFirstMatch`（`f91c406`，#80 影子模式）
- `overlayBoundsByDisplay`（`39c3425`，#101 每屏几何）
- `clauseStreamVoice`（`e0a0192`）
- `interpretMode`、`interpretInDevice`（`047a872`，#128 同传）

如果有当时的 60 个名字，差集一分钟能算出来：这份报告的「字段数」和「逐字段表」都是脚本产物，没有手写数字。

## 怎么数（口径）

- **字段数**：`src/shared/settings-shape.ts` 里 `export interface AppSettings { … }` 顶层的键，含 `?` 可选键。只认**两空格缩进**的顶层键——`providerKeys` 这种嵌套对象的字段缩进是 4 空格，不会被当成设置项。
- **默认值数**：同一文件里 `export const DEFAULT_SETTINGS: AppSettings = { … }` 的顶层键，口径同上。
- **读点三层**，三层相加才是「读点」：
  - 属性访问 `settings.key`、`loadSettings().key`、`s.key`（排除赋值号 `settings.key = …`，那是写）
  - 解构 `{ key } = settings` / `{ key } = loadSettings()`
  - 取值 `pick(settings, 'key')`
- **写点**：`update({ … })` / `saveSettings({ … })` / `patch({ … })` 块内的 `key:` 或简写 `key,`。**探针目录 `src/main/probes/` 的写盘不计**——那是测试在验怎么存怎么读，不是用户能点到的第二个入口。
- **反证三层**（用来兜住「其实有人读，只是写法怪」）：同文字的字符串字面量、`as any` 邻域（±200 字符）、`*.ipc` 文件里同名字符串。三层全零且三层读点也零，才判「无人读」。

扫描范围是 `src/` 下 `.ts`/`.tsx`/`.mjs`，外加 `scripts/*.mjs`；跳过 `node_modules` 与原型目录。

## 结论分布

- 有读点、单写口：62
- 多处写：6
- 改了要重启（必须重启进程或游戏）：1
- 下次生效（下一个动作才读）：2
- 可疑（只有反证命中）：0
- 无人读（死配置）：0

## 逐字段表

| 键 | 类型 | 默认值 | 读点 | 写点 | 反证（字面量/`as any`/IPC） | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `provider` | `ProviderConfig` | `{ … }` | 108 | src/renderer/src/panel/pages/engine.tsx:5 | 19/0/0 | ok |
| `providerKeys` | `Partial<Record<ProviderId, string>>` | `{ … }` | 23 | src/renderer/src/panel/pages/engine.tsx:1 | 2/0/0 | ok |
| `providerReasoning` | `Partial<Record<ProviderId, boolean>>` | `{ … }` | 30 | src/renderer/src/panel/pages/engine.tsx:1 | 0/0/0 | ok |
| `translationMaxWords` | `number` | `16` | 12 | src/renderer/src/panel/pages/engine.tsx:1 | 0/1/0 | ok |
| `proxyUrl` | `string` | `''` | 8 | src/renderer/src/panel/pages/engine.tsx:1 | 0/0/0 | ok |
| `targetLang` | `string` | `'zh-CN'` | 10 | src/renderer/src/panel/pages/engine.tsx:1 | 0/0/0 | ok |
| `targetLang2` | `string` | `''` | 3 | src/renderer/src/panel/pages/engine.tsx:1 | 0/0/0 | ok |
| `ttsOutputDevice` | `string` | `''` | 14 | src/renderer/src/panel/pages/talk.tsx:3 | 3/0/0 | ok |
| `interpretMode` | `boolean` | `false` | 12 | src/renderer/src/panel/pages/talk.tsx:1 | 0/0/0 | ok |
| `interpretInDevice` | `string` | `''` | 8 | src/renderer/src/panel/pages/talk.tsx:1 | 0/0/0 | ok |
| `captureSilencePreset` | `string` | `'short'` | 4 | — | 0/0/0 | ok |
| `micDevice` | `string` | `''` | 9 | src/renderer/src/panel/pages/talk.tsx:1 | 2/0/0 | ok |
| `ttsMonitorLocal` | `boolean` | `false` | 7 | src/renderer/src/panel/pages/talk.tsx:1 | 0/0/0 | ok |
| `ttsOutEngine` | `VoiceOutEngine` | `'edge'` | 13 | src/renderer/src/panel/pages/talk.tsx:1 | 2/0/0 | ok |
| `ttsOutVoice` | `string` | `''` | 8 | src/renderer/src/panel/pages/talk.tsx:1 | 2/0/0 | ok |
| `shadowFirstMatch` | `boolean` | `true` | 1 | — | 0/0/0 | ok |
| `ttsMuteHeroes` | `string[]` | `[ … ]` | 7 | src/renderer/src/panel/pages/helm.tsx:1<br>src/renderer/src/panel/pages/talk.tsx:1 | 0/0/0 | 多处写 |
| `ttsMuteNames` | `string[]` | `[ … ]` | 5 | src/renderer/src/panel/pages/talk.tsx:1 | 0/0/0 | ok |
| `speechSplitStrategy` | `SpeechSplitStrategy` | `'punctuation'` | 6 | src/renderer/src/panel/pages/talk.tsx:1 | 0/0/0 | ok |
| `ttsSpeakKey` | `string` | `'F5'` | 8 | src/renderer/src/panel/pages/talk.tsx:1 | 2/0/0 | ok |
| `ttsSpeakMode` | `SpeakMode` | `'hold'` | 8 | src/renderer/src/panel/pages/talk.tsx:2 | 2/0/0 | ok |
| `voiceOutTestMode` | `boolean` | `false` | 10 | src/renderer/src/panel/pages/talk.tsx:1 | 2/0/0 | ok |
| `voiceTranscribeOnly` | `boolean` | `false` | 5 | src/renderer/src/panel/pages/talk.tsx:1 | 2/0/0 | ok |
| `clauseStreamVoice` | `boolean` | `false` | 7 | src/renderer/src/panel/pages/engine.tsx:1 | 0/0/0 | ok |
| `voiceShowTiming` | `boolean` | `false` | 7 | src/renderer/src/panel/pages/talk.tsx:1 | 2/0/0 | ok |
| `asrActiveModel` | `string` | `''` | 10 | src/main/services/train/asr-ft.ts:2<br>src/main/services/voice/asr-model.ts:1 | 2/0/0 | 多处写 |
| `asrTrainEngine` | `string` | `''` | 2 | src/renderer/src/panel/pages/asr-train.tsx:1 | 1/0/0 | ok |
| `asrHotwords` | `string` | `''` | 13 | src/renderer/src/panel/pages/talk.tsx:3 | 7/0/0 | 下次生效 |
| `asrCorrectionsToDataset` | `boolean` | `true` | 9 | src/renderer/src/panel/pages/asr-train.tsx:1 | 2/0/0 | ok |
| `asrRouteShortLong` | `boolean` | `false` | 8 | src/renderer/src/panel/pages/asr-train.tsx:1 | 0/0/0 | ok |
| `trainKind` | `'demo' \| 'asr-ft' \| 'gv-gpt' \| 'gv-sovits'` | `'demo'` | 2 | — | 2/0/0 | ok |
| `trainDataset` | `string` | `''` | 3 | — | 2/0/0 | ok |
| `asrFtEnvDir` | `string` | `''` | 4 | — | 0/0/0 | ok |
| `autoStartCapture` | `boolean` | `true` | 17 | src/renderer/src/panel/pages/overlay.tsx:1 | 2/0/0 | ok |
| `quickPhrases` | `string[]` | `DEFAULT_QUICK_PHRASES` | 15 | src/renderer/src/panel/pages/chatout.tsx:1 | 3/0/0 | ok |
| `myNicknames` | `string[]` | `[ … ]` | 3 | src/main/services/gsi.ts:1<br>src/renderer/src/panel/pages/overlay.tsx:1 | 0/0/0 | 多处写 |
| `replyTone` | `ReplyTone` | `'terse'` | 7 | src/renderer/src/panel/pages/chatout.tsx:1 | 2/0/0 | ok |
| `overlayText` | `OverlayTextMode` | `'translated'` | 2 | — | 3/0/0 | ok |
| `overlayDigest` | `boolean` | `false` | 5 | — | 1/0/0 | ok |
| `crossToneLookup` | `boolean` | `true` | 2 | src/renderer/src/panel/pages/chatout.tsx:1 | 0/0/0 | ok |
| `ttsReadAloud` | `boolean` | `false` | 13 | src/renderer/src/panel/pages/read.tsx:1 | 1/0/0 | ok |
| `ttsReadOwn` | `boolean` | `false` | 6 | src/renderer/src/panel/pages/read.tsx:1 | 2/0/0 | ok |
| `announceTotal` | `boolean` | `false` | 2 | src/renderer/src/panel/pages/read.tsx:1 | 1/0/0 | ok |
| `announceTriggers` | `Partial<DotaAnnounceTriggers>` | `{ … }` | 3 | src/renderer/src/panel/pages/read.tsx:1 | 0/0/0 | ok |
| `glossaryPackName` | `string` | `''` | 3 | src/main/services/glossary-pack.ts:1 | 0/0/0 | ok |
| `ttsDropBacklog` | `boolean` | `true` | 7 | src/renderer/src/panel/pages/read.tsx:1 | 1/0/0 | ok |
| `ttsSpeakPrefix` | `'front' \| 'back' \| 'off'` | `'front'` | 9 | src/renderer/src/panel/pages/read.tsx:1 | 0/0/0 | ok |
| `ttsSpeakSegmentChars` | `number` | `30` | 9 | src/renderer/src/panel/pages/read.tsx:1 | 2/0/0 | ok |
| `ttsSpeakFrontTpl` | `string` | `'{who}说，{body}'` | 4 | src/renderer/src/panel/pages/read.tsx:1 | 0/0/0 | ok |
| `ttsSpeakBackTpl` | `string` | `'{body}，{who}表示'` | 4 | src/renderer/src/panel/pages/read.tsx:1 | 0/0/0 | ok |
| `ttsRate` | `number` | `1` | 12 | src/renderer/src/panel/pages/read.tsx:1 | 0/0/0 | ok |
| `ttsPitch` | `number` | `1` | 8 | src/renderer/src/panel/pages/read.tsx:1 | 2/0/0 | ok |
| `ttsVoice` | `string` | `''` | 6 | src/renderer/src/panel/pages/read.tsx:1 | 2/0/0 | ok |
| `ttsOfflineVoice` | `OfflineVoiceId` | `'baker'` | 5 | src/renderer/src/panel/pages/read.tsx:1 | 0/0/0 | ok |
| `ttsEngine` | `'system' \| 'edge' \| 'offline' \| 'sovits'` | `'edge'` | 10 | src/renderer/src/panel/pages/read.tsx:1 | 2/0/0 | 下次生效 |
| `ttsSovitsUrl` | `string` | `'http://127.0.0.1:9880'` | 6 | src/renderer/src/panel/pages/packs.tsx:1 | 0/0/0 | ok |
| `ttsSovitsRefAudio` | `string` | `''` | 12 | src/main/services/voice/sovits-server.ts:1<br>src/renderer/src/panel/pages/packs.tsx:2 | 0/0/0 | 多处写 |
| `ttsSovitsPromptText` | `string` | `''` | 6 | src/main/services/voice/sovits-server.ts:1<br>src/renderer/src/panel/pages/packs.tsx:2 | 0/0/0 | 多处写 |
| `ttsSovitsPromptLang` | `'zh' \| 'en'` | `'zh'` | 2 | src/main/services/voice/sovits-server.ts:1<br>src/renderer/src/panel/pages/packs.tsx:2 | 0/0/0 | 多处写 |
| `ttsSovitsHome` | `string` | `''` | 2 | src/renderer/src/panel/pages/packs.tsx:1 | 0/0/0 | ok |
| `overlayLocked` | `boolean` | `true` | 3 | — | 3/0/0 | ok |
| `overlayCollapsed` | `boolean` | `false` | 3 | — | 1/0/0 | ok |
| `overlayVisible` | `boolean` | `false` | 3 | — | 1/0/0 | ok |
| `overlayOpacity` | `number` | `0.34` | 2 | — | 3/0/0 | ok |
| `overlayFontSize` | `OverlayFontSize` | `'normal'` | 1 | — | 1/0/0 | ok |
| `overlayBoundsByDisplay` | `BoundsMemory` | `{ … }` | 6 | src/main/windows/overlay.ts:1 | 2/0/0 | ok |
| `voiceCaptureMode` | `CaptureMode` | `DEFAULT_CAPTURE_MODE` | 9 | src/renderer/src/panel/pages/hotkeys.tsx:2 | 2/0/0 | ok |
| `boardVisible` | `boolean` | `false` | 7 | src/renderer/src/panel/pages/overlay.tsx:1 | 1/0/0 | ok |
| `boardBounds` | `OverlayGeometry \| null` | `null` | 2 | src/main/windows/board.ts:1 | 0/0/0 | ok |
| `hotkeys` | `Record<HotkeyActionId, string>` | `{ … }` | 28 | src/main/services/hotkeys.ts:1 | 11/0/0 | ok |
| `gsiLibraryRoot` | `string` | `''` | 4 | src/main/services/gsi-config.ts:1 | 0/0/0 | 改了要重启 |

## 多写口（只列不判）

这一节**不手抄清单**：字段会增加、写口会搬，抄一份在这里就一定会有一次是旧的（本文件第一版抄过七条，其中一条 `ttsMuteNames` 在 #93 之后只剩一个写者，成了僵尸条目）。

现问现答，跑：

```
node scripts/check-settings.mjs --report | sed -n '/多处写/,/^$/p'
node scripts/check-settings.mjs --json            # 机器可读：rows[].writes[].path
```

脚本对每条多写口都给一句「是不是有意」（`src/renderer/src/panel/pages/*` 的一次性写与主进程的整组写分开列），`--strict` 在「有多写口但没注记」时非零。

**判据不锁条数**：`--strict` exit 0 + 每条多写口都带注记，就够了；条数随代码走（写口被合并时少一条是好消息）。把「仍是 N 条」当判据是坏判据——它会把「写者变少了」也判成回归，本文档第一版就这么锁过一次（写 7 条，实际 6 条）。

## 改了要重启

- `gsiLibraryRoot`：Dota 只在启动时读 GSI 配置，换库后写的新 cfg 要等游戏重启才被读到。提示原文在 `src/renderer/src/panel/pages/overview.tsx`，检查器会核对那句话还在不在（不在了就报「提示丢了」）。

「下次生效」另一栏，不算重启：

- `asrHotwords`
- `ttsEngine`

## 下次生效（附：在哪个动作之后）

- `asrActiveModel`：下一句识别。识别器按需加载，切模型会重载一次图；现在面板没说这句，报告里点出来。
- `ttsEngine`：下一次合成。引擎在合成时才读设置。
- `asrHotwords`：下一次识别。热词是识别器的构造参数，改了就重载。

## 无人读（死配置）

- 没有。

历史案例是 `quickPhraseGroups`：`#117` 加了分组能力，`#159` 发现全仓零个写入者、只有两处读者，于是删掉字段、读者改传空数组。这次巡检里它已经不是字段了。

「无人读」判定的可信度全看反证：动态键拼接（`settings[name]`）、`as any` 绕过去、IPC 通道名，三层都试过还是零，才写这条结论。基线现在为空，新增一条会让检查器非零退出，逼人回来看一眼。

可疑（只有反证命中、读点为零）：

- 没有。

## 真实 settings.json

`node scripts/check-settings.mjs --settings <path>` 只读核一遍真实文件（不写 `data/`）。拿本机那份跑：

```
76 个键，未知键 5 个（quickPhraseGroups, whisperBinPath, sendMode, consoleKey, overlayClickThrough）
```

`quickPhraseGroups` 是 `#159` 删掉的字段，其余四个是更早退役的设置。它们留在文件里不会出错——归一化时被静默丢掉——但「文件里有、代码里没有」这件事只有巡检说出来，否则没人知道。

## 每条结论的复现命令

- 字段数、默认值数、分布：`node scripts/check-settings.mjs`
- 逐字段表：`node scripts/check-settings.mjs --report`
- 机器可读（含读点三层明细、写点文件、反证计数）：`node scripts/check-settings.mjs --json`
- 某个键为什么判死：`grep -rn "键名" src/ scripts/`，再对照 `--json` 里该行的 `reads`/`writes`/`counter`
- 重启提示还在不在：`node scripts/check-settings.mjs` 末尾的「改完要重启」段，或者直接 `grep -n "重启游戏" src/renderer/src/panel/pages/overview.tsx`
- 真实文件未知键：`node scripts/check-settings.mjs --settings data/settings.json`

## 检查器的接线与退出码

`npm run lint` 末尾多了 `npm run check:settings`。默认模式只打印摘要，**永远 exit 0**，免得每加一个设置项就有人把新字段当问题改掉；只有两种情况非零退出：

- `AppSettings` 与 `DEFAULT_SETTINGS` 的键对不上（漏默认值会让归一化写出 `undefined`）
- 死配置比基线多一条（基线现在为空）

`--strict` 才把「多写口未注记」也算问题，日常 lint 不用它。

## 三条红线（票面要求，逐条对上）

- 不许顺手删死配置：这次判死 0 条，一条都没删。以后每删一条单独开票。
- 检查器不许写 `data/`：全程只读；`--settings` 打开真实文件也只用 `readFileSync`。
- 不许连 provider：脚本只做静态扫描，没有任何网络调用。
