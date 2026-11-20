---
created: 2026-11-20
updated: 2026-11-20
tags: [docs, product, competitive]
---

# 同类对局助手竞品分析（2026-11）

口径来自 `/pm-competitive-analysis`：范围 = **同类对局助手**（能在 Dota 对局中给信息的工具），用途 = **产品路线取舍**。
所有项目信息取自 GitHub 公开元数据与 README（2026-11-20），命令见文末「证据与复现」。

## 结论先说

- 开源这一层**没有对手**：`dota2` / `dota 2 overlay` / `dota2 assistant` 三个关键词按星数排序，前排要么是改游戏文件的 mod 工具，
  要么是资料站，唯一一个 92★ 的「overlay」仓库本体是落地页，没有浮层源码。真正跟我们抢同一块屏幕的是 **Valve 自己的 Dota Plus**。
- 我们所在的那半张图（局内「听得懂 + 说得出」）在开源里**没有人做**。他们的力气全花在「打得好」：反制装、克制位、胜率预测。
- 可以直接搬的好东西只有两件：**补丁感知**（跟着游戏更新走，别等用户报错）和**可解释的局势曲线**（别学 predictor 吹 ML）。
  其余（反制装建议、BP 画面、mod 类）与我们拿不到数据或缺受众，明确不追。

## 这条线到底有谁

| 项目 | 星 | 形态 | 许可 | 它证明能做到的事 | 对我们意味着什么 |
| --- | --- | --- | --- | --- | --- |
| Valve **Dota Plus**（官方订阅，页面显示 ¥620/月，区服定价未核） | — | 游戏内置 | 闭源 | 英雄进度、Plus Assistant 助手、轮盘、每周奖励 | 唯一真对手：官方、零安装、界面本来就贴着英雄。它给不了的只有「人和人的话」 |
| `mym4s4s1/dota-2-overlay` | 92 | 落地页 | **无** | README 自称 hooks into the game client、Combat log tracking | **不是竞品，是风险**：仓库树里只有 astro 站点（`public/`、`src/`、`files/`），无浮层代码；安装靠一个 PowerShell 按钮；README 挂 ETH/TRON 打赏；4.7/5 评分徽章指向空链接 |
| `Fluester/dota2overlay` | 0 | Tauri v2 + WebView2，portable 6.05 MB | 无 | 127 英雄知识库、51 条反制装规则、16 条敌方装备触发、30 条中立装规则、Pos1–5 出装适配、GSI + HUD 屏幕识别、OpenDota + Valve datafeed 同步到 patch 7.41f | 唯一把「助手」做全的样本，技术取舍可读：**它靠 HUD OCR 拿敌方信息，这正是我们删掉的那条腿**；体量说明 Tauri 一条路线能压到 6 MB |
| `andreiapostoae/dota2-predictor` | 373 | Python 工具链 + 模型 | 有 | 胜负预测 ROC AUC ≈ 0.65（逻辑回归 / NN）、dataset 挖矿、协同与克制可视化 | 0.65 是天花板级公开数字 → **我们不做概率预测**，只做可解释的局势差 |
| `odota/core`（OpenDota） | 1640 | 数据平台 | 有 | 赛后完整解析、公开 API | 已在用；赛前局内数据它给不了（TODO.md:219 实测进行中 `players: []`） |
| `SteamTracking/GameTracking-Dota2` | 778 | 游戏文件跟踪 | 有 | 每次更新后的资源差量 | **可搬**：补丁看守的数据源 |
| `ValveSoftware/Dota2-Gameplay` | 1648 | 官方 bug 跟踪 | — | Valve 对 GSI 诉求的公开回应 | 「Valve 会不会加字段」的证据来源，别再靠猜 |
| `ValveResourceFormat` | 2590 | C# 工具 | 有 | VPK 浏览 / 反编译 | 已在用（Source2Viewer-CLI 取语音素材） |
| `antonpup/Dota2GSI` / `xzion/dota2-gsi` | 236 / 127 | 库 | 有 | GSI 服务端封装 | 我们已有自己的 `gsi.ts`，不引库 |
| `qqquiu/dota2-webdraft` | 10 | 网页 BP 画面 | 有 | OBS 用 picks/bans | 受众是主播不是玩家，不追 |
| `dota2-mod-manager` / `dota2-minify` | 337 / 278 | 改游戏文件 | 有 | 换肤、改包 | 违背零注入，永不碰 |

