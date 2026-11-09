---
created: 2026-11-09
updated: 2026-11-09
tags: [adr, voice-capture, hotkeys]
---

# 语音对讲：按住说话 / 敲一下开始

## 背景

对讲热键 `voiceCapture`（默认 `Alt+Shift+V`）从落地起只有一种语义：按一下开始录、再按一下结束。
用户实测后指出这和声出侧的「说话方式」不是一回事——他要的是对讲机式手感：**按住说，松开就触发**整条
识别 → 翻译 → 播报链路。两种手感都有人用，所以不是替换，是二选一。

难点在「松开」：Electron 的 `globalShortcut` 只回调**按下**，没有任何松开事件；按住的语义就必须自己拿。

## 决定

- 新增设置 `voiceCaptureMode: 'hold' | 'toggle'`，默认 `hold`（按住）。它只影响 `voiceCapture` 一个动作，
  和声出侧的 `ttsSpeakMode` 各管一头，互不联动——那边是「播报时替玩家按游戏说话键」，这边是「玩家怎么触发录音」。
- **松开的检测用常驻 PowerShell 轮询 `GetAsyncKeyState`**（`src/main/services/input/hotkey-hold.ps1`，
  40 ms 一拍，状态翻转才输出 `HOLD 1` / `HOLD 0`），进程由 `hotkey-hold.ts` 管：同组合键只换处理函数不重开，
  换键或切回敲一下时 kill。
- 按住模式下这个动作**不注册 `globalShortcut`**。两边同时监听会让一次按下先开录、又被 toggle 关掉，
  表现为「按住一秒就停」。
- 组合键支持靠 `acceleratorVks()`（`src/shared/hotkeys.ts`）把 canonical 写法翻成 VK 码：修饰键、
  F1–F24、字母数字、常用符号都在表里；拆不出来就退回 `globalShortcut` 的敲一下，并打 `HOTKEY_HOLD_NO_VKS`。
- 常驻进程崩了 3 秒退避重开 5 次；仍起不来就打 `HOTKEY_HOLD_GIVE_UP` 并调 `onUnavailable`，
  由注册方临时补一个 `globalShortcut` 敲一下——**热键绝不能变哑**。

## 为什么不挂键盘钩子

`SetWindowsHookEx(WH_KEYBOARD_LL)` 是事件驱动的，看起来更「正确」，代价是全局钩子会被游戏与反作弊软件
额外审视，而这里只需要一组键的按下/松开。轮询 25 Hz 读状态不注入、不拦截、不改按键，开销在音频链路旁边
可以忽略。真有一天需要精确到毫秒的 keydown/keyup，再评估钩子，不在没有证据时先付这个代价。

## 后果

- 录音横幅按模式换文案（`recordingStageLine`）：按住说「松开结束」，敲一下点名那个键。同一句文案会让
  用户对着「再按一下结束」按住不放。
- 面板热键页多一块「语音对讲怎么按」，两种模式即时保存；热键表本身的保存/撞键逻辑不变。
- `voiceCaptureMode` 纳入 `--settings-persist-probe`；`acceleratorVks` / `normalizeCaptureMode` /
  `recordingStageLine` 由 `--hotkey-probe` 钉死。
- 待真机验收：Dota 2 开着时按住 3–5 秒再说，确认松开即触发、且长按不会被 20 秒录音上限提前截断；
  以及组合键（Alt+Shift+V）在游戏窗口焦点下依然能被 `GetAsyncKeyState` 读到。
