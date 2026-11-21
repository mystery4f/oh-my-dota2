# oh-my-dota2

简体中文 | [English](README.en.md)

零注入的 Dota 2 队友沟通工具（Electron + React）。

不动游戏进程，也能和外国队友交流：

- **聊天翻译** — 通过 Dota 2 Game State Integration 读取局内聊天，交给可配置的 LLM 翻译，双语透明浮层显示。回复翻译后由按键原地打回聊天框（剪贴板兜底）。
- **朗读** — 每条译文读出声：Edge 神经语音（默认，约 1.2 秒/句）、本地 Matcha 模型（76 MB，按需下载，111–249 ms，离线）、或系统嗓音。
- **语音翻译**（骨架） — 系统回环采集队友语音，whisper.cpp 本地转写。
- **麦克风语言转换**（骨架） — 说中文，队友听到英文：麦克风 → whisper.cpp → 翻译 → TTS 进虚拟声卡。

## 朗读引擎

- **Edge 神经语音（默认）** — 自然、无需 key，但每句一次跨境往返（p50 1.2 s）。
- **本地模型（Matcha，中文）** — 76 MB 按需下载进便携数据目录，p50 111–249 ms，完全离线。数据集仅限非商业使用；且需要 PATH 上有真实 node——原生 addon 拒绝在任何 Electron 运行时里执行。
- **系统嗓音** — 永远可用，机器味。

## 原则

- 零游戏注入（VAC 安全）：聊天走 GSI，回复只靠按键/剪贴板，不读游戏内存。
- 供应商无关：任何 OpenAI 兼容端点（默认 DeepSeek，也自带 OpenAI / Ollama / MiMo / 智谱 GLM 预设，可自定义）；「要不要先思考」做成开关，默认关。

## 我们碰什么，不碰什么

这一节是承诺，也是验法：每条都写清「凭什么这么说」和「你自己怎么核对」，全部落在仓库里，五分钟能跑完一条。

- **不读游戏内存、不注入 DLL、不挂钩子。** 源码里没有 `ReadProcessMemory` / `CreateRemoteThread` / `VirtualAllocEx` / `SetWindowsHookEx`：
  `grep -rnE "ReadProcessMemory|CreateRemoteThread|VirtualAllocEx|SetWindowsHookEx" src/ resources/` 输出为空。
  游戏开着内存完整性校验，所以这不是「顺手做的」，是唯一能长期活着的做法。
- **聊天来自 Dota 2 自己的 Game State Integration。** 写进游戏目录的只有一份 `gamestate_integration_ohmydota2.cfg`，
  Valve 给第三方工具留的官方接口，明文可读，面板「浮层与对局」里能看到它的完整路径与端口。
  核对：`npm run probe -- --gsi-probe`（不需要开游戏），或对局中看 `data/logs/gsi-chat.jsonl`，一行一条消息。
- **屏幕只在两种情况下被读：你把采集方式选成截图，或你按了一次抓取键。** 选 GSI 时整条链路不碰屏幕，
  `data/logs/capture-ticks.jsonl` 也就根本不会出现——文件不在，就是没截过。
- **回复只靠按键与剪贴板，不进游戏。** 面板里的「直发」把译文放进剪贴板、再按一次回车键；
  每一步记在 `data/logs/inplace.log`，核对：`npm run probe -- --inplace-probe`。
- **没有遥测，没有上报。** 日志全部写在本机便携数据目录（安装目录同级的 `<安装目录>-data`），每份 256 KB 滚动覆盖；
  `npm run probe -- --logs-isolation-probe` 证明连探针自己都只写临时目录，不碰你的日志。
- **密钥只在本机，导出也带不走。** API Key、各供应商 key 表、代理地址存在 `data/settings.json`；
  「关于 → 导出设置包」把这三项换成空值并记进 manifest 的 `omitted`，核对：`npm run probe -- --settings-bundle-probe`。
- **每个关键行为都有探针。** 目录见 [`docs/PROBES.md`](docs/PROBES.md)，一条命令一条：`npm run probe -- --<名字>`；
  CI 跑的就是这张表里标了 `ci: true` 的那些。

上面任何一条都可以被读代码的人当场否定——写在这里正是为了让否定变容易。哪条和代码对不上，请直接开 issue。

## 开发

```bash
npm install
npm run dev        # electron-vite 开发
npm run typecheck
npm run build
```

需要 Node 20+、Windows 10/11。

## 路线图

- [x] M1 脚手架：设置面板、供应商层
- [x] M2 聊天获取：局内区域框选、PaddleOCR、去重、透明浮层
- [x] M3 回复链路：中→英翻译 + 剪贴板交接（面板 + 浮层条）
- [x] M4 语音骨架：whisper.cpp 探针、TTS 预览
- [x] M5 日常可用：托盘常驻、自动开始抓取、总览自检、过滤自己那句
- [x] M6 语音管线：whisper.cpp 资产、Alt+Shift+V 麦克风采集、msedge-tts 预览
- [x] M7 聊天质量：带历史的多行翻译、滚动去重、语气预设短回复、面板与浮层回复草稿

见 [docs/DESIGN.md](docs/DESIGN.md) 与 [docs/PLAN.md](docs/PLAN.md)。
