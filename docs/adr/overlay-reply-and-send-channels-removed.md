# ADR：移除浮层回复框与两条非原地文出通道
- 状态：已接受（2026-11-07）
- 关联：`docs/DESIGN-overlay-v2.md`（浮层 v2 全量设计）；GLOSSARY「文出」「原地直发」「呼出面板」词条

## 背景
浮层 v1 的文字出口有三条腿：原地直发（`chat-inplace`，Alt+Shift+T 读聊天框草稿翻译贴回）、程序化打聊天框（`chat-send`，激活游戏窗口后逐键输入）、控制台 say_team（`console-send`，经 Source 2 控制台下发指令）。对应设置 `sendMode: 'inplace' | 'chat' | 'console'` 与 `consoleKey`；非原地两档会先弹浮层回复框（textarea + 草稿落盘 + 已发送绿行），让用户写中文再翻再发。

浮层 v2 重做访谈（2026-11-07）确认：用户真正在用的只有 Alt+Shift+T 原地直发；回复框在对局里抢键盘焦点、打断节奏；两条旧通道是早期"发不进去"时代的备份路线，如今从未成为主路径。

## 决定
- 删除浮层回复框整个功能：textarea UI、草稿落盘（`oh-my-dota2.overlayDraft`）、已发送绿行、`sendReply` IPC 与其实现。
- 删除 `chat-send` 与 `console-send` 两个 PowerShell 桥及设置 `sendMode` / `consoleKey`。
- 文字出口收敛为唯一一条：原地直发（热键 Alt+Shift+T，行为不变，失败时浮层一次性提示说明原因）。
- 「想对队友说点什么」的其余诉求收敛到呼出面板：历史回看、快捷短语、AI 建议回复，全部点行复制进剪贴板，不在游戏里自动发送。
- 声出（voiceReply 语音对讲一键到底）与剪贴板翻译不受影响。

## 理由
- 维护面积：每条非原地通道都是一套常驻 PowerShell 桥 + 按键时序调参；原地直发一条腿已覆盖实际使用。
- 交互一致性：锁定浮层弹输入框抢全局焦点，与「锁定=零交互」的浮层红线冲突；呼出面板（临时形态）是同一条红线的合法例外，且复制比自动发送更安全（发错话收不回）。
- 探针债务：`--input-probe` 测的 draft→translate→command 决策缝随通道一起消失。

## 后果
- `src/main/services/input/` 只剩 `chat-inplace`、`ps-runner`、`ptt-key`（声出按语音键仍依赖 ptt-key）。
- 热键动作 `inplaceSend` 不再分流：`sendMode` 删除后恒为原地直发。
- `--input-probe` 删除；`normalizeChatLine` 的案例并入 `--inplace-guard-probe`。
- 若未来要恢复自动发送类通道，需重开本 ADR 并先回答「为什么复制不够」。
