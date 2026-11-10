# 交接：讲话卡顿与浮层鼠标（oh-my-dota2）

这是一份**活的**交接文档：每轮结束直接改这一份，不再新建带日期的交接文件。
`docs/HANDOFF-2026-11-10.md` 是另一条线（架构走查），不要混在一起。

## 一句话状态

讲话卡顿的两笔提交已推送（`dfbb755`、`bc18ac4`），用户当时说「现在不卡了」，但他手上**有关于卡顿的新进展一直没讲**——下一轮第一件事仍是请他讲完，不要先动代码。
浮层那条线本轮改了「锁定后鼠标仍有反应」，静态检查已过，**真机未验**。


对讲行的「翻译中…」改成了阶段留痕（`译 1ms · 合 2ms · 起播中…`，见 `docs/adr/voice-stage-trace.md`）：
静态检查全绿，**探针没跑、构建没跑、真机没验**——探针要独占单实例锁，先问用户能不能停他那个 `npm run dev`。
## 用户的最新动向

- 原话（paraphrased）：「卡顿的问题（这个会话中）之前的讨论还有印象吗？我发现了最新进展」。随后没讲进展，直接要求生成交接文档。
- 下一轮开场要问的是：新进展是什么（又卡了、换了设备、还是从别处找到了原因）。
- 随后用户转到浮层：要求「锁定之后不能对他有任何操作，然后他不影响我玩游戏的时候点到那个位置」。这句是本轮唯一的验收口径。
- 之后用户要求把这份交接落进项目，并且**以后交接继续写在这个文件里**。

## 已确认的事实（有证据，别重查）

- 采集的是**麦克风输入**，不采耳机、不采环回。入口是 `src/renderer/src/lib/mic.ts` 的 `openMicStream()`。
- 设备选择三层优先级：
  - 面板点名设备（`preferredDeviceId` 非空）→ `deviceId: { exact }`，完全不查 Windows 默认。
  - 面板「自动」→ 读 `localStorage` 缓存（键 `oh-my-dota2.captureDeviceId`），也是 `exact`。
  - 两者都空（首次运行、换机、清数据）→ 才走不带 `deviceId` 的 `getUserMedia`，只有这一层碰系统默认。
- 根因：那次不带 `deviceId` 的默认开麦打中的是蓝牙耳机（Windows 默认输入是 `LINKLIKE Cloudpods`），蓝牙从 A2DP（音乐）切到 HFP（通话），游戏声音断 1–2 秒；随后换成内置麦又切回来，一次对讲断两下。详见 `docs/NOTES.md` 的「开麦把蓝牙耳机切进通话模式，游戏声音断一两秒」。
- 性能侧已排除饱和：逐核峰值只有约 3 个核超 80%、持续约 1 秒（ASR 那一下），GPU 峰值 54–63%，显存基本不动。
- 真机日志证明实际开的是内置麦：`data/logs/voice-chain.jsonl` 里 `"mic":"麦克风阵列 (适用于数字麦克风的英特尔® 智音技术)|2e1421a6"`。所以「不卡了」是设备生效的结果，不是这台蓝牙能双工。
- 已作废的假象：`Win32_PerfRawData_PerfOS_Processor.PercentProcessorTime` 是反向计数器（累计的是空闲），早期「CPU 47%」这类数字全部作废。逐核忙闲用 `busy = 100 - PercentIdleTime`，进程占用用 `Get-Process` 的 `.CPU` 差值才可靠。

## 还没解决的事

- 用户关于卡顿的「新进展」始终没讲出来，这是最大的一条未决。
- 交接文档记 `data/settings.json` 的 `micDevice = "488a6f4a7d103301df2dd7a91a5ddff635794fb3d71327b3c982c60a61c3d50f"`，与本轮读到的 `"micDevice": ""` 以及实际开的 `2e1421a6` 三者不一致。说明点名 `{ exact }` 失败后会退回自动选择，而 `MIC_PREF_FAIL` 只打在渲染层控制台。已提议在面板「讲话设备」行显示「已保存的设备打不开，当前用 XX」，用户还没答。
- 有一次 TTS 合成之后 Chromium 报 `Network service crashed` 与 `GPU process exited unexpectedly: exit_code=-1`，当时显存 6.8/8.2 GB（GPT-SoVITS 常驻占着）。是否与卡顿同源未知。
- 浮层：真机验证仍欠着（锁定后指针划过不亮、锁定态 Tab 不误抓键盘、面板里能点能复制）。
## 本轮改动一：锁定后浮层不得对鼠标有任何反应（未真机验证）

