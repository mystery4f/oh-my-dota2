---
created: 2026-11-09
updated: 2026-11-09
tags: [adr, voice-out, audio]
---

# 声出经 VB-Cable 进 Dota 2 语音频道

## 背景

对讲链路（热键 → 录音 → 识别 → 翻译 → 合成 → 播到 `ttsOutputDevice` 并按住说话键 `speakKey`）已在代码里贯通，
但「队友到底听不听得到」这一环一直挂在 `docs/TODO.md` 的待定项：虚拟声卡选型（VB-Cable vs VoiceMeeter）。
现状能做到的只有「播到某个输出设备」：用户选了系统默认扬声器，声音只是从音箱出来，不会进游戏语音；
面板也没有任何地方告诉他缺这块虚拟声卡。

## 决定

- 虚拟声卡选 **VB-Cable**（VB-Audio Virtual Cable）。单设备、免费、安装一步、没有额外路由界面；
  VoiceMeeter 的混音/多路能力对单腿声出用不上，配置错误面反而更大。
- **检测放在主进程**，不放在渲染层。`enumerateDevices()` 的 `label` 在媒体授权前是空串，
  不能把「看不到名字」当成「没装」；端点名读 MMDevices 注册表（`Render` + `Capture` 的 FriendlyName），
  驱动名读 `Win32_SoundDevice`，服务状态读 SCM 的 `VBAudioVACWDM`——三样都与浏览器授权无关，且不碰麦克风。
  不用 `Get-PnpDevice`：实测 2.6 秒起，8 秒超时会被判成「没查成」，是看不见的假阴性。
  脚本末尾显式 `exit 0`：缺服务时 PowerShell 会让进程返回 1，否则「没装」会被报成「查询失败」。
- 面板「对讲」页新增一行 **虚拟声卡**：未装 → 黄字 + 「怎么装」；已装 → 灰字点名设备，
  并在 `ttsOutputDevice` 不是 CABLE Input 时给一个「设为输出」按钮。
- 引导走面板现有 `Modal`，**不自动安装驱动**：驱动安装一律由用户点官方链接自己完成。
  步骤四步：装 VB-Cable → 重启（音频端点才会出现）→ Dota 2 设置 → 音频 → 语音输入设备选
  `CABLE Output` → 回到本页输出设备选 `CABLE Input`。
- **不改 Dota 2 自己的配置**：游戏侧输入设备没有可靠的程序化入口，只能引导；写它的 cfg 属于越界。
- **不阻断**：检测只用于提示，不 disable 录音、声出或任何热键。误判（驱动改名、精简版系统）
  的最坏结果是「引导多余」，不是「功能不可用」。
- 运行时真相以播放结果为准：`VoiceOutTestResult` 增 `sinkLabel`（`SegmentSpeakInfo` 已有），
  测试结果显示「已播到 CABLE Input」或「播到系统默认（队友听不到）」。

## 实现落点

- `src/shared/voice-out.ts`：新增纯函数 `matchVirtualCable(names: string[])` →
  命中的设备名或 `null`（`/vb-audio|cable/i`），探针可直接验。
- `src/main/services/voice/virtual-cable.ts`：调 PowerShell 查端点/服务 → `VirtualCableStatus`
  （`installed` / `endpoints` / 出错原因），5 秒缓存；只读。
- `src/shared/ipc.ts`：新增 `voiceOutCable`（查状态）与 `appOpenExternal`（仅 https）两条契约；
  preload 与 `api-stub.ts` 同步补，漏一步就是编译错误。
- `src/renderer/src/panel/pages/talk.tsx`：「虚拟声卡」行 + 安装引导 `Modal`。
- `src/main/services/voice/virtual-cable-install.ts`：一键安装（下载官方包 → 解压 → 提权拉起官方安装器）。
- `src/main/services/voice/voice-out.ts`：测试结果带上实际输出设备名。
- `src/main/probes/voice-out.ts`：`matchVirtualCable` 正反例（含中文系统下的乱码名、大小写）。
- 文档：`docs/TODO.md` 待定项改为已定，`GLOSSARY.md` 增「虚拟声卡」词条，`docs/INDEX.md` 登记本文件。
## 一键安装的边界

许可与驱动机制决定「一键」只能做到三步里的前两步，第三步必须用户参与：

