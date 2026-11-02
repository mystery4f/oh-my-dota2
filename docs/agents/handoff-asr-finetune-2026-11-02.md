# 会话交接：ASR 微调闭环（T5）+ 一键环境安装器（M-B）

仓库 `D:/work/Code/Game/oh-my-dota2-v3`，分支 `feat/voice-comms`，与远端同步（截至 22b44e3）。
原会话：语音识别麦克风翻译（01a19277）；接收方按本文档接续。

## 现状（已验证，勿重做）

- 全部代码已提交推送：272adcc（一键微调+换模闭环）、abbe673（一键环境安装器）、d604fc1（asrFtStatus 类型补丁）、22b44e3（复盘文档）。工作区干净。
- 门禁：typecheck 双配置 + eslint 全绿，`--train-probe` 41/41 PASS（build 后 `npx electron out/main/index.js --train-probe`）。
- G15 微调模型已在役：`data/asr-models/qwen3-asr/`（真机 A/B 19/20 vs 底模 13/20）。
- 已有文档，别重复写：
  - 复盘与教训 → `docs/agents/retro-asr-finetune-2026-11.md`
  - 试点成绩/换模坑/镜像清单 → `docs/NOTES.md` 的「## ASR 微调（Qwen3）」节
  - 探针缝描述 → `AGENTS.md` 的 `--train-probe` 行
- 试点的参考环境（完整可用，可对照）：`D:/work/ft-qwen3/{env,models,Qwen3-ASR,Qwen3-ASR-onnx}`。

## 下一步（按优先级）

1. **真机验证 M-B 安装器**：训练管理窗口「一键安装训练环境」。破坏性做法：把 `data/asr-ft-env`（若存在）改名后重装，验证进度轮询（1.5s 轮询 `ft:asrft-status`）与断点续传（中断重按接着下）。装完后用环境跑一次「微调并替换模型」全链。
2. **pre-push 钩子（等老板拍板）**：`.githooks/pre-push` 跑 `npm run typecheck`，`git config core.hooksPath .githooks`。动机见复盘文档「高」节（d604fc1 那次漏提交推坏了树）。
3. 风险点自查：安装器是首次真跑，镜像 URL 未实测——uv 列表 `registry.npmmirror.com/-/binary/uv/`、torch cu121 `mirror.nju.edu.cn/pytorch-wheels/cu121/`、底模 `hf-mirror.com`。失败看 `[asr-ft-install]` 前缀日志。

## 环境

- 真训练要 GPU；隔壁会话（01a19718）的风行者 GV 训练已完成，GPU 空闲。识别/导出/安装全是 CPU。
- 隔壁会话已通过 intercom 交接同两件事，两份记录内容一致。

## 建议技能

- `code-review`：接手后若改动 M-B 代码，先按双轴过一遍。
- `tdd`：新缝（镜像探测、续传逻辑）先加探针例再实现——本会话的 uv 版本排序 bug 就是探针抓的。
