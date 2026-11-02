# oh-my-dota2

Dota 2 桌面伴生工具的领域语言：聊天摄取、翻译、语音对讲。术语按本表口径使用，同义词一律收敛到唯一术语。

## Language

**麦进（mic-in）**：
玩家按热键对着麦克风说话，本地转写成文字的入口。
_Avoid_: 录音、语音输入、ASR

**文出（chat-out）**：
译文以文字打进游戏聊天框发送的通道。
_Avoid_: 直发、粘贴发送

**朗读（announce）**：
把捡到的聊天文本合成人声、从浮层扬声器直接念出来的管线。切不切、念不念在 decideSpeak，合成与投递统一走 speech-pipeline（announce 车道）；合成失败整句跳过，绝不回退系统嗓子。
_Avoid_: 播报、TTS 播放

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

**训练任务（training job）**：
一次可启动、停止、看进度的微调训练进程抽象；同一时间只允许一个在跑。
_Avoid_: 训练（口语泛指整个事情）

**数据集（dataset）**：
训练用的录音与对齐文本的集合：ASR 侧=读稿录音组，GV 侧=GPT-SoVITS 格式的切片与标注目录。
_Avoid_: 语料、素材

**部署口（deploy target）**：
训练产物接入运行时的落点：ASR=识别引擎模型目录，GV=音色包。
_Avoid_: 安装（安装专指音色包下载动作）

**训练窗口（training window）**：
管理训练任务与数据集的独立面板窗口，主面板只留一个入口按钮。
_Avoid_: 训练页

**编排器（orchestrator）**：
app 在训练产线里的角色——下命令、收日志、管产物；训练本身仍跑在各自的 python 栈里。
_Avoid_: 内置训练

**推理互斥（inference preemption）**：
训练运行时自动暂停 GV 推理服务、训练结束自动恢复，防止 8G 显存打架。
_Avoid_: 显存管理