| 步骤 | 谁做 | 说明 |
|---|---|---|
| 下载官方包 | 应用 | 页面上取版本号最大的 `VBCABLE_Driver_Pack<N>.zip`；直连失败改走 Chromium 网络栈（跟随系统代理） |
| 解压到 `userData/vb-cable` | 应用 | 系统自带 `bsdtar`（`System32\tar.exe`），Git Bash 的 GNU tar 读不了 zip |
| 提权运行官方安装器 | 应用发起，用户确认 | `Start-Process -Verb RunAs` 弹 UAC；向导走完还要重启电脑 |

不做的两件事：不把 VB-Cable 打进我们的安装包（readme 明写「不得并入其他软件的安装流程」），
不静默注入驱动（官方没有文档化静默参数，且同样踩许可条款）。UAC 被拒时包已经落在磁盘上，
面板提示目录，用户可以自己双击 `VBCABLE_Setup_x64.exe`。

## 本机监听（调试期）

正式形态是「队友听得到、自己听不到」：译文只进 CABLE Input，扬声器不出声。早期调参时听不到
就没法判断译文质量，所以设置里加 `ttsMonitorLocal`（默认关）：

- 开启后声出窗口对同一份音频开两个 `Audio`：主路绑虚拟声卡（原来的 `setSinkId`），监听路留在
  系统默认输出，两路在同一个 `begin()` 起播（相差几十毫秒，人耳无感）。
- 监听路失败静默：不写 `VOICE_OUT_ENDED`、不影响「已播到 …」判定；结束事件、就绪报告、
  `sinkLabel` 都只认主路。否则监听路哑掉会把一次成功播放误判成失败。
- 关闭时渲染层根本不建第二个播放器，行为与加这个开关之前一模一样。

## 录音端不能跟着系统默认走

`mic.ts` 的 `pickCaptureDevice` 是同一件事的另一半：声出把游戏顶到 `CABLE Output` 之后，用户往往顺手把
Windows 默认输入也改成它，于是对讲自己录到的是「只有 TTS 才会响」的那条线，表现就是
`没有检测到语音（音量 RMS 0.0000）`（实测默认输入 `Default - CABLE Output`，静音段 RMS 8.8e-6）。

- 选路规则（纯函数，探针可测）：显式指定优先 → 否则第一块既不是虚拟声卡、也不是立体声混音/Line In 的输入；
  全都不可用时返回 `null`，调用方保留系统默认，不硬换。
- 落地在 `src/renderer/src/lib/mic.ts` 的 `openMicStream()`：先按默认开一次拿设备名（label 要授权后才有），
  发现默认那路是虚拟线就用 `deviceId: { exact }` 重开，换失败沿用第一路并写 `MIC_SWITCH_FAIL`。
- 两条录音腿（对讲 `voice-capture.ts`、训练 `use-recorder.ts`）都走这个入口，规则只有一处。
## 说话方式：按住 / 敲一下

游戏里语音按键有两种设置，声出必须跟着选，否则同一个键在游戏那边是另一种语义：

- `hold`（`ttsSpeakMode` 默认值）：起播前按下说话键并一直按着，整单播完、再过 `PTT_MARGIN_MS` 才松开——对应游戏的「按住说话」。
- `toggle`：起播前敲一下（按下再松开）开麦，整单播完再敲一下关麦——对应游戏的「切换」，玩家听到的就是「按两下说一句」。

两条规则共用 `SegmentPlayer` 的同一个收尾 `finish()`：中途失败、结束事件超时、空段都必须把通道关掉，
`toggle` 的关麦动作是再敲一下而不是松键。落盘归一化只认这两个值，乱填打回 `hold`——坏值落到
`toggle` 的后果是「开麦不关」，队友全程听到房间回声。真机按键时序是 PowerShell/SendInput 的副作用，
探针只能钉住默认值与归一化，键在游戏里是否开麦由真人验收。

## 流程

```mermaid
graph LR
  A[用户装 VB-Cable] --> B[重启后出现两个端点]
  B --> C[Dota2 语音输入 CABLE Output]
  C --> D[本应用输出 CABLE Input]
  D --> E[声出播放 + 说话键 按住或敲一下]
  E --> F[队友听到英文]
```

## 后果

- 首次使用者从「不知道为什么队友没反应」变成一条明确的四步路径。
- 驱动层检测比浏览器枚举多一个 PowerShell 进程（一次查询，5 秒缓存），开机首查约 300–800 ms，
  只在对讲页打开时触发。
- 用户坚持用系统默认输出时功能不会被拦，但测试结果会明确说「队友听不到」。
- 换虚拟声卡（VoiceMeeter 等）不在本期范围：要支持就是再认一个 label 前缀，检测函数保持表驱动。
