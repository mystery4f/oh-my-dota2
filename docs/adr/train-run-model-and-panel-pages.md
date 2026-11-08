# ADR：训练管理并入面板，训练记录成为一等公民
- 状态：已接受（2026-11-08）
- 关联：`docs/adr/train-manager-orchestrator.md`（部分推翻：独立训练窗口这一条退休；编排器定位不变）

## 背景
第一版训练管理是独立 BrowserWindow（780×560）+ 手写 DOM 页。用户反馈「很吃力」「画面 low、功能 low、布局 low」。具体成因：

- 视觉与面板两套体系：自己一套内联 CSS、自己的蓝色主色，同屏三个 primary 按钮，字号与间距无刻度。
- 一列竖排到底：任务、GV、录音三块挤在一个滚动条里，没有任何分段。
- 状态瞬时：`TrainSnapshot` 只有当前任务和若干日志行，跑完即消失。哪个实验训过、损失怎么走、产物在哪，全得去翻磁盘。
- 录音、打包、训练、换模四个步骤没有顺序感，也没有「现在为什么不能开训」的解释。

## 决定
- 载体并入面板：侧边栏「系统」组下新增「音色训练」「识别训练」两页；独立窗口、`train.html` 入口与 `train:open` 通道删除，不并存。
- 每页固定三段：**数据 → 运行 → 产物**。段内用面板既有 primitives（`Panel` / `Group` / `Row` / `StatusPill`），零内联色值、零自定义字号。
- **训练记录（run）** 落盘成一等公民：一次开训写一条，含种类、实验、参数、数据指纹、起止、终态、产物、指标、是否已应用、错误。一条一个 JSON 文件原子写，重启后可回看。
- 指标：ASR 从 `checkpoint-*/trainer_state.json` 的 `log_history` 读出并压缩成定长序列；GV 第一版只做 epoch 时间线与 checkpoint 名单（tensorboard event 解析明确 out of scope）。
- 开训体检收成纯函数 `judgeAsrPreflight` / `judgeGvPreflight`：只有 `block` 阻止开训，`warn` 只解释风险。
- 技术栈：渲染层用 React + 面板 primitives 重写；`src/shared/train/` 的纯决策模块与 `services/train/manager.ts` 保留并按 run 模型扩展——它们编码了踩出来的领域规则，推倒等于重新踩坑。
- 验收硬指标（可脚本检查）：训练页 0 内联色值 / 0 自定义字号；每屏 primary ≤ 1；与其他 section 并排截图风格一致。

## 后果
- 训练功能不再需要「打开窗口」这一步，浮层和面板同时开着也不会多一个窗口在任务栏。
- 记录是追加写的文件，删一条 run 不会影响磁盘上的真实训练产物；反过来删产物目录也不会让记录消失（记录里留着路径，点开能看到缺件）。
- 未来加训练种类（比如新的 TTS 微调）只需要加一段数据来源 + 一个 kind 分支，页面骨架不用动。
- 旧的 `--train-probe` 保留，新增 run 与 preflight 用例；真训练仍走 ACCEPTANCE 人工验收。