## 能力矩阵

| 能力 | 我们 | Dota Plus | Fluester 类助手 | OpenDota |
| --- | --- | --- | --- | --- |
| 局内读别人的话并翻译 | **有** | 无 | 无 | 无 |
| 把译文说出来（TTS） | **有** | 无（只有轮盘语音） | 无 | 无 |
| 局内回话（草稿翻译后发出去） | **有** | 轮盘短语 | 无 | 无 |
| 英雄 / 装备知识库 | 无 | **有** | 有（手工 127 英雄） | 赛后 |
| 敌方出装反制建议 | 无（拿不到数据） | 弱 | 有（靠 OCR） | 无 |
| 局势 / 胜率 | 无 | Plus Assistant | 无 | 赛后 |
| 跟着补丁自动更新 | **无** | 内置 | 有（datafeed） | 有 |

矩阵里我们**独占前三条**，缺的是后三条里唯一做得成的一条：补丁感知。

## 定位图

横轴 = 是否触碰游戏客户端（左：零注入 / 右：注入、OCR、改文件）；纵轴 = 服务「打得好」还是「聊得通」。

```
              聊得通
                │
      我们 ●    │
                │
────────────────┼────────────────  零注入 ← → 注入/改文件
                │        ● Fluester 类（OCR 读 HUD）
                │   ● Dota Plus
                │        ● mod 工具 / 92★ 落地页
              打得好
```

右上角是空的，不是因为没人想做，是因为**要做成得同时有 OCR 和知识库**，而 OCR 那条腿我们已经判死（`docs/TODO.md:263`：
敌方装备栏不上屏）。这块让给对方，不丢人。

## 可以直接搬的四条（按性价比排序）

- **补丁看守**（P1，可搬）：订阅 `SteamTracking/GameTracking-Dota2` 的增量 + `ValveSoftware/Dota2-Gameplay` 里 GSI 相关 issue，
  在启动时比对「我们认识的 GSI 字段 / 英雄名单 / 聊天轮盘条目」与游戏实际，多出来的写进 `logs/patch-watch.jsonl` 并在面板提示。
  价值：静默失效（Valve 换字段、加英雄）从「用户报 bug」提前到「我们第二天就知道」。现状证据：仓库里**没有**任何 Dota patch 概念，
  `grep -rn "7.4[0-9]" src/` 只命中训练脚本，不是游戏版本号。
- **术语包带补丁戳**（P1，补 #82）：`dota-glossary` 现在是一张静态表，新英雄上线只能等发版。给每个术语包打 `patch` 字段，
  补丁号变了就提示复核；配合上面的看守，做到「游戏更新当天就知道要不要动词表」。
- **可解释的局势带**（P2）：只用 GSI 已有量（经济差、塔差、时间）画一条局势带，**不叫胜率预测**、不给小数概率——
  predictor 用完整赛后特征也只到 0.65 AUC，局内特征更差，写死百分数等于骗人。挂在浮层收起态的一角，与 #99（一句话团战总结）同源。
- **「不注入、可审计」的对外声明**（P2，文档级）：竞品里已经出现「PowerShell 一键安装 + 打赏地址 + 无源码」的形态，
  搜索结果会被这类东西污染。我们零注入、开源、有 34 条探针可自证——这条要写进 README 与商店页，作为信任差异化，而不是技术炫耀。

## 按「最近更新」再扫一遍（2026-11 仍然活着的项目）

星数排序会漏掉刚起步但真在写的东西。按 `dota2 gsi` / `dota gsi` 的 updated 倒序扫，2026 年还有提交且形态对我们有借鉴意义的只有四个：

