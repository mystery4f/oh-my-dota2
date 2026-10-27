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
- 供应商无关：任何 OpenAI 兼容端点（默认 DeepSeek，也支持 OpenAI、Ollama、自定义）。

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
