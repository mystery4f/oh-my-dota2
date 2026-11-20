# 上手检查：六步证据链，最后一步只认真游戏

- 状态：已接受
- 日期：2026-11-20
- 相关：issue #76、`src/shared/first-run.ts`、`docs/adr/translate-guard-telemetry.md`

## 背景

新用户从空数据目录到第一局，实际会卡在四处：没填 API Key、Steam 装在别的盘导致 GSI cfg 没写进去、
识别模型还没下、热键被别的程序占了。原文的「一键自检」只做两件事——`window.api.testProvider()` 加
`captureStatus().running`。后者只说明捕获服务开着，**不证明 GSI 帧真的到过**：配置写错、游戏没重启、
Steam 库换了盘，`running` 全是 `true`，用户看到「自检通过」然后进游戏一句话都没上屏。

## 决定

总览页原来那段「自检」换成 `上手检查`：六行，每行一步，各自带一句可核对的证据。

- 步序按「先修哪个」排，不按重要性：模型服务 → GSI 配置 → 识别模型 → 热键 → 数据目录 → 游戏连上。
  前五步全部能在**没开游戏**的情况下走完；最后一步只有真游戏推过帧才算过，文案写「重启游戏」，
  因为 GSI 的 cfg 只在 Dota 启动时读一次。没有离线通过路径，也不做模拟通过。
- 证据必须是能核对的东西：cfg 那条是**路径**，模型服务是**延迟数字**，游戏连上是「N 秒前收到一帧」
  加对局状态，热键是**被占用的那个键名**。没有证据的步骤算失败——「已就绪」这种话不算证据。
- 判断全在纯缝 `src/shared/first-run.ts` 的 `judgeFirstRun(input)`：输入是六份现状快照，输出
  `{ steps, done, open }`。主进程只负责凑输入（`src/main/services/first-run.ts` 的 `firstRunReport()`），
  面板只负责画。所以这份口径能被 `--first-run-probe` 用构造输入全量钉住，不需要游戏、网络或窗口。
- `unknown`（快照还没到、数据目录不可写）不计入 `open`：它既不是「有证据」也不是「你该动手」，
  算进去只会让「还差几处」这个数字说谎。
- 「填了 key 但没测过」与「真连失败」是两种状态、两个动作：前者给「真连一次」，后者给失败原因。
  测试记录属于别的 provider/model 时当作没测——换了家还认旧收据是错的。

## 三个环境坑（同一批加固，`src/main/services/gsi-config.ts`）

- 多 Steam 库：注册表问三处（`HKCU\Software\Valve\Steam\SteamPath`、
  `HKLM\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath`、`HKLM\SOFTWARE\Valve\Steam\InstallPath`），
  再展开每个根的 `libraryfolders.vdf`。只问 HKCU 一个键时，Steam 装在 D 盘的机器上根本读不到。
- 中文路径：`reg.exe` 按控制台代码页输出（中文 Windows 是 GBK），原来直接按 utf8 解会得到乱码。
  现在拿 `Buffer`，utf8 与 gbk 各解一次，两个结果都过 `existsSync` 验真——解错的路径验不过，
  不会拿一串乱码去拼目录。
- 移动硬盘/绿色版/注册表被清：注册表那条路找不到 Dota 时，再扫盘符找 `steamapps`
  （`<盘>:\Steam`、`<盘>:\SteamLibrary`、两个 Program Files 下）。扫描只在失败后发生，
  正常启动不为兜底付 26×4 次 stat。

## 后果

- 「面板说通过」从此有具体含义：每一行都能指出它核对的是哪个路径、哪个数字、哪个键。
- 想加一步就得先在 `judgeFirstRun` 里给出它的判据和证据文案，否则探针会红——这条约束是故意的：
  一句「已就绪」挡不住这类 bug。
- 仍有一类问题这里测不出来：cfg 写对了、游戏也重启了，但别的工具占了 32123 端口。
  那属于运行时错误，走 `gsiStatus().configError` 与 `logs/gsi-chat.jsonl` 的证据，不在这一步的判据里。