- 用户口径：「锁定之后不能对他有任何操作，然后他不影响我玩游戏的时候点到那个位置」。
- 根因：`setIgnoreMouseEvents(true, { forward: true })`。`forward` 把鼠标**移动**消息转发给页面（Electron 类型文档 `IgnoreMouseEventsOptions`：forwards mouse move messages to Chromium），点击从来不转发。于是点击进了游戏，CSS `:hover` 照样跟着指针跑，看着像「锁定没生效」。
- 改动（`src/main/windows/overlay.ts`）：
  - `applyClickThrough()` 改成 `this.win.setIgnoreMouseEvents(ignore)`，不带 `forward`。
  - `createWindow()` 里补一次穿透样式：`applyGeometry` / `togglePanel` 会直接开窗，只在 `show()` 里设会漏。
- 文档同步：`docs/NOTES.md` 新增「锁定后鼠标划过浮层还会亮 = forward 把移动消息喂给了页面」一节；`GLOSSARY.md` 把「锁定 = 点击穿透 + 防截屏」改成「锁定 = 对鼠标完全无感（不亮、不拖、不滚）+ 防截屏」；`AGENTS.md` 里 `shouldIgnoreMouse(locked, replyOpen)` 的笔误改成 `panelOpen`，并补了别传 `forward` 的理由。
- 已过：两个 `tsc --noEmit`、`npx eslint .`（0 error，只剩 `button.tsx:41` 老警告）、`check:shared`、`check:docs`、`check:pure`。
- 真机验收要看两样：锁定后指针划过浮层不亮；窗口扩展样式确实带 `WS_EX_TRANSPARENT`。
- 刻意保留：呼出面板打开时仍可点（否则 `Alt+Shift+H` 唤出来就点不动）。用户若要求一刀切，改 `shouldIgnoreMouse` 的 `panelOpen` 分支。


## 本轮改动二：Esc 关面板 + 防截屏跟着「能不能操作」走（未真机验证）

- Esc：按钮上一直写着「关闭（Esc）」，但全仓库没有一处处理 `Escape`。现由 `SummonPanel` 自己挂 `keydown`，命中就调 `overlayPanelToggle()`，状态与穿透恢复仍交给主进程 `togglePanel`。
- 防截屏：原来 `setContentProtection(this.s.locked)`，于是「锁定状态下按 Alt+Shift+H 唤出面板」既挡截图又丢鼠标消息（`WDA_EXCLUDEFROMCAPTURE` 的副作用），看着像面板坏了。新增纯函数 `shouldProtectContent(locked, panelOpen) = locked && !panelOpen`（`src/shared/overlay-geometry.ts`），`applyClickThrough()` 与 `createWindow()` 都用它。
- 探针 `src/main/probes/overlay-geometry.ts` 补两条断言：`锁定就挡截图`、`面板开着不挡截图`。
- 文档同步：`AGENTS.md` 的浮层诊断段改为两个纯缝并列；`docs/NOTES.md` 改「防截屏会让浮层收不到鼠标」并新增「呼出面板关不掉：文案写着 Esc，代码里没人监听」；`GLOSSARY.md` 补「呼出面板是唯一例外」。
- 已过：`tsc` 两套配置、`npx eslint .`（0 error，1 个既有 `button.tsx:41` 警告）。真机验收同上一节。
## 代码现状

讲话卡顿的两笔提交在 `origin/main`（SSH 远端 `git@github.com:mystery4f/oh-my-dota2.git`）：

