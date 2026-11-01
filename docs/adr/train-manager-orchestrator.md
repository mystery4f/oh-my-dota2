# ADR：训练管理页采用编排器定位

- 状态：已接受（2026-11-02）
- 关联：`docs/adr/asr-hotwords-not-finetune.md`（微调触发条件已被 ASR 口音问题满足，本 ADR 是它的延续）

## 背景

两条微调产线都在 app 外手动跑：GV 音色包训练用 GPT-SoVITS 自带 webui（`data\gpt-sovits`），ASR 口音微调目标已定为 Qwen3-ASR-0.6B（官方 `QwenLM/Qwen3-ASR` 仓库的 SFT 脚本 `qwen3_asr_sft.py`，推翻此前「Qwen3 不可微调」的判断，见 `docs/adr/asr-hotwords-not-finetune.md` 更正节）。用户要在 app 里统一管理训练。GPU 只有 8G 显存，训练与 GV 推理会抢。

## 决定

- app 做**编排器**：下命令、收日志、管产物；训练进程跑在各自 python 栈里，不搬进 app。
- 管理界面用**独立训练窗口**（新 BrowserWindow），主面板只留入口按钮。
- GV 侧 MVP 边界：数据集登记 → 启动/停止 → 进度日志 → 产物注册音色包；降噪/切分/标注仍走 GPT-SoVITS webui（页面放「打开 webui」按钮），不复刻备料流程。
- ASR 侧全流程进页面（录音组状态/回放 → 数据准备 → 开训 → 进度 → 导出 ONNX → 部署），但排期在第一轮手动微调跑通之后——照跑通的流程做页面，不返工。
- **推理互斥**做成自动：训练运行 → 停 GV 推理服务；训练终态 → 自动恢复；恢复失败要提示。
- 同一时间只允许一个训练任务（8G 显存硬约束）。
- 测试收在一条纯函数缝：任务计划推导、日志行→进度解析、互斥闸状态迁移，配 `--train-probe` 探针；进程控制与真训练走 ACCEPTANCE 人工验收。

## 后果

- GPT-SoVITS webui 仍是备料正道，app 不重复造它。
- 微调产物统一走两个部署口：ASR=识别引擎模型目录，GV=音色包（refs.json + 权重，复用现有切换管线，零新增切换逻辑）。
- 训练任务串行；将来要并行训练需重开此 ADR。
