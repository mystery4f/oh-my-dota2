# 会话复盘：ASR 微调闭环（2026-11-02）

T5 一键微调+换模（272adcc）与 M-B 一键环境安装器（abbe673、d604fc1）开发过程的复盘。
按严重程度排，找得到证据、也找得到修法。

## 高：推上去的树可能编不过，本地没闸门

- **发生了什么**：`asr-ft.ts` 的类型改动（`Omit<AsrFtStatusResult, 'install'>`）漏在提交外，272adcc 推上去后 CI 会红，靠推送前顺手看了一眼 `git status -sb` 才发现，补了 d604fc1。
- **根因**：仓库有 `npm run typecheck`（tsconfig.node + tsconfig.web 双配置），但 pre-push 无钩子、`core.hooksPath` 未配置、无 husky——闸门存在但没接电。CI 是事后检查，救不了推送那一刻。
- **修法**（待拍板）：`.githooks/pre-push` 跑 `npm run typecheck`，`git config core.hooksPath .githooks` 一次配置。代价每次推送约 30–60 秒。

## 中：批量编辑的固定翻车模式

- **发生了什么**：同一段实现里，tsc 前后拦下五处自伤——TrainStartRequest 双 signature 行、manager 里 `shouldResumeInference` 与 `lastBroadcastAt` 各重复一次、`TrainLogLine` import 丢失、`AsrFtSwapOp` 联合类型漏两值。
- **根因**：多行内容硬塞 `replace_match`（单行工具）触发 E_BAD_SHAPE 后，换范围 `replace` 急救，锚点边界理解错位就复制出重复行。
- **规则**：跨行改动直接用范围 `replace`（remove_from/remove_to + 完整替换文本），从源头不走 `replace_match`；单行碎片替换才轮到它。

## 低：工具经济

- 清理 `.tmp/` 时先 `ls` 全量回显（六百个文件名进上下文）再 `rm`。直接删、只回显 after 状态即可。
- 保持的纪律：**新缝必配探针例**——本次探针抓住 uv 版本号字符串排序 bug（`0.10.2` 排在 `0.9.5` 后面），不是真机炸了才知道；**30 秒可查的事实必跑命令**——漏提交正是 `git status -sb` 惯例发现的。

## 相关提交

| 提交 | 内容 |
|---|---|
| 272adcc | 训练窗口一键微调+换模闭环 |
| abbe673 | 一键环境安装器（uv+venv+pins+底模） |
| d604fc1 | asrFtStatus 返回类型对齐 install 字段 |
