# oh-my-dota2

Dota 2 桌面伴生工具的领域语言：聊天摄取、翻译、语音对讲。术语按本表口径使用，同义词一律收敛到唯一术语。

## Language

**麦进（mic-in）**：
玩家按热键对着麦克风说话，本地转写成文字的入口。
_Avoid_: 录音、语音输入、ASR

**文出（chat-out）**：
译文以文字打进游戏聊天框发送的通道。
_Avoid_: 直发、粘贴发送

**声出（voice-out）**：
译文合成英文人声、经虚拟声卡送进游戏语音频道，队友听到声音的通道。
_Avoid_: 麦克风输出、TTS 发送

**GV**：
GPT-SoVITS 音色克隆引擎在本项目的简称，加载英雄音色包做离线合成。
_Avoid_: so-vits、gptsovits

**音色包（voice pack）**：
一位英雄的一套微调权重与参考音频，可安装、切换、删除。
_Avoid_: 声音库、模型包

**说话键（push-to-talk key）**：
游戏内按住才发言的语音按键。
_Avoid_: V 键、语音热键

**识别引擎（ASR engine）**：
本地转写用的引擎，本项目只保留 whisper ggml-small 与 Qwen3-ASR 两个；SenseVoice 已废弃移除。
_Avoid_: 识别模型（与文件层的模型文件混淆）

**热词（hotwords）**：
喂给 Qwen3 做词汇偏置的词表，改词表即时生效，专治术语选错；只在 Qwen3 引擎生效。
_Avoid_: 提示词、prompt、词典

**纠错回路（correction loop）**：
在识别记录里把错的转写改成对的，差异片段自动并入热词表的闭环。
_Avoid_: 训练、学习（它不更新模型权重）