| 项目 | 更新 | 星 | 它已经做到的 | 对我们的价值 |
| --- | --- | --- | --- | --- |
| `cannawen/dota-gsi-discord-bot` | 2026-07，跟到 patch **7.42** | 8 | 把「智慧符刷新、肉山计时」这类**事件播报**推进 Discord 语音频道 | 需求被验证了，只是播报渠道不对。我们有全套中文 TTS——**这是我们该做而没人做的那一件** |
| `adgsenpai/dota-gsi-dashboard` | 2026-10-29 | 0 | 本地网页看板：经济/买活（价钱、CD、买得起吗）、**叠野 :53–:55 倒计时 + 闪 STACK NOW + 提前 5 秒响铃**、拉野 :15/:45、补刀节奏对曲线（80@10min / 180@20 / 270@30）、五种神符下次刷新、痛苦之源与肉山 8–11 分钟窗口、昼夜、GPM/XPM 曲线 | 一整套**计时器知识表**，几乎全是静态知识 + 游戏时钟，与注入无关。隔壁那个「说」的腿可以直接把这些念出来 |
| `QueenieeQ/dualmonitor_dotaGSI` | 2026-10-07 | 1 | **第二块屏幕**看板：比赛时钟、昼夜、肉山与眼位计时、英雄/经济/装备/技能、小地图、净值曲线，主题色取自当前英雄 | 我们只有浮层没有副屏。副屏是「不想挡画面」那批人的自然解法 |
| `svenski88/dotabased_gsi` | 2026-10-19 | 1 | 本地桥 + **LightGBM 预测模型**（min3 / micro19 / herowr / max482 / pro 五套本地模型文件）+ 浏览器可读的 **draft / debug 端点** | 两点待核：一是它声称能对外提供 draft 端点，与 `docs/TODO.md:219`「GSI draft 全灭」的实测冲突，值得用我们自己的探针复核一次；二是「本地模型文件 + 桥」这种分发形态，比我们设想的云端预测更可落地 |

判读：这条线的活人都在做**「替你计时、替你播报、替你摆到第二块屏」**，没有一个人碰「把队友的话翻出来给你听」。
前两件正是我们零成本能吃下的——计时表是静态知识，播报我们有现成的嘴。

已落票：#123（计时播报，P1，ready-for-agent）、#124（副屏看板，P2，needs-triage）、#125（复核 GSI draft，P2，needs-triage）。

## 三条威胁

- **官方顺手做掉**：Valve 只要给 GSI 加一个 `chat.translated` 字段，或者把聊天翻译做进客户端，我们最核心的一条腿立刻变成 table stakes。
  应对：不把身家押在「翻译」这一个动词上，语音对讲、术语包、复盘是同一个用户故事的不同动作，要一起立住。
- **体量与冷启动**：Fluester 用 Tauri 做到 6 MB portable，我们是 Electron。安装包体量在低配机上就是流失率，长期要评估，
  但**这一轮不动**——重写壳子的收益比不上把功能做深。
- **安全污名**：92★ 那个空壳仓库一旦被判定为恶意分发，「Dota 2 overlay」这个品类会整体掉信任。
  我们能做的是把自己和它明确切开（开源、许可、可审计日志、不做一键 PowerShell）。

## 建议

- **加码**：局内「听得懂 + 说得出 + 回得去」这一整条人链路。这是矩阵里唯一由我们独占、且对手没有动机进来的格子。
- **补齐**：补丁感知（唯一性价比高的 table stakes），其余知识库类能力不补——补了也只是追平一个 0★ 项目。
- **无视**：反制装推荐、克制位提示、BP 直播画面、胜率百分比、任何改游戏文件的路线。

## 证据与复现

```bash
export HTTPS_PROXY=http://mcr:4444 HTTP_PROXY=http://mcr:4444
gh search repos "dota2" --limit 30 --json fullName,stargazersCount,description,language
gh search repos "dota 2 overlay" --limit 8 --json fullName,stargazersCount,description
gh api repos/mym4s4s1/dota-2-overlay/git/trees/HEAD --jq '.tree[] | "\(.type) \(.path)"'
gh repo view Fluester/dota2overlay --json stargazerCount,diskUsage,licenseInfo,pushedAt
```

- 星数、许可、体量、推送时间皆为上表当日抓取；README 自述的能力（Fluester 的 51 条反制装规则等）**未逐个验证**，按自述记录。
- 我们自己的三条独占能力对应实现：`src/main/services/gsi.ts`（收话）、`src/main/services/voice/speech-pipeline.ts`（说出来）、
  `src/main/services/input/`（回出去）。
- 相关：`docs/DESIGN.md`（零注入路线）、`docs/TODO.md:219`（GSI 四路与 OpenDota 实测）、`docs/TODO.md:263`（敌方装备判死）、
  `docs/REQ-backlog-2026-11.md`（47 条候选池）。