- `dfbb755 fix(voice): keep capture off the Bluetooth call path` — 缓存选中的输入端点、`warmMic()` 预热、面板新增「讲话设备」下拉、`settings.micDevice` 字段、`docs/NOTES.md` 新小节。
- `bc18ac4 feat(voice): record which capture device each utterance used` — 每条对讲记录实际使用的设备（`label|id 前 8 位`），贯穿 `voice-capture.ts` → `transcribeAudio` → `noteAsrRun` → `ChainTimer` → `VoiceChainMeta`，探针补断言，`AGENTS.md` 补三处规则。

关键文件职责：

- `src/renderer/src/lib/mic.ts` — `openMicStream()`、`warmMic()`、`setMicDevicePreference()`、`describeCaptureDevice()`；`pickCaptureDevice()` 在 `src/shared/mic.ts`，负责过滤虚拟声卡与 default/communications 端点。
- `src/renderer/src/overlay/voice-capture.ts` — 录音、静音判定（`SILENCE_RMS 0.012`、最短 `300ms`）、编码 WAV、调 `transcribeAudio` 与 `voiceReply`。
- `src/main/services/voice/chain-timing.ts` — 计时票与 `VoiceChainMeta`（`mic` 现在是必填）。
- `src/main/services/voice/speech-pipeline.ts` — 分句 `splitForSpeech`，每 20 字一段、一次合成。
- `src/shared/overlay-geometry.ts` — `shouldIgnoreMouse(locked, panelOpen)`，穿透规则的唯一出处。
- `src/main/windows/overlay.ts` — 浮层窗口。`startVoiceCapture()` 与 `toggleVoiceCapture()` 都会在隐藏时 `show()`，所以「隐藏浮层」做不成 A/B；收起（`overlayCollapse`）才是逃过 `show()` 的那个。

## 验证方式

```bash
npx tsc --noEmit -p tsconfig.node.json --composite false
npx tsc --noEmit -p tsconfig.web.json --composite false
npx eslint .            # 只允许 src/renderer/src/components/ui/button.tsx:41 那一个 react-refresh 警告
npm run check:shared
npm run check:docs
npm run check:pure
```

运行时证据只看两个文件：`data/logs/voice-chain.jsonl`（`mic`、`asrMs`、`translateMs`、`speakMs`、`totalMs`）与 `data/logs/gsi-chat.jsonl`。

## 环境陷阱（踩过，别再踩）

- 用户会自己在终端跑 `npm run dev`。本次会话开始时的 electron 主进程是 `58012`，父进程 node `54088`。**不要再起第二个 dev 实例**，会抢单实例锁，收场是 `4294967295` 加满屏 `Unable to create cache`。要重启先问用户。
- `bg_run` 走 cmd.exe：必须 `cd /d D:\work\Code\Game\oh-my-dota2-v3 && npm run dev`。写 POSIX 路径只得到 18 字节的「命令语法不正确。」。
- 这个工作区同时有别的 pi 会话在改：`src/main/services/session/translate-cache.ts`、`src/main/index.ts`、`src/main/services/session/durable-translator.ts`、`src/renderer/src/panel/search-index.ts`、`src/shared/provider-reasoning.ts`。提交前只 `git add` 自己碰过的路径。
- `.tmp/` 里的采样脚本是纯 ASCII PowerShell：`.tmp/perf4.ps1`（逐核 + 进程 CPU + nvidia-smi）口径正确，`.tmp/perf-sample2.ps1` 的公式是错的，`.tmp/perf-core.ps1` 用的是反向计数器，都别信。

## 建议下一会话先读

- `docs/NOTES.md` 的「开麦把蓝牙耳机切进通话模式」与「锁定后鼠标划过浮层还会亮」两节。
- `AGENTS.md` 里「Where state lives」的 `voice-chain.jsonl` 字段说明，以及「Hard rules learned the hard way」中浮层诊断与 stage 路径两条。

## 建议调用的技能

- `code-review`：若本轮要审这两笔提交的 diff，标准与规格两条轴分开报。
- `writing-for-agents`：若要再改 `AGENTS.md`（上下文预算、信息层级、消除 negation）。
- `code-simplification`：卡顿修复若又动了非平凡代码，收尾前跑一遍。
- `retro` 与 `wiki-retro`：收尾按用户既有要求，先 retro 再 wiki-retro，回报分三段（建议、已存、待定）。
