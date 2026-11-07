# 训练管理 v3 执行计划

Spec：GitHub issue #49。票：#50 #51 #52 #53 #54 #55。集成分支：`feat/train-v3`。
Autonomous 执行中（老板已睡）。每完成一项就改这里的复选框并提交，崩溃/断网后从第一个未勾选项继续。

## 恢复协议（loop 或新会话先读这段）

- 当前分支应为 `feat/train-v3`；`git status -sb` 应为干净或只有本计划的文件。
- 从下面第一个未勾选的条目继续；不要重读整个仓库，先看本文件指向的文件。
- 每次提交前跑 `npm run typecheck`；收尾再跑 lint / build / 探针。
- 全部勾完：跑 T6 验证、关票 #50–#55 与 #49、`LoopDelete`。

## T1 shared 训练记录模型（#50）

- [ ] `src/shared/train/run.ts`：TrainRunRecord 类型 + buildTrainRun / finishTrainRun / runIdFor / compareRunsDesc
- [ ] metrics：compactMetricSeries（定长 ≤200）、parseAsrTrainerState（log_history → series）、parseGvTrainLog（epoch 时间线 + checkpoint 列表）
- [ ] 探针用例加入 `src/main/probes/train.ts`

## T2 main 存储与 IPC（#51）

- [ ] `src/main/services/train/run-store.ts`：一条 run 一文件、原子写、列表/详情、容错解析
- [ ] `src/shared/ipc.ts` 增 TRAIN_RUNS_LIST / TRAIN_RUN_READ，删 TRAIN_OPEN；`src/main/ipc.ts` handler 与 `trainOpen` 同步删
- [ ] manager 在开训/结束/失败/停止写记录（数据指纹、产物路径、指标）
- [ ] 长跑结束发一次系统通知
- [ ] 预览 stub 补新通道

## T3 renderer 两页骨架（#52）

- [ ] `sections.ts` 加 voice / asr（系统组）
- [ ] `pages/voice-train.tsx`、`pages/asr-train.tsx`：数据 → 运行 → 产物 三段
- [ ] `components/run-view.tsx`：RunList / RunDetail / 进度 / 指标折线（currentColor，无内联色值）
- [ ] demo 从产品 UI 移除（共享类型与探针保留）

## T4 录音搬进 React（#53）

- [ ] `use-recorder.ts`：复用 advanceRecording / shouldKeepTake / encodeWav16k，参数与原实现一致
- [ ] 识别训练页录音段：组列表 + 覆盖率 + 当前句 + 录/停/回放/识别测试 + 重录覆盖提示
- [ ] 录音跑通后，才删 `windows/train.ts` + `train.html` + `train.ts` + vite 入口 + talk 页入口

## T5 体检与 GV 视图（#54）

- [ ] `src/shared/train/preflight.ts`：聚合环境缺口 / 备料 / 录音覆盖 / 显存 / 续训点 → PreflightItem[]（ok/warn/block）
- [ ] 两页顶部体检清单，缺项带修复动作；只有 block 禁用开训
- [ ] 音色训练页：实验列表（备料四件套、两腿是否已训）、注册音色包与来源 run、webui 开关

## T6 验证与文档（#55）

- [ ] `npm run typecheck` node + web 通过
- [ ] `npm run lint` 只剩 button.tsx:41 告警
- [ ] `npm run build` 通过
- [ ] `npx electron out/main/index.js --train-probe` 全 PASS（先 taskkill electron）
- [ ] 验收脚本：训练页 0 内联色值 / 0 自定义字号；每屏 primary ≤ 1
- [ ] `npm run panel:preview` 两页截图（`?s=voice`、`?s=asr`）
- [ ] GLOSSARY 术语变更；新增 ADR；docs/PROBES.md 加行；ACCEPTANCE 五条；本文件勾完

## 已知风险

- 录音 hook 是最难的一块：旧实现 640 行原生 DOM。判定逻辑不动，只换外壳。
- GV loss 在 tfevents 里，本版不做（spec 已写 out of scope）。
- 8G 显存：不要在本机跑真实训练来验证，用探针 + fixture。
