# oh-my-dota2 v3 · 计划真相源 (Plan of Record)

> 本文件是需求与计划的唯一权威来源（single source of truth），git 版本化、跨会话持久。
> 执行状态看 [pi-kanban](http://localhost:3460)（数据源 rpiv-todo）；设计细节看 [DESIGN.md](./DESIGN.md)。

## 分层约定

| 层 | 载体 | 职责 |
|---|---|---|
| 需求/计划 | `docs/PLAN.md`（本文件）| 里程碑定义、验收标准、状态勾选 |
| 设计决策 | `docs/DESIGN.md` | 架构、技术选型、Route B 零注入方案 |
| 执行状态 | rpiv-todo → pi-kanban | 会话内任务流转（看板列）|
| 知识沉淀 | LLM Wiki | 调试案例、经验、跨项目洞察 |
| 验收清单 | `docs/ACCEPTANCE.md` | 逐条手动验收步骤与期望结果 |
任务号约定：未完成条目的 `#N` 是 todo 任务 ID（看板可点），完成条目里的 `#N` 是历史排期号，不再回改。


## 需求摘要

Dota 2 跨语言沟通工具（Electron，零注入、VAC 安全）：

- 聊天翻译：屏幕 OCR → AI 翻译 → 透明 overlay 双语显示；中文回复 → 翻译 → 剪贴板
- 语音链路（M4 骨架）：本地 whisper.cpp 转写 + edge-tts 预览
- 多 provider LLM 抽象（DeepSeek 默认，可切 OpenAI/Ollama/自定义）

## 里程碑

### M1 脚手架 ✅ (2026-10-21, commit 95db179)

- [x] electron-vite + React + TS + Tailwind 工程搭建
- [x] 主进程：settings JSON / provider 层 / IPC / 代理
- [x] 渲染层仪表盘：provider 配置 + 翻译试用 + 语音预留
- [x] typecheck / build / eslint 全绿，首次提交

### M2 聊天捕获

- [x] #7 M2a 屏幕区域选择器：全屏拾取框选聊天区，坐标持久化（DPI 感知）（commit 3121d99，已人工验收）
- [x] #8 M2b Windows OCR 桥：PowerShell 常驻进程桥接 Windows.Media.Ocr（E2E 通过：中英文均识别，引擎 zh-Hans-CN）
- [x] #9 M2c 捕获轮询与去重：截图→OCR→去重→翻译→推送 overlay（自测通过：5 条双语 entries 无重复；翻译链路待配置 API key 实测）
- [x] #10 M2d 透明 overlay 窗口：无边框置顶双语信息流，可切换点击穿透（region-probe 实测：entries→overlay DOM 全链路通；框选位置可视化 + Alt+Shift+R 实时框选）

验收：框选 Dota 2 聊天区后，overlay 实时显示翻译后的双语消息，无重复行。

### M3 回复链路

- [x] #11 M3a 回复翻译与剪贴板：中文→英文→写入剪贴板（reply-probe 实测：'稳住，我们能赢，小心他们打肉山' → 'We got this, but watch for their Roshan!' 剪贴板往返一致）
- [x] #12 M3b overlay 回复输入：输入框回车→剪贴板→提示切回游戏粘贴（reply-overlay-probe 实测：openedReply→DOM 输入→回车→'Hold on, don't feed, I'm buying wards' 入剪贴板→自动关闭并归还焦点）

验收：overlay 输入中文回车，游戏内 Ctrl+V 发出英文消息。（✅ 程序侧已验证：翻译入剪贴板 + 焦点归还；游戏内 Ctrl+V 待用户实测）

### M4 语音骨架

- [x] #13 M4a whisper.cpp 适配器骨架（whisperBinPath 已预留）：路径校验 + `--help` 版本探测，转录管线留空（voice-probe 实测：未配置/不存在/可执行 三种分支）
- [x] #14 M4b edge-tts 预览（ttsOutputDevice 已预留）：`edge-tts --voice zh-CN-XiaoxiaoNeural --write-media` 生成预览 mp3，设备路由留待后续（voice-probe 实测：CLI 缺失给出 pip 安装提示）

验收：设置页可选择 whisper 路径与输出设备，接口 stub 编译通过。

### M5 日常可用化（验收：脱离 dev 也能天天用）

- [x] #15 M5a 托盘常驻：Tray 菜单（显示面板 / Overlay 显隐 / 点击穿透 / 开始-停止捕获 / 退出）、关闭窗口隐藏到托盘、单实例锁
- [x] #16 M5b 自动启动捕获：settings.autoStartCapture（默认开）+ 启动时若有 chatRegion 自动 start，状态进托盘 tooltip
- [x] #17 M5c 面板总览：Overview 卡（provider 连通 / OCR 引擎 / 区域 / 捕获 / overlay 快捷键）+ 一键自检
- [x] #18 M5d 过滤自己消息：settings.myNicknames（Dota 聊天 "昵称: 内容" 格式），命中则跳过不翻译

### M6 语音真链路（验收：Alt+Shift+V 说中文→overlay 出英文；TTS 可朗读译文）

- [x] #19 M6a whisper.cpp 落地：自动下载 whisper-bin-x64.zip（release b5454，9MB，走 net 代理）+ ggml-base.bin（141MB，hf-mirror 16 路 Range 并行，实测聚合 ~3.7MB/s），存 userData/whisper/；transcribe(wav) 真实调用 --model --file --language auto --no-timestamps（--whisper-assets-probe 实测 jfk 样本转写全句正确）
- [x] #20 M6b 麦克风采集：renderer getUserMedia + ScriptProcessor 采集，shared/wav.ts 降采样 48k→16k mono 写 WAV（不引入 ffmpeg），Alt+Shift+V 开始/停止录音→转写→翻译→剪贴板，overlay 显示 🎤 原文+译文（--transcribe-probe 实测：SAPI 中文语音→「小心,他们可能在打肉山,准备插颜」，编码器 32044 字节@16kHz 单声道 16bit 校验通过；真麦克风走人工验收）
- [x] #21 M6c TTS 换 msedge-tts：纯 Node 调 Edge 神经语音（无需 Python），websocket 走 HttpsProxyAgent（直连国内 10s 超时），面板 Preview TTS 直接播放 mp3（实测合成 17280 字节）；ttsOutputDevice 虚拟声卡路由仍留待后续

### M7 翻译与回复改造（验收：一段英文聊天整块翻完且前缀不乱；同一句中文四语气英译均 ≤80 字符；回复栏关闭不丢草稿）

依据（实测）：PaddleOCR 对 760×220 合成聊天图返回 6 个行框，行高 23–26px、相邻行空隙 3–5px、续行左缩进差 ≤2px。故「续行合并」不能只看间距（真实相邻消息间距同样只有 3–5px），必须叠加「次行无昵称前缀」判据 —— Dota 每条玩家消息都以 `昵称:` 或 `[All] 昵称:` 开头。

- [x] #22 M7a 行合并与聊天行解析（已完成，2026-10-22）：新增 `src/main/services/capture/chat-lines.ts` —— `mergeOcrLines()` 合并被换行切开的同一句（间隙 ≤0.5 行高 + 左缩进差 ≤24px + 次行无 `昵称:`/`[All]` 前缀 + 上行不以 。！？.!? 结尾 + 合并后 ≤180 字符）；`parseChatLine()` 拆出 `{channel, speaker, body}`。频道与昵称由代码原样回填，模型只收到正文，物理上无法翻译或丢弃玩家名。（实现：`mergeOcrLines` / `parseChatLine` / `formatChatPrefix`；capturer 先合并再只翻正文并回填前缀；9 项断言全过：续行合并、新消息不并、句末不并、大间隙不并、CJK 不加空格、频道昵称解析与回填往返）
- [x] #29 M7h 持久翻译会话层（pi-durable，已完成，2026-10-22）：新增 `src/main/services/session/durable-translator.ts` —— `@earendil-works/pi-durable` Harness 落盘 `userData/sessions/translator.sqlite`，方向 `auto-zh` / `zh-en` 各一条常驻会话（UUIDv7 作 sessionId，保留 provider 提示词缓存），本轮上下文明细即最近的聊天翻译历史；`translateLines()` 按编号块一次翻 ≤8 行并按编号回填，缺行/解析失败先 `reset()` 再整批回退直连，绝不静默回退原文；所有轮次经同一把串行锁（同一会话被捕获与回复共用，避免读到别的提交的答案），按 `settled.answer` 精确取条目而非"最新一条"；每 8 轮重置上下文，防止历史里的坏答案变成范例；zh-en 返回中文即判失败回退。`installProxyAwareFetch()` 让 pi-ai 走 Electron `net.fetch` 继承代理，并把 provider 域名加入代理直连白名单（境内端点经 HTTP/2 代理会被别人的答案流串味）。实测（--session-probe，mimo-v2.6-flash 官方 api-key 头）：首批 "推上/开雾/插眼" 三行全对，首字节 1.4–4.3s、整轮 1.9–4.9s，含工具编排开销约 +0.5s；连续跑 4 次候选条目数稳定在 6（轮次重置生效），不再膨胀。
- [x] #23 M7b 整块翻译与历史上下文（已完成，2026-10-22，随 #29 落地）：`translateLines()` 把一批消息拼成编号行（`1| 译文`）一次翻 ≤8 行，按编号回填而非按顺序猜；历史上下文由 #29 的常驻会话承担（每方向一条 conversation，最近若干轮天然在 transcript 里，比固定 6 条更全且带 provider 提示词缓存）；编号缺失或解析失败先 `reset()` 再整批回退逐行直连翻译，绝不丢行、不串行。
- [x] #24 M7c 滚动去重增强（已完成，2026-10-22）：`normalizeLine()` 归一化键扩到「去空白 + 去标点 + 去符号 + 小写」（`/[\s\p{P}\p{S}]+/gu`），OCR 标点/大小写噪声不再绕过判重；新增 `dropClippedLines()` 丢弃被区域上边缘裁半的行（行顶 < 0.6 中位行高 且 行高 < 0.75 中位行高）；新增 `isNearDuplicate()` 前后缀近似判重（两侧 ≥8 字符、长度差 ≤25%、一条是另一条的前缀或后缀，入窗但不再推送）；顺带修 `mergeOcrLines()` 的跨语种误合并（中文行与英文行不再并成一条）。11 项断言全过（裁行/保留正常行/归一化/后缀命中/前缀命中/异文不命中/短句忽略/长度差过大不命中/裁行后仍能合并续行/中英不合并/中文续行仍合并）；`--capture-selftest` 端到端：三条消息分行输出，中文行 null 直通。
- [x] #25 M7d 回复英译更短更口语 + 语气模板：`--reply-tone-probe` 四种语气全部通过（come help / come help pls / come help now / help me now，1.8–3.9s）：zh-en 提示词改为 ≤8 词 / ≤80 字符、优先 dota 缩写、无引号无句号；新增 `replyTone: terse | polite | hurry | firm` 四套语气；超长先二次压缩（maxTokens 48），仍超才按词截断。
- [x] #26 M7e 面板回复输入体验（`--reply-draft-probe` 全绿：草稿 reload 后仍在 / 倒计时出现 / 历史可点回填）：草稿写 localStorage（切页签/重启不丢）、历史条目点击回填并重译、语气下拉、复制后 8 秒倒计时提示「已复制 · 切回游戏 Ctrl+V」、同文 2 秒内重复复制不重复提示。
- [x] #27 M7f 浮层回复栏体验（`--reply-overlay-probe` 全绿：Esc 关闭再开草稿仍在 / 发送成功才清空）：Esc / 误点关闭保留草稿，下次 Alt+Shift+T 回填；成功提交才清空，失败保留原文并提示；沿用设置里的语气。
- [x] #28 M7g 探针与文档（`--chat-block-probe` / `--reply-tone-probe` / `--reply-draft-probe` 三支探针均 ok:true）：`--chat-block-probe`（合成图 5 行含续行/频道/中文/短句，断言合并、前缀保留、中文直通、请求次数）、`--reply-tone-probe`（4 语气互不相同且 ≤80 字符）、`--reply-draft-probe`（浮层草稿保留）；PLAN / README 同步。

### M8 游戏内直发（三通道）

- [x] #34 M8e 原地替换直发（默认）：`src/main/services/input/chat-inplace.ts` + `.ps1`——在游戏聊天框里打完中文按 `Alt+Shift+T`，程序 `Ctrl+A`+`Ctrl+C` 读草稿（哨兵值区分「没内容」与「复制无效」）→ `Ctrl+A`+`Delete` 清空防误发 → 后台翻译 → `Ctrl+A`+`Ctrl+V` 粘回英文 → 回车发送，全程不切窗口、不弹浮层、不经过控制台
- [x] #33 M8d 聊天框粘贴通道：`src/main/services/input/chat-send.ts` + `.ps1`——切前台 Dota 2 → Esc → `Set-Clipboard` 写英文 → `Enter` 开聊天框 → `Ctrl+V` 粘贴 → `Enter` 发送，整条约 0.5 秒；设置新增 `sendMode: 'chat' | 'console'`（默认 `chat`），面板「发送通道」下拉切换，控制台开关键仅在 `console` 通道显示
- [x] #30 M8a 回复框直发链路：`sendReply()`（中文草稿 → `translateReply` 语气化短句 → `buildSayTeamCommand` → 控制台下发）；浮层回复栏回车即发，发送成功才清空草稿，失败重开栏保留原文
- [x] #31 M8b 控制台直发：`src/main/services/input/console-send.ts` + `.ps1`（`Set-Clipboard` 命令文本 → 找 dota2 主窗口 `SetForegroundWindow` 置前（Alt 轻敲解除前台锁，失败重试一次）→ 开关键 → `^v` → `{ENTER}` → 关关键），命令文本经临时文件传递，任何中文都不经 SendKeys
- [x] #32 M8c 接线与体验：热键 `Alt+Shift+T` = 弹出浮层输入框（不再读游戏输入行），面板新增「游戏内直发（控制台 say_team）」卡（草稿输入 + 控制台开关键 + 命令回显）
- 验证据：`--input-probe` ok:true（`draft=中路插个眼，小心他们开雾`、`translated=warding mid, watch smoke`、`command=say_team "warding mid, watch smoke"`、引号清理用例通过）；typecheck node+web clean、eslint 0 error、build ok
- 已验证：Panorama 聊天框接受注入的 `Ctrl+A`/`Ctrl+C`/`Ctrl+V`——哨兵 `PROBE_SENTINEL_123` 被替换成聊天框里的 `你好`（`CLIP_LEN=2`），再粘贴 `warding mid watch smoke` 后 `Ctrl+A`+`Ctrl+C` 读回同一串，证明读取与替换都成立（.tmp/grab2.ps1、.tmp/grab3.ps1，真实对局窗口）
- 真对局已验收（用户 2026-11 确认「已经可以用」）：默认通道 `inplace`（原地替换游戏聊天框）在真实对局里跑通全链路；`chat` / `console` 两个备用通道仅做过窗口外验证，未逐条回归

### M9 自动捕获转正（验收：一局完整对局里自动模式既不漏消息，也不空转烧 CPU）

先纠正一个流传下来的误读：代码里的默认值一直是 `auto`（`DEFAULT_SETTINGS.captureMode`，自 `b69b475` 起），被记成 `manual` 的是**本机 `settings.json` 里持久化的那个值**——起因只是 2026-10-23 一句「自动轮询在实机不稳定」，没有根因、没有数据。「默认值」和「上次选的」是两件事：默认只在没有 `settings.json` 时生效，选过之后一律以持久值为准。M9 先把「不稳定」变成可读的数字，再修。

- [x] #35 M9a 逐拍遥测（已完成，2026-11）：新增 `src/main/services/capture/telemetry.ts` + 探针 `--capture-telemetry-probe [秒数]`。自动模式每一拍往 `logs/capture-ticks.jsonl` 写一行（`at/mode/act/grabMs/src/chg/need/ocrMs/lines/msgs/fresh/dup/own/streak/err`），单文件上限 1 MB、超限清空重写，所以磁盘占用恒定（回应用户「日志太多伤磁盘」的顾虑）；`act` 把每一拍归类成 `ocr | same | gap | idle | error | busy`，`src` 记下这一帧是常驻流还是 `desktopCapturer` 兜底。桌面实测：40 拍里 cadence p50 = 809 ms（目标 800）、抓屏 p50 72 ms、`busy` 0 次、静止画面 34 拍全被指纹判掉，唯一短板是 OCR 单次中位 2.2 s。
- [x] #36 M9b 真对局定位（已完成，2026-11）：用户真实对局采到 383 拍 / 15.6 分钟（面板「自动捕获」）。`src=stream` 383/383（常驻流没掉）、`cadence p50 801`、抓屏 p50 185 ms、OCR p50 216 ms、新消息 29 条、`dup` 0、`own` 0、`brk` 从未触发、`err` 0 —— 「自动轮询在实机不稳定」这句话到此为止是**没有据实**的：真正坏的是 `busy`（75 次，两条定时器链），已单独记账进 #37。顺带纠正了桌面上那个「OCR 中位 2.2 s」的悲观结论：对局里 OCR 只要 216 ms，慢的是捕获区里的字有多少。数字进 `docs/BENCH.md`「真对局」节，根因写进 `docs/NOTES.md`。
- [ ] #1 M9b' 真对局（试用英雄场景已采 45 拍 / 72 s，见 BENCH）：`src=stream` 45/45，常驻流在游戏前台没掉；抓屏 p50 202 ms（桌面 72 ms）成新瓶颈；`same` 0 次 —— 指纹在半透明 HUD 上失效，实际节流全靠 `ocrGap` 退避。剩下要真对局才能答的：一屏滚动时会不会漏行、`brk` 会不会误判清屏、`fresh` 长期为 0 的时段占比。
- [ ] #2 M9c 按数据修（第一轮已做，2026-11）：真对局数据先暴露的是 `busy` —— `tick()` 的 `busy` 分支和 `finally` 各排程一次，每撞一次 busy 就多出一条定时器链，两条链交错跑（同毫秒成对落日志），383 拍里 75 拍是 busy。已修：`scheduleNext()` 开头 `clearTimeout` 兜底 + 删掉重复排程，重启复测 busy 30/60 → 0、cadence p50 0 → 801。**仍待数据**的候选：间隔跟着 OCR 实测耗时长走（而不是固定 800）、`sources` 兜底时排空一拍的退避、把「行已滚出可见区」与「行被裁半」分开处理。
- [x] #38 M9d 显示语义定稿（已完成，2026-11）：手动是「此刻屏幕的快照」，覆盖式重建；自动是「这一局的累积」，追加式，两者共用 `CAPTURE_REPLACE` / `CAPTURE_ENTRIES` 两条通道。累积上限浮层 40 行、面板 50 条，满了挤掉最早的。自动的终止条件由 `src/main/services/capture/session.ts` 判：屏幕 ≥3 行全是没见过的、且历史 ≥10 条、连续 3 拍如此，才认定换局，然后清空去重窗口 + 广播空 `CAPTURE_REPLACE` 清屏，同一拍的整屏内容随即作为新行重新上屏。OCR 期间滚过去的行不补（迟到消息插进中间比少一句更糟）。探针 `--session-break-probe`。

### M10 对局状态源（GSI，验收：进对局自动开始、打完自动停）

捕获循环只能看到屏幕，回答不了「现在到底在不在对局里」——聊天区没人说话和不在游戏里，在 OCR 眼里是同一张图。Valve 官方的 Game State Integration 把 `map.game_state` 直接推到本地 HTTP 端口，正好补上这个缺口；顺带能拿到 `player.name`（自己说的话不该被翻译）。注意正文默认拿不到——但 cfg 的 `data` 段加 `"events" "1"` 之后 Dota 会把对局内聊天推进 `payload.events[]`（`event_type: "chat_message"`，带 `player_id` / `channel_type` / `message`），见候选「用 GSI events 读聊天正文」；我们当前只开 provider/map/player，所以正文仍靠屏幕 OCR。

- [x] #40 M10a 监听 + cfg 自愈（已完成，2026-11）：`src/main/services/gsi.ts` 在 `127.0.0.1:32123` 起监听，`src/main/services/gsi-config.ts` 按注册表 `HKCU\Software\Valve\Steam` → `libraryfolders.vdf` 找出所有 Steam 库，把 `steamapps/common/dota 2 beta/game/dota/cfg/gamestate_integration/gamestate_integration_ohmydota2.cfg` 写好（内容有变化才重写；罗技那份 `gamestate_integration_logitech.cfg` 走 3002，各工具一份互不冲突）。判定只认翻转：`PRE_GAME`/`GAME_IN_PROGRESS` 开一次、`POST_GAME`/`DISCONNECT` 停一次，90 s 没推送且有 `startedByGsi` 标记才停（游戏关了不让捕获空转）；用户中途手动停掉捕获不会被后续心跳又拉起来，`autoStartCapture` 关掉时 GSI 也不替他开。面板「捕获循环」卡显示当前 `game_state` 或「监听 :32123 · 等 Dota 推送」。GSI 只按**当前配置的模式**启动捕获：自动模式下才是真的开始翻译，手动模式下只是保持就绪（不替用户改模式）。探针 `--gsi-probe`（9 个纯判定用例 + 真实 HTTP 推一串 payload）。
- [ ] #3 M10b 实测：重启一次 Dota 让 cfg 生效，进一局确认推送到达、自动开/停各发生一次（面板上 `GSI` 从「等 Dota 推送」变成 `PRE_GAME` → `GAME_IN_PROGRESS` → `POST_GAME`）。
- [x] #42 M10c 闸门升级（已完成，2026-11）：捕获循环两处都从「有没有开」改成问「该不该开」。抓屏前加前台闸门 `gameFocused()`——走常驻输入桥新增的 `focus` op（`Get-Process dota2` + `GetForegroundWindow` 比对），不在前台只记一条 `act:"idle"`，抓屏和 OCR 全省；结果缓存 900 ms，查询失败放行并冷却 30 s（闸门坏了不能反过来把捕获关死）。停捕获去掉 `startedByGsi` 前置条件，改由 `shouldStopCaptureOnMatchEnd(mode)` 决定：自动模式随对局结束停（下一局 GSI 再拉起），手动模式不动（那个开关是用户的）。看门狗走同一规则。新增探针 `--gsi-dump [秒数]`：把 Dota 真实推来的每个字段路径（类型/次数/示例值）摊开写 `logs/gsi-frames.json`，扩 `data` 段之前先看真实密度。
- [x] #43 M10e 正文来源可选（已完成，2026-11）：`chatSource: 'ocr' | 'gsi'` 两条并列的自动路线，面板上是一个「正文：屏幕识别（OCR）／正文：游戏推送（GSI）」选择器。GSI 路在 `start()` 里就不建抓屏流、不排定时器，也不需要聊天区域；正文由 `gsi.ts` 去重后经 `pushChat` → `pushMessages()` 直接进渲染层与翻译队列，自己的消息照常显示。`--gsi-probe` 增加 `pushChat` 断言（仍 9/9），`--settings-persist-probe` 扩到 15 项全绿。

## M11 翻译账本的可读化
验收标准：面板或探针能回答「最常出现的句子 top N、来源分布、平均长度、命中/写入比」，数据来自 `translate-cache.sqlite` 的 `pair` 表，无需改动写入侧。

- [x] #4 M11a 词频统计读取端：`translationInsights(limit)` 把预埋字段算成「对数 / 命中次数 / 命中比 / 来源分布 / 平均长度 / top 句」；面板状态行显示「词库 N 对 · 命中 M 次 · X%」，`--translate-cache-probe` 末尾另打一行 `TRANSLATE_CACHE_STATS` 与 top 列表（探针 21 项）。数字要真实流量攒几天再解释。
### M12 浮层与朗读的可用化（v1 收尾，2026-11）

验收标准：不看文档也能用起来——锁不锁一眼看得出、拖不动时有热键、念出来的句子像人说的、取不到字时浮层自己说出原因。

- [x] #9 M12a 几何归用户：解锁后拖顶栏移动、拖两侧把手改宽、方向键 1px / `Shift+方向键` 10px 微调、松手离屏幕边 <24px 自动贴边；「还原」回到跟随捕获区域的默认摆放。边界在 `OverlayManager.applyGeometry` 用 `clampGeometry` 收口，拖出屏幕至少留 80px 能抓回来。
- [x] #10 M12b 锁定语义收敛成一条：`shouldIgnoreMouse(locked, replyOpen)`——只有「锁定且不在回复」才穿透，收起成小图标也不例外。这条规则被改错过两次（解锁拖不动、收起后误吃点击），所以 `--overlay-geometry-probe` 单独立断言钉住。
- [x] #11 M12c 收起 / 展开：`Alt+Shift+B` 或条上「收起」缩成 132×34 小图标（绕开 240×120 下限的 `miniGeometry`），再按一次回原位置；锁定 + 收起时图标穿透点不到，只能靠热键展开——这正是「防误点」要的效果。
- [x] #12 M12d 朗读换引擎并稳住：微软 Edge 神经语音（晓晓），2 条长连接池 + 启动预热，`--tts-bench` 10 句 **10/10 成功、p50 1186 ms、max 2016 ms**（改造前同一台机器 6 句里 4 句 429、冷握手 1–21 s）。合成失败就这一句不念，**绝不换回系统嗓子**——两个嗓子轮流上岗就是「一下这个声音一下那个声音」的根因。
- [x] #13 M12e 念出来的是人话：只念正文（剥掉 `[英雄] [队友]` 与频道符号），格式 `英雄说，内容`；中文原话直接照念不翻译。
- [x] #14 M12f 行内信息：英雄头像（127 张打包进仓库，Steam CDN 国内不可靠）、词库命中的译文标淡黄「词」、翻译失败标红报错——「未翻译」不再同时表示「还没翻」和「翻不成」。
- [x] #15 M12g 安静的状态行：正常捕获时 pill 整块隐藏；只有 `捕获出错 → 没选区域 → 捕获暂停 → 等待进入对局` 四种情况出现一行淡橙字（纯函数 `captureHint` 判定，错误优先级最高）。
- [x] #16 M12h 少动手：解锁后 5 秒无操作自动锁回穿透（`armIdle`，渲染层 1 秒节流 `keepAlive` 推后它）；新行 400ms 淡黄闪；超过 12 行的旧行降到 55% 不透明度；浮层上所有 `title` 删除（鼠标划过弹提示在游戏里碍事）。

## 候选方案（未排期）

### 监听控制台输出代替屏幕 OCR ❌ 已验证不可行（2026-11）

用户 2026-11 记录：游戏控制台里出现这样的行——

```
[Server] PR:NotePlayerCommsTime 0:[U:1:325140247] communicated at 1802.833374
```

即玩家用语音/快捷沟通时，服务端会往控制台打一条记录（Steam 账号 + 游戏内秒数）。想法：用控制台日志当作**触发信号或数据源**，替代（或补强）屏幕 OCR。

- 能拿到：谁在什么时候沟通了（SteamID、游戏时钟），节奏精确、零 OCR 成本、不受分辨率/语言包影响。
- 拿不到：沟通内容本身（这条记录里没有文字，语音更没有）。所以它不能直接替代 OCR 取文本，但很适合做「有新消息了，立刻拍一帧」的事件触发，把当前 800ms 轮询 + 指纹判定换成事件驱动。
- 落地方式（待验证）：Dota 2 启动项加 `-console`，控制台 `con_logfile console.log` 把输出落到 `.../dota 2 beta/game/dota/console.log`；主进程 tail 这个文件（chokidar 或定时 stat + 增量读），匹配 `PR:NotePlayerCommsTime` / `say` 等行为触发一次捕获。风险：日志路径随安装位置变化、中文/编码未知、控制台输出量可能很大需限速。
- 资料补充（二手来源，未实测）：GSI 拿不到聊天内容——Valve 防止外挂用聊天做脚本/报点，没在 Game State Integration 里开放聊天数据；替代路线是读本地控制台日志，需启动项 `-log -condebug` 才落盘 `game/dota/console.log`，据称聊天气泡会格式化成 `[Chat] [All|Team] 昵称: 内容`（旧版本可能是 `[ALL]` / `[TEAM]`），轮盘消息可能带 `chatwheel_say` 之类的标识。若日志里真有文本，捕获管线可以从「800ms OCR 轮询」换成「日志事件触发 → 只在该时刻拍一帧」，OCR 成本与延迟都能再降一档；若日志里只有 `PR:NotePlayerCommsTime` 这类无正文的行，就只能当触发信号。
- 原文与判断已存 wiki：`concepts/dota-2-聊天内容获取gsi-缺口与控制台日志流`（源包 SRC-2026-10-22-001）。
- **结论（2026-11 实测，已关闭）**：`-condebug` 本来就开着，`D:\SteamLibrary\steamapps\common\dota 2 beta\game\dota\` 下有 10 个 `console.<matchid>.log`（两场真对局各约 25MB）。逐文件统计：`[Chat]` = 0、`[All]` = 0、`[Team]` = 0、`say_team` = 0、`PR:NotePlayerCommsTime` = 0。聊天在日志里只留下 `[GCClient] Send msg 7273 (k_EMsgGCChatMessage), 40 bytes` —— 有事件、有字节数、**没有正文**，且只有 `Send` 没有 `Recv`（队友的消息连触发行都不产生）。`chatwheel` 只有 `CLocalize::FindSafe failed to localize: '#dota_chatwheel_message_*'` 这类本地化失败行。故二手资料里「聊天气泡会格式化成 `[Chat] 昵称: 内容`」在本 build 上不成立：日志既当不了数据源，也当不了可靠的触发信号 → 捕获路线继续走屏幕 OCR。
- **后续（2026-11）**：当初想用日志补的其实只有「知道什么时候该拍一帧 / 在不在对局里」这一半，而这一半 GSI 已经给了（见 M10）。所以这条候选彻底关闭，不再考虑日志。

### 用 GSI events 读聊天正文（已验证可行，已实现为并列的正文来源，2026-11）

之前判定「GSI 没有聊天正文」，那是在我们只开了 `provider`/`map`/`player` 的 cfg 下得出的——结论错了，得纠正。dotabod（开源的 Dota 直播工具）在 GSI 的 `events` 数组里处理 `event_type: "chat_message"`，字段是 `{ player_id, channel_type, message }`，并且用 DeepL 把队友/对手的发言实时翻译上屏；它走的就是玩家自己的客户端，不是观战。

- 证据（都在 dotabod 仓库里）：`packages/dota/src/dota/events/gsi-events/event.chat_message.ts` 直接读 `event.message` / `event.player_id`，用 `isPlayingMatch(gsi)` 守卫，说明只在正常对局生效；`packages/dota/src/types.ts` 有 `Packet.events?: DotaEvent[]` 与 `ChatMessageEvent { event_type, player_id, channel_type, message }`；SteamTracking 的 `DOTAChatChannelType_t` 给出 `GameAll = 11`、`GameAllies = 12`（另有观战 13 / 教练 14）。
- 前提：cfg 的 `data` 段要加 `"events" "1"`，并重启 Dota 让 cfg 生效。
- 能拿到：正文文本、说话人 slot、频道（所有人 / 队伍）。拿不到：拼音与语音、被屏蔽玩家的消息。
- 价值：正文不再靠 OCR，就没有误读，不用管分辨率/字体/缩放，也不占 CPU 和 GPU；`player_id` 比「拿昵称去比对」更准。OCR 退化成兜底（cfg 没写成功、Dota 没重启、或玩家自己关了 GSI）。
- **实测结论（2026-11，真对局）**：`events` 确实带 `chat_message`，中文原样、自己发的也推（`own:true`），标点保留（「什么？」的全角问号在）。但同一条会被连续推 **26–27 帧**，必须按「时间+说话人+频道+槽位+正文」去重，否则重复翻译 + 重复写盘。脏字由 Dota 在推送前就遮蔽（有一句到达是 `你是****`），OCR 看屏幕也是同样的星号，两边口径一致。
- **两条路的量化对比（同一 20 秒窗口，玩家连发 7 句）**：GSI 7 条唯一、逐字准确、推送即到（相邻 2.3–4.7 s）；OCR 19 拍吃了 19 条 `fresh`（7 句被读成 19 条，约 2.7 倍膨胀，`dup` 只拦下 2 条），`ocrMs` 171–536 ms、落后 1–3 s。
- **落地形态**：两者做成**并列的两条自动路线**，由设置项 `chatSource: 'ocr' | 'gsi'` 选择（面板「正文：屏幕识别（OCR）／正文：游戏推送（GSI）」）。选 GSI 时捕获服务不抓屏、不跑 OCR、也不要求聊天区域，正文由 `pushMessages()` 直接进渲染层与翻译队列；自己发的消息照常显示与翻译（用户要求：只看一个地方就够）。手动模式下 GSI 不上屏，保持「拍一张照」的语义。
- 仍然未知：敌人频道（`channel:11`）还没在真实对局里出现过；`player_id` 到昵称的映射要不要开 `allplayers` 也没做。

## 变更记录

- 2026-11：抓屏 OCR 整条链路移除（用户决定：GSI 已实测可用，不再需要第二只手）。删掉 PaddleOCR + onnxruntime-node + Windows OCR 桥、区域选择/高亮两个窗口、逐拍抓屏遥测、手动拍照模式与 11 个 OCR 探针；正文唯一来源是 GSI 的 events 块。安装包从 198 MB 降到约 30 MB。代价明说：GSI 不可用时没有兜底，cfg 没写进去或 Dota 没重启就一条字都收不到。剩下的纯逻辑判据（前缀拆分、翻不翻、同形、英雄名）挪进 --chat-block-probe。
- **2026-11 · v1 收尾**：M1–M12 全部达成，功能面冻结在 v1。本轮把「浮层」从一块能显示字的透明窗做成可操作的对象：几何归用户（拖 / 拉宽 / 方向键微调 / 贴边吸附 / 还原）、锁定语义收敛成一条纯函数、收起成小图标、朗读换 Edge 神经语音并加连接池与预热（10/10、p50 1186 ms）、行内补头像与「词」标、状态行只在四种异常时出现。数字与实测在 `docs/BENCH.md`，踩坑在 `docs/NOTES.md`，人工验收在 `docs/ACCEPTANCE.md`。探针：`--overlay-geometry-probe` 23 项、`--settings-persist-probe` 20 项、`--translate-cache-probe` 22 项、`--tts-bench` 10/10，全绿。
- 2026-11：发版与自动更新（v1.0.0）。electron-builder 出 NSIS 安装包 + 免安装 zip，`publish` 指向 GitHub，打包时顺手写出 `latest.yml` 与 `resources/app-update.yml`；三条流水线：`ci.yml`（每次 push/PR 跑 typecheck/lint/build）、`nightly.yml`（push main 自动打包成 `Nightly <UTC 时间戳>` 预发布，只留最新一个，旧的全删）、`release.yml`（推 `v*` 标签即出正式版）。应用内更新走 `electron-updater` 只跟正式通道（`allowPrerelease = false`），开机静默查一次、下完不自动重启——面板把按钮变成「重启并更新」，正在打局时绝不自己关窗口。
- 2026-11：面板外观重做。原生标题栏与菜单栏是「难看」的主因，换成 `titleBarStyle: hidden` + `titleBarOverlay`（保留系统三颗按钮，省得自绘去对齐 Win10/11），标题栏整条 `-webkit-app-region: drag`、右侧留 128 px 给系统按钮；`show:false` + `ready-to-show` 消除深色界面首帧白闪；内容改 `max-w-6xl` 居中、滚动条与卡片描边压暗一档。版本号与「检查更新」进标题栏。
- 2026-11：队伍情报（GSI 路线图第二步）。`team-intel.ts` 把 `allplayers` 整理成名单：`buildRoster(players, mySlot, myTeam)` 按归一槽位合并去重（`allplayers` 的 key 是 `"0"–"9"`，而 `player.player_slot` 里夜魇带 128 偏移，`normalizeSlot()` 折成 `5–9` 而不是 `0–4`，否则会和天辉撞号），我方在前、同侧按槽位升序，英雄名削掉 `npc_dota_hero_` 前缀；`rosterLine()` 给面板一句话（`我方 5 · 敌方 5 · 英雄 8/10`）。`gsiStatus()` 新增 `roster` / `rosterText`；局末在清 `slotNames` 的同时清掉 `slotHeroes` / `slotTeams` 与自己那份槽位/阵营——上一局残留就是错情报。面板状态行多一个「阵容」数字，悬停看逐人。`--gsi-probe` 增 `rosterOk`（三人名单、我方在前、英雄短名、局末清空），探针输出带 `roster` / `rosterText` 便于现场判读。
- 2026-11：GSI 帧小结（承接「GSI 还能做什么」的第一步）。`--gsi-dump` 要独占 32123，而真对局时应用必须开着，两者互斥——所以把记账搬进应用：`gsi-frames-summary.ts` 在内存里按块/事件归类（`gsi-dump-analysis.ts` 放纯逻辑），每 5 秒原子落盘 `logs/gsi-summary.json`，`map.matchid` 变了就清账，`POST_GAME` 立刻终落。一次回答三个问题：真对局还是训练场、`allplayers` 给不给、有哪些 `event_type`。判读靠只读探针 `--gsi-dump-report [文件]`（dev 应用开着也能跑，两个 userData 目录取最新）。已用合成帧端到端验证：应用写出 `frames 1 / realMatch true / roshan_killed×1`，探针读出同一结论，测试文件已删。
- 2026-11：浮层几何归用户（用户要求「锁定 + 拖动 + 左右改宽 + 还原」）。新增 `overlayLocked`（默认开 = 几何冻住 + 强制点击穿透）与 `overlayBounds`（DIP，`null` = 跟随捕获区域）；穿透判定收敛为 `locked || clickThrough`，回复条打开时例外。解锁后浮层顶栏可拖、两侧把手可改宽，增量在渲染进程算、边界在 `OverlayManager.applyGeometry` 用 `clampGeometry` 收口（渲染进程拿不到显示器工作区）。左把手右边缘钉死、右把手 x 不动；拖出屏幕至少留 80 px 可抓回；贴边时宽度下限优先。面板补「锁定 / 还原位置大小」与当前几何读数——锁定时浮层本身穿透，只能从面板解锁。`--overlay-geometry-probe` 9 项全绿，`--settings-persist-probe` 扩到 18 项。
- 2026-11：输入侧三道过滤 + GSI 局末清屏（承接 #5/#6 发散）。`worthTranslating(body)` 判「没有可翻的文字」——既无字母也无汉字（纯符号/纯数字/纯 emoji）或只剩一个码点就不进模型队列，与 `hasHan`（判「已是目标语言」）分工；OCR 的 `buildEntries` 与 GSI 的 `pushMessages` 用同一把尺子。`sameText(a, b)` 归一化后相同（`gg` vs `GG`、`??? go` vs `???  go!`）视为「模型没动」：不写账本、不当译文。GSI 拿到 `POST_GAME` 时调 `endMatchSession()` 清去重窗口并广播空 `CAPTURE_REPLACE`——局末是明确信号，不必像 OCR 那样靠「整屏换掉」猜。`--chat-block-probe` 增 `uselessCases`/`sameTextOk`，`--translate-cache-probe` 22 项全绿。
- 2026-11：翻译记账本换成双向 sqlite（`%APPDATA%/<app>/translate-cache.sqlite`）。用户的场景是：自己打「你好」译成 hello，之后队友说 hello 就该直接出中文、不再调模型；反方向同理。所以一次翻译存**一对**（`a` 键 + `a_raw` 原文 + `b` 译文），正向按 `(provider, tone, a)` 命中，反查走 `b` 索引并交回 `a_raw`；答案必须落在目标语言（判据看源侧 `a_han`），语气只进正向键。选 sqlite 而不是 JSON 是因为双向查询要两个索引、JSON 每写一句都要整表重写。原样返回与空串不入账；上限 20k 对按最近命中淘汰。探针 `--translate-cache-probe` 11 项全绿。
- 2026-11：记账本预先写入词频统计要用的字段（用户要求「提前预记录一下」）：`direction`、`origin`/`last_origin`、`a_len`/`b_len`、`a_words`/`b_words`，配合 `hits` 与时间戳，够回答「哪句最常出现、哪个入口带来的、多长」。现在没人读——历史数据只能当场写下来，事后补不回来。读出接口 `translationCacheRows(limit)`；探针扩到 15 项。
- 2026-11：M11a 落地（#4 勾掉）。读出端只回答「有没有白拿」，不解释业务：探针里那 21 项和面板那行数字都只证明口径通，不代表语料质量；面板每 5 秒刷一次，跟着捕获一起动。
- 2026-11：接 plan-kanban（`/plan-kanban`）。PLAN.md 仍是唯一真相源，未完成条目挂 todo 任务号：M9 一条链（#1 真对局补测 → #2 按数据调参），M10 的 #3 与新增 M11 的 #4 各自独立。`todo` 建任务时用了 `blockedBy` 数字 ID；看板服务 `node %USERPROFILE%\.pi\agent\npm\node_modules\pi-kanban\server.js`（:3460）。

- 2026-11：正文来源改成两条并列的自动路线（M10e）。起因是同一 20 秒窗口的实测对比：GSI 7 条唯一、逐字准确、推送即到；OCR 把 7 句读成 19 条（约 2.7 倍膨胀），还要 171–536 ms 的 OCR 时间。于是 `chatSource: 'ocr' | 'gsi'` 上到设置里，GSI 路完全不碰屏幕（不建抓屏流、不排定时器、不要求聊天区域），正文由 `pushMessages()` 直接进渲染层和翻译队列；自己的消息也显示（用户要求：只看一个地方就够）。顺手给 GSI 的聊天事件加了去重——Dota 会把同一条推 26–27 帧，否则重复翻译还重复写盘。手动模式语义不变。

- 2026-11：纠正一条错结论——GSI 其实能拿聊天正文，只要 cfg 的 `data` 加了 `"events" "1"`。之前「GSI 不含聊天」的判断是在只开 `provider`/`map`/`player` 的配置下得出的。依据是 dotabod 的 `event.chat_message.ts`（读 `event.message`、`player_id`，`isPlayingMatch` 守卫）与它的 `Packet.events?: DotaEvent[]` 类型。已写入候选方案，待一局真实对局用 `--gsi-dump` 验证；那条日志路线（`-condebug`）的结论不受影响，日志里确实没有正文。
- 2026-11：捕获闸门升级（M10c）。自动捕获以前「开着就一直跑」，现在两处都问「该不该开」。抓屏前走前台闸门 `gameFocused()`：常驻输入桥加 `focus` op（`Get-Process dota2` + `GetForegroundWindow` 比对），Dota 不占前台就只记 `act:"idle"`，抓屏与 OCR 全省；结果缓存 900 ms，查询失败放行并冷却 30 s（闸门坏了不能反过来把捕获关死）。停捕获去掉 `startedByGsi` 前置条件，改由 `shouldStopCaptureOnMatchEnd(mode)` 决定：自动模式随对局结束停、下一局 GSI 再拉起；手动模式不动，那个开关是用户的。看门狗走同一规则。新增探针 `--gsi-dump [秒数]`：把 Dota 真实推来的字段路径（类型/次数/示例值）摊开写 `logs/gsi-frames.json`，扩 `data` 段之前先用它看真实推送密度。`--gsi-probe` 增加模式规则断言，仍全绿。

- 2026-11：修掉「正文源选 GSI、面板却在手动模式 → 推送被静默吞掉」。`gsi.ts` 的 `pushChat` 里原本还有一道 `capture.status().mode !== 'auto'` 的闸，它保护的是「手动模式=拍一张照」的语义，但 GSI 正文没有快照这回事，结果用户一手动切正文源，聊天就全被 `return` 掉且不留日志。改成只看 `chatSource`。判定方式是往 `127.0.0.1:32123` 推一帧合成 payload 再看记账本有没有多一行——比读代码快，也顺带验证了「GSI 帧 → 翻译 → 记账本」这条链在本机是通的。
- 2026-11：把「一局成绩单」做成探针（`--match-report`）：只读两份日志，输出 GSI 独立句数与重复帧分布、逐拍动作分布、抓屏与 OCR 分位、节奏空档、fresh 占比、`brk`/`rst`，并把 GSI 收到的句子与记账本对账（差集就是没进翻译的正文）。第一次跑的是机器人试炼场的数据：138 句 / 291 帧、重复中位 1 最长 27、`busy` 172 拍、idle 占 50%，探针自己打出「53 句来自机器人，不能当对局数据」「正文源是 GSI，账本漏行率不适用」这类判据——**它的第一个作用是证明这批数据不合格**，免得拿试炼场数字去调参。同轮给 `--gsi-probe` 补了第二局：PRE_GAME(7771) → IN_PROGRESS → POST_GAME → PRE_GAME(7772) 必须再拉起一次（autoStarts 2 / autoStops 2），把「局末停只是这一局结束」写成断言。
- 2026-11：接入对局状态源（M10a）。`src/main/services/gsi.ts` 起 `127.0.0.1:32123` 的 GSI 监听，`gsi-config.ts` 顺着注册表 + `libraryfolders.vdf` 找到 Dota 目录并写好 `gamestate_integration_ohmydota2.cfg`（已在本机 `D:\SteamLibrary\steamapps\common\dota 2 beta\game\dota\cfg\gamestate_integration\` 落地，和罗技那份 3002 并存）。于是「进对局自动开、打完自动停」有了可靠判据，`player.name` 也会自动补进 `myNicknames`。`--gsi-probe` 全绿（9 个纯判定用例 + 真实 HTTP 链路；一局只 start 一次、只 stop 一次、昵称只记一条、坏包不打挂服务）。（当时以为 GSI 不含聊天正文——cfg 没开 `events`——正文仍走屏幕 OCR；该判断后来已纠正。）**待实测**：重启 Dota 后打一局确认推送到达（#41）。

- 2026-11：显示语义定稿（M9d）。手动＝此刻屏幕的快照（覆盖式重建），自动＝这一局的累积（追加式），两者共用 `CAPTURE_REPLACE` / `CAPTURE_ENTRIES`。自动的终止条件由 `session.ts` 判：屏幕 ≥3 行全没见过的 + 历史 ≥10 条 + 连续 3 拍，认定换局后清空去重窗口并广播空 `CAPTURE_REPLACE` 清屏，同一拍的整屏内容紧接着作为新行重新上屏（先清后追加，避免清完这一屏反而没推上去）。上限浮层 40 行 / 面板 50 条；OCR 期间滚过去的行不补。新增探针 `--session-break-probe`（8 个单拍用例 + 连续触发 + 中途打断归零）。
- 2026-11：自动捕获开始可观测（M9a）。自动模式每一拍写一行遥测到 `logs/capture-ticks.jsonl`（≤1 MB，超限清空重写），新增探针 `--capture-telemetry-probe [秒数]`。桌面实测 cadence p50 809 ms（目标 800）、抓屏 72 ms、`busy` 0、静止画面 34/40 拍被指纹判掉，短板是 OCR 单次中位 2.2 s（315 ms–3680 ms），即自动模式的真实上限是「每 1.5-2.5 s 读一屏」。顺带否掉两个想当然的优化：把 PNG 落盘换成 raw buffer 交给库（1129 → 1184 ms，没差别）、把图缩到 1072 宽（省 18% 但 `gg wp` 丢空格、`[LISA.]:` 粘字，不划算）。数字进 `docs/BENCH.md`。
- 2026-11：真对局验收自动捕获（M9b）并修掉 `busy`（M9c 第一轮）。真实对局 383 拍 / 15.6 分钟：`src=stream` 383/383、cadence p50 801 ms、抓屏 p50 185 ms、OCR p50 216 ms、新消息 29 条、`dup`/`own`/`err`/`rst` 全 0、`brk` 未触发 —— 原先「自动轮询在实机不稳定」不成立，实际坏的是 `busy` 75 次：`tick()` 的 `busy` 分支与 `finally` 各排程一次，每撞一次就多一条定时器链（日志里同毫秒成对出现，cadence p50 因此算成 0）。修法：`scheduleNext()` 先 `clearTimeout(this.timer)` 兜底 + 删掉重复排程。重启复测 busy 30/60 → 0、cadence p50 0 → 801、p90 802。同时纠正桌面那条「OCR 中位 2.2 s 是自动模式天花板」的结论：对局里 OCR 只要 216 ms，瓶颈取决于捕获区里有多少字。数字进 `docs/BENCH.md`「真对局」节。
- 2026-11：把「上次选的要记住」钉成冒烟用例。核对后发现这条链路本来就是通的（`settings.ts` 的 `loadSettings` 以持久值覆盖默认、`capturer.start()` 读 `loadSettings().captureMode`、面板 `applyMode` 写盘后重启捕获），所以没有改行为，只新增探针 `--settings-persist-probe` 守住契约：7 个面板字段逐项写哨兵值再读回（`captureMode`/`captureIntervalMs`/`autoStartCapture`/`sendMode`/`replyTone`/`ocrEngine`/`consoleKey`）、连续写入互不覆盖、无 `settings.json` 时回落默认、残缺文件按字段回落、未知键被忽略、跑完全量还原（备份在临时目录，不污染真实配置），14 项全绿。顺带修正本文件 M9 开头那句「`captureMode` 默认是 `manual`」——默认值自 `b69b475` 起一直是 `auto`，被当成 `manual` 的是本机持久化的值。

- 2026-11：① M8 真对局验收通过（用户确认「已经可以用」），默认 `inplace` 通道视为达标，`chat`/`console` 备用通道留作未回归；② 关闭候选方案「监听控制台输出代替屏幕 OCR」——实测 `-condebug` 已开、10 个 `console.<matchid>.log` 里 `[Chat]`/`[All]`/`[Team]`/`say_team`/`NotePlayerCommsTime` 全为 0，聊天只留 `[GCClient] Send msg 7273 (k_EMsgGCChatMessage), N bytes`（无正文、无 Recv），日志当不了数据源也当不了可靠触发器；证据同步进 `docs/NOTES.md` 与 wiki。

- 2026-10-23：知识点入库。新增仓库根 `AGENTS.md`（英文，新会话自动读取：常用命令、探针清单、环境约束、状态位置、硬规则）与 `docs/NOTES.md`（中文工程笔记：症状→根因→修法，覆盖构建 / 抓屏 / OCR / 翻译会话 / 直发 / 语音 / 调试方法）；分工是 PLAN 记计划与验收、NOTES 记踩坑细节、BENCH 记量化基线、ACCEPTANCE 记人工验收步骤。

- 2026-10-23：直发按键提速。chat-inplace.ps1 组合键从 30/70-150 ms 收紧到 20/25 ms（一次组合 85 ms）：读聊天框 keys 453 → 约 270 ms，写回 keys 562 → 约 330 ms；首轮组合键被丢自动慢速重试一次并在 inplace.log 标 retried；顺带修掉旧子进程 close 事件误清新进程引用的重启竞态；ps1 注释改回纯 ASCII（GBK 解码会吞掉行尾，导致语法错误「意外的标记 }」）。

- 2026-11: 直发链路提速到 2 秒级——① 输入桥改常驻：`chat-inplace.ps1` 变成 stdin/stdout 行 JSON 服务（`{"op":"grab"|"send"|"ping"}`），启动时预热一次 693ms，之后往返只要 1-2ms（改前每次 spawn + Add-Type 编译 600-680ms，一次直发要付两次）；等待时间从 grab 930ms/send 740ms 压到约 450/490ms，并把「清空输入框」挪到返回之后（反正下一次请求要等翻译完才来），空闲不再整段阻塞。② 回复路径补对冲：`translateLine` 也走 `raceHedge`，2.5 秒会话未回就并行打直连（`REPLY_HEDGE_AFTER_MS`），且对冲的直连失败不再提前抛错、继续等会话。③ `warmTranslator` 从「只建 runtime」变成真发一个最小回合（`收到`→`ok`，20 秒上限），首句 7.9s → 0.84s。新增探针 `--inplace-probe`（桥启动与往返）与 `--reply-latency-probe`（预热后四句译文耗时），`InPlaceResult` 增加 `grabMs/translateMs/sendMs`，面板直发行显示「耗时：读聊天框 / 翻译 / 写回」。
- 2026-11: M8 改成「原地替换」并设为默认（推荐通道）——用户否决控制台逐字符（"很不流畅"），也否决"切前台自动发送"（"依然会影响游戏，比如突然翻译完成的卡顿"）。新链路读的是**游戏自己聊天框里已经打好的草稿**：`Ctrl+A`+`Ctrl+C` → 哨兵校验 → 清空输入框 → 后台翻译 → `Ctrl+A`+`Ctrl+V` 粘回英文 → 回车发出。中文原稿留在剪贴板里可恢复；全程前台一直是游戏，只注入四次组合键。先做了两次只读验证：注入 `Ctrl+A`+`Ctrl+C` 能把聊天框里的「你好」复制出来（哨兵值排除"复制无效"的假象），`Ctrl+A`+`Ctrl+V` 能把 `warding mid watch smoke` 贴进去并读回同一串。
- 2026-11: M8 新增聊天框粘贴通道并设为默认——控制台逐字符路线被否决（`Alt+Shift+T` 后要开控制台逐字符敲 1-4 秒，交互不流畅）。新链路：切前台 Dota 2 → Esc → `Set-Clipboard` 写英文 → `Enter` 开聊天框 → `Ctrl+V` 粘贴 → `Enter` 发送，整条约 0.5 秒。设置新增 `sendMode`，面板「发送通道」下拉可在「粘贴进游戏聊天框（默认）」与「控制台 say_team」之间切换；聊天框通道不做引号清理（只裁剪成可打印 ASCII）。待真实对局确认 Panorama 聊天框接受注入的 Ctrl+V。
- 2026-11: 修 M8 直发收不到命令——真因是 Source 2 控制台**不认剪贴板粘贴**（Ctrl+V 与 SendKeys 整串都无效，只留下 `Unknown command: [`），且控制台开关键本机是 `\` 不是反引号；`console-send.ps1` 重写为 C# SendInput：裸 Alt 轻敲解锁前台 → 置前 Dota 2 → Esc×2 清场 → 按开关键 → `VkKeyScanEx` 逐字符敲入（含 Shift 处理）→ 回车 → 再按开关键关闭；命令正文裁成可打印 ASCII，退出码映射成中文提示（NOGAME/NOFOCUS/BADKEY/EMPTY），超时 20s。实测 `Unknown command: zzzprod777` 稳定出现在 `console.log`。另加 zh-en 元对话守卫 `looksLikeCommentary`（"The user said …" 这类解释性输出会重译一次，仍命中就报错走直连）。
- 2026-11: M8 改回「我们自己的输入框」——去掉 OCR 读取游戏输入行那一套（`inputRegion` / `readInputLine()` / 框选输入行按钮全部删除），`Alt+Shift+T` 改为直接弹出浮层回复栏，回车即翻译并走控制台 `say_team` 直发；`console-send.ps1` 增加 Dota 2 窗口置前（Alt 轻敲解除前台锁 + `SetForegroundWindow` 重试一次），因为提交时焦点在我们自己的浮层上；面板新增「游戏内直发（控制台 say_team）」卡。
- 2026-11: M8 游戏内输入直发——新增输入行框选（`inputRegion`）+ `readInputLine()`（PaddleOCR 读输入行、过滤占位提示）；`say_team` 控制台直发（PowerShell SendKeys：Esc 丢中文 → 开控制台 → Ctrl+V 粘命令 → 回车 → 关控制台），命令文本走临时文件避免引号/IME 问题；热键 Alt+Shift+T 改为直发、浮层回复栏改绑 Alt+Shift+Y；`--input-probe` 全绿（`[队友] 我要在中路插个眼 小心他们开雾` → `say_team "warding mid, they smoke"`）。
- 2026-11: 记录候选方案「监听控制台输出代替屏幕 OCR」（`[Server] PR:NotePlayerCommsTime` 只能给触发信号，给不了文本）。
- 2026-10-23: 修复真实客户端聊天行被并成一条——昵称前缀上限 24 → 48 字符（`[队友] Balance(Bot) [LISA.]` 实测 26 字符，旧上限把它判成续行），并新增行内拆分（OCR 把两条并进一行时按第二个 `[频道]` 标记切开），会话库按 provider 分文件避免探针/换模型互相污染。`--chat-block-probe` 新增真实格式回归用例。
- 2026-10-23: 翻译链路加超时熔断与抖动统计——捕获批量超过 12 秒（冷启动 30 秒）即熔断转直连，避免聊天刷过去了还在等；总览卡新增「翻译延迟」行（p50 / p90 / 最大 / 直连 / 超时 / 错误），会话层回退时单独提示原因。`--fuse-probe` 用本地假 provider 验证熔断、计数与兜底直连。
- 2026-10-22 关闭模型思考：mimo 认 `thinking:{type:'disabled'}`（流式）与 `reasoning_effort:'none'`（非流式）。durable 模型加 `compat:{thinkingFormat:'zai'}` + `thinkingLevel:'off'` → 请求体实发 disabled、`reasoning_content` 恒为 null；语气探针 0.7–2.2s（改前 1.5–18.3s），8 行整块 2.9s。
- 2026-10-22 翻译准确性探针与译文净化：新增 `--accuracy-probe`（9 条 auto-zh 固定语料 + 3 条 zh-en 语气，逐条断言期望词 / 不回声 / 无旁白 / 无自重复），实测 12/12 通过、单条 0.8–2.9s；`sanitizeTranslation` 增加思考标签剥离（`</think>` 残留）与整句自重复折叠；auto-zh 提示词补「脏话只给简短中文等价、不解释不点名语言」。
- 2026-10-22 验收清单同步到 M7：新增「M7 聊天翻译与回复体验」12 条（续行合并/近似去重/顶部残行/前缀保留/编号不错位/四语气/草稿与倒计时/试用隔离/冷热延迟/回声/探针全绿），既有条目改用汉化后的按钮与菜单名，已知限制与排查表补齐会话库相关项。
- 2026-10-22 回声守卫：关思考后 auto-zh 会话历史可能被「原文原样吐回」的行污染 → `isEcho()` 归一化比对，命中先 `resetHistory` 重译一次，仍回声则抛错走直连兜底；提示词补一条禁回声规则。同库连跑两次 `--capture-selftest` 均为「文件 编辑 视图 窗口 帮助」。


- 2026-10-22 翻译试用并入会话层：`IPC.PROVIDER_TRANSLATE` 改走 `translateTry`（try# 槽位，历史隔离 + 启动预建），失败才退回直连；`--try-probe` 全绿；测试连接超时 15s→30s 并汉化错误文案。


- 2026-10-22 M7e/M7f/M7g 完成：面板草稿 localStorage + 复制倒计时 + 历史回填重译；浮层回复草稿跨 Esc 保留；近似判重改为两侧归一化比较；新增 `--chat-block-probe`、`--reply-draft-probe` 探针。


- 2026-10-22 M7d 回复语气模板完成：zh-en 硬限制（≤8 词 / ≤80 字符）+ 四种语气（terse/polite/hurry/firm）各自会话槽位；冷启动超时放宽到 120s 并加启动预热（warmTranslator）。


- 2026-10-22: M7b / M7c 完成（编号块整批翻译 + 会话历史；去标点归一化、裁半行丢弃、前后缀近似判重、跨语种不合并；11 项断言 + capture selftest 通过）。

- 2026-10-22: M7h 持久翻译会话层完成（pi-durable 落盘会话 + 编号块批量 + 轮次串行锁 + 8 轮重置；--session-probe 三行全对，整轮 1.9–4.9s）。

- 2026-10-22: M7a 完成（chat-lines.ts 续行合并 + 频道/昵称确定性回填，capturer 接入；9 项断言通过）。
- 2026-10-22: M7 计划立项（整块翻译+历史上下文、OCR 续行合并与滚动去重增强、频道与昵称确定性保留、回复英译短句与四语气、面板与浮层输入体验）。

- 2026-10-22: M6 语音真链路（whisper.cpp 资产 16 路并行下载 + 转写、Alt+Shift+V 麦克风采集与编码、msedge-tts 预览播放），新增 docs/ACCEPTANCE.md 逐条验收清单。

- 2026-10-22: 界面全量汉化（面板六个页签与全部按钮/标签/提示、浮层 pill 与空状态、框选与高亮提示页、托盘菜单与 tooltip、窗口标题；主进程用户可见报错同步改中文；--overview-probe 断言改为中文文案）。

- 2026-10-22: M5 日常可用化（托盘常驻+关窗隐藏+单实例、启动自动开始捕获、Overview 一键自检、按昵称过滤自己的发言）。

- 2026-10-22: 翻译提示词按 Dota 2 语境重写（术语表 JARGON_KEEP 原样保留、玩家口吻与真实用词映射如 ward→插眼/smoke→开雾、自然中文语序、禁评论禁解说、[All]/[Team] 前缀代码兜底保留；temperature 降为 0；新增 --prompt-probe 双向对照探针）。

- 2026-10-22: M4 语音骨架（whisper.cpp 路径校验/版本探测 + edge-tts 预览合成；设置页加 Probe whisper.cpp / Preview TTS 按钮；转录与虚拟声卡路由留空）。

- 2026-10-22: M3b overlay 回复栏（Alt+Shift+T 唤起，回复栏抢焦点可直接中文输入，回车→翻译→剪贴板→自动收起并 blur 归还游戏焦点；reply-state 通道消除首次加载竞态）。

- 2026-10-22: M3a 回复链路（REPLY_TRANSLATE：zh→en 短句译制 + clipboard.writeText，面板 ReplyCard 回车发送、Shift+Enter 换行、最近 5 条历史；零注入 VAC 安全）。

- 2026-10-22: 新增 PaddleOCR 后端（@gutenye/ocr-node，PP-OCRv4 zh+en，onnxruntime 本地推理），设置页可切换 Windows OCR / PaddleOCR，默认 PaddleOCR（免语言包、游戏字体识别率显著更好）。
- 2026-10-21: OCR 多语言化（Windows OCR 按语言包自动加载全引擎 + 逐行择优）；翻译改 auto-zh（任意语言→中文）。

- 2026-10-21 M1 完成；建立本文件作为计划真相源；任务同步入 pi-kanban 看板
- 2026-10-21 M2a 完成：全屏拾取框选聊天区，DIP 坐标持久化到 settings.chatRegion（3121d99）
- 2026-10-21 M2b 完成：常驻 PowerShell 桥接 Windows.Media.Ocr，stdin/stdout 行协议 JSON，测试图 E2E 识别中英文成功
- 2026-10-21 M2c 完成：ChatCaptureService 轮询管线（desktopCapturer 截图/DPI 裁剪/60 条滑动窗口去重/逐行并行翻译/广播），--capture-selftest E2E 通过（mimo 实时翻译验证：gg WP c a r e rosh mid → gg WP 小心 rosh mid）
- 2026-10-21 新增 MiMo (Xiaomi) provider 预设（OpenAI 兼容端点 token-plan-cn.xiaomimimo.com/v1，模型 mimo-v2.6-flash），用户无 DeepSeek key
- 2026-10-21 MiMo 改官方端点 api.xiaomimimo.com/v1（api-key 头而非 Bearer）；testProvider 预算 8→256 适配推理模型
- 2026-10-22 M2d 完成：OverlayManager 透明置顶双语流窗口（点击穿透 Alt+Shift+P、显隐 Alt+Shift+O）、捕获区高亮可视化（region:show）、Alt+Shift+R 实时透明框选（弃用截图冻结方案）；--region-probe 全链路实测通过
- 2026-10-23 抓屏提速：隐藏渲染进程常驻视频流取帧（抓屏 950 ms → 12-21 ms），帧指纹跳过未变化画面，OCR 线程数取 min(8, 核数/2)，译文异步补推（原文先上屏），轮询默认 1500 → 800 ms，慢回合 5 秒对冲直连；--latency-probe 原文上屏 2.1 s → 1.2-1.6 s
- 2026-10-23 指纹改判据：从「平均灰度」换成「每格亮点（文字）占比 + 每格 4x4 采样」，半透明聊天面板背后镜头在动不再触发 OCR（--fingerprint-probe：灰度判据 17.6% 格子翻红，亮点判据 0%），真新增一行仍占 0.2-0.9%；连续空转时阈值与 OCR 间隔逐步退避，总览卡显示「OCR N 次 / 文字区变化 X% / 空转 N 次」；新增 --motion-probe 采样真实聊天区
- 2026-10-23 捕获循环标记 BETA + 新增手动触发模式：settings.captureMode（auto/manual），手动模式不排队轮询，Alt+Shift+C 或面板「立即捕获」拍一张 → OCR → 翻译 → **清空译文框后整屏重建**（CAPTURE_REPLACE），命中翻译缓存的内容不花 token；--manual-probe 覆盖整屏重建不重复追加、缓存命中（第二次 427 ms、缓存条数不变）
- 2026-10-23 手动模式收尾：默认改为 manual（原因是自动轮询在实机不稳定），热键触发时浮层没开会自动弹出，面板徽标显示「手动模式」
- 2026-10-23 修复「按了热键卡在翻译里 / 全选复制前等好久」：① 会话回合客户端超时后调用 Conversation.abort 撤掉僵尸回合（原来它继续生成，下一句 submit 只能排在它后面，永久卡住）；② 对冲里直连先回来也掐掉会话回合，慢回合不再继续烧 token；③ 预热回合落回生产槽（冷 2.7-5.2 s vs 热 0.6-1.7 s），预算从 45/120 秒收到 9/15 秒；④ 输入桥分段计时（查进程 / 写剪贴板 / 组合键）落盘 userData/logs/inplace.log，剪贴板改 P/Invoke（实测 0 ms，旧 WinForms 重试循环就是「等好久」的元凶）；⑤ 单句回复只取第一行并剥掉编号前缀
