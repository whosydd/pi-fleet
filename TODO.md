# TODO：单包形态，planning 从上游装、execution 本地钉

> `npm run check` 全绿：79 项测试 + 无头加载 + planning 过滤器校验。
> 边界见 `AGENTS.md` 的 Invariants，本文件不复述。

## 本轮的关键发现（都靠实测，不是推理）

1. **pi 的 git 安装是裸 `git clone`**（`package-manager.js:1566`），没有
   `--recurse-submodules`，整个 dist 里零 submodule 处理。**submodule 方案出局**。
2. **`pi` manifest 会短路约定目录扫描**（`package-manager.js:1865-1871`：有
   manifest 就 `addManifestEntries` 然后 `return true`）。所以"物理分目录"不是承重的，
   manifest 才是。这推翻了我先前"planning/execution 必须分目录"的判断。
3. **过滤器 pattern 不剥 `./`**，且**匹配不到任何文件时静默失败**——不加载、无诊断。
   前者靠人记住形式，后者只能靠脚本从 manifest 生成列表 + `--check` 兜。
4. **vendored 副本会赢名字冲突。** 同时装 pi-fleet 与上游时实测 10 条 collision，
   `winnerPath` 是本地副本——于是项目静默跑在钉死版本上，永远拿不到上游最新。
   这是把 planning 从本包删掉的**决定性理由**。
5. **`npm run check` 通过不代表四个工具注册上了。** 给扩展尾部加一句 `throw` 之后
   `npm run smoke` 仍退出 0，而且 `active tools` 全 `true`——那是本机另一份副本注册的。
   详见下节。

## 本轮清理（已做）

| 项 | 处理 |
| --- | --- |
| `.fleet/`（旧架构 10 个 run 目录、5 份 contract） | 删除 |
| `session.jsonl`（根目录 1.1MB 会话日志） | 删除 |
| `PI_FLEET_RUNS_DIR` 默认值 | `.fleet/runs` → `.pi/fleet/runs` |
| run 目录的 gitignore | 重建 `preflight.ts`：dispatch 前把 `.pi/fleet/` 写进项目 `.gitignore` |
| `skills/execution/`（vendored 11 → 3 → **0**） | 整个删除 |
| `scripts/sync-skills.mjs` | 删除。曾换成 `check-skills.mjs`，后一并删除（理由见下节） |
| `.github/workflows/sync-skills.yml` | 删除。曾换成 `upstream-drift.yml`，后一并删除 |
| `skills/UPSTREAM.json` | 删除，没有 vendored 的东西可记录 |

## 撤掉上游漂移检查

`scripts/check-skills.mjs` 与 `.github/workflows/upstream-drift.yml` 曾每天拿上游 HEAD
比对 `skills/manifest.json`。**现在两者都已删除**，理由是实测出来的：

**`pi install -l` 对已安装的包是空操作。** 实测记录：上游 `main` 在 `f7f0508`，
本仓库的克隆停在 `49dd158`，跑完 `pi install -l` 后仍是 `49dd158`。

于是只有 `pi update` 会移动那个克隆，而它把克隆移到 `main` 当时的位置。所以漂移的
可见时刻是"你更新的那一次"——你在场，症状是你自己的 `/skill:` 列表里少一条。而更新
之前的每一天都查不出任何用户处于的状态：上游改了名、而你没拉取时，什么都没坏。

一个长期为红、却不对应任何实际损坏的 CI，比没有 CI 更糟：它训练人忽略红。

保留下来的只有离线的 `npm run check-planning`。它比对**本仓库自己的两个文件**
（`.pi/settings.json` 与 manifest），抓的是"改了 manifest 但忘了重跑
`/matt-pocock-skills-bootstrap`"。

## 关键转折：本包不再发布任何上游 skill

起因是一个反问：**codex 和 claude 都装了完整的 matt skills，为什么还要在 pi 里找？**

查证后我原来的理由只成立一条，而那条可以绕开：

| skill | codex | claude | 结论 |
| --- | --- | --- | --- |
| `implement` | `allow_implicit_invocation: false` | `disable-model-invocation: true` | executor 看不到它 |
| `tdd`、`code-review` | 模型可自主加载 | 无该标记 | executor 能自己拿到 |

于是"给绝对路径"反而制造了新问题：

1. **双份加载。** `tdd`/`code-review` 是模型可自主加载的。我们的任务文本本身就足以触发 executor 加载**它自己那份**，而我们又额外塞了路径 → 一个 skill 的两份指令同时进上下文。
2. **版本不同。** codex 装 1.3.1、claude 装 1.2.3，实测 `code-review` 差 4 处（claude 那份还缺"两个 sub-agent 同时发起"那一句）。
3. **`implement` 净贡献为零。** 六条指令里五条我们已有更可靠的实现（brief 拷 ticket、contract 强制报真实测试数、task 说 commit），第六条"自审"正是我们要移除的。

**所以最终形态**：本包只发一个自己的 skill（`fleet`）。planning 装上游到项目里（要最新），execution 靠 executor 自己的安装（按**名字**引用，不给路径），而真正需要保证的东西——两轴定义、反递归、输出格式——收进 `brief.ts` 的文本里。

那三样本来就该是我们的事：上游至今没修反递归（两边装的都是 0 处命中），而上游输出的是散文，不是我们的 contract。

## 已定边界


| 决定 | 选择 | 理由 |
| --- | --- | --- |
| planning 从哪来 | 项目级装上游 + settings 过滤 | 要最新；ticket 格式变了会在 claim 时大声失败 |
| execution 从哪来 | executor 自己的安装，按名字引用 | 按路径给会造成双份加载与版本打架；真正要保证的三样收进 brief 文本 |
| 谁当 fleet | pi 逐 ticket dispatch | `implement-spec` 自己起 subagent 加 worktree 加 frontier，两个 orchestrator 抢分支 |
| ticket 的写入权 | 只有 `Status:` 一行归扩展 | claim 是并发问题，并发问题归代码 |
| executor 看不看得到 ticket | 看不到 | brief 拷 ticket 正文，未提交的 ticket 在 worktree 里也可见 |
| 交付形态 | 只有 pane，无降级 | worktree 的 git 元数据在 worktree 之外，sandbox 写不了 |
| 上限在哪 | 工具里 | fix round 上限与 claim 都不能交给模型裁量 |
| git 拦截 | 保留自研，不装 matt 的 guardrail | 两者零交集：matt 拦 push/reset/clean 且只在 claude 侧，stash 与 amend 无人管 |

## 已记账、未修（不阻塞 T1）

- [x] **`smoke/load.ts` 只打印不判定。** 已修（ticket `smoke-load-assertions/01`，commit `5f202eb`+`3977960`，merge `bfb4ccb`）：判定抽成 `extensions/lib/smoke.ts` 的纯函数，入口抛异常、四个工具缺失、`fleet` skill 缺失都退出 1，且按传入的 `entry` 路径认自己。
- [ ] **`.github/workflows/check.yml` 从未运行。** `git remote` 是空的，仓库没推送过，
  只有一个提交者，所以它今天价值为零，激活条件是推上 GitHub。修完上面那条之后它才有
  实际意义：CI 跑的是新鲜克隆，没有本机全局配置可以掩盖失败。**先做 T1，之后再决定留删。**

## T1 真跑记录（完成）

- **implement**：codex，`job_01_1791733796513_9lr8`，contract `complete`；commit
  `5f202eb fix(smoke): judge the loaded entry and its tools`（重构 `smoke/load.ts`，
  新增 `test/smoke.test.ts`）；contract 自报 `npm run check` 84 通过。
- **review**：claude，`job_01_1791735031901_7554`，contract `complete`，两轴分开报，无递归
  spawn。它自己把 `smoke/load.ts` 改回 `includes("pi-fleet")` 重跑测试，证明了新测试
  抓不住那条验收。两轴各一条 blocker：
  - standards：`test/smoke.test.ts` 把真实 pi loader 与 session 拉进 `npm run test`
    （每例一次，共 5 次），与 AGENTS.md 把 loader 检查放在 `npm run smoke` 的分工冲突；
    `smoke/load.ts` 还算了一遍包根，而 `extensions/lib/skills.ts` 已导出 `PACKAGE_ROOT`。
  - spec：ticket 的第二条验收（按传入 entry 路径归因）没有被测试钉住：改回 substring 匹配后，
    `node --test test/smoke.test.ts` 仍然 5 pass。脚本本身是对的，测试没锁住它。
- **fix round 1**：codex，`job_01_1791736483799_3viw`，contract `complete`；把 smoke 判定抽成
  `extensions/lib/smoke.ts` 纯函数，`npm run check` 84 通过（未 commit——新流程首次验证成功）。
- **第二次 review**：claude，`job_01_1791736945041_7yvq`，contract `complete`。spec 全过：
  reviewer 重建了三个坏副本逐个验证 `exit 1`。standards 一条保留意见：集成测试被换成
  纯函数测试，坏树路径不再有回归守卫。判定不阻塞（判定分支有单测，健康树由
  `npm run smoke` 每次端到端跑），理由记在 ticket 的 Comments 里。
- **pi commit**：`3977960 fix(smoke): make the smoke decision a pure function`（在 `5f202eb` 之上）。
  ticket `Status: done`，5 个 settled job 的 tab 已 cleanup。
- **合并与清理**：`bfb4ccb merge: ticket 01, the smoke test now judges what it loads`；合并后
  `npm run check` 89 通过。随后 `git worktree remove` 删 worktree，`git branch -d` 删分支。
  `herdr worktree remove` 此处不可用：cleanup 关掉最后一个 tab 后 Herdr 回收了 workspace，
  它只认活着的 workspace（`workspace_not_found`）。

真跑暴露的三件事，前两件当场修掉：

| # | 现象 | 处理 |
| --- | --- | --- |
| 1 | 会话里跑的是 18:08 加载的旧扩展，磁盘上已删的 vendored execution 检查仍拒绝 dispatch | 与代码无关，`/reload` 后消失。教训：改扩展后不 reload，现场就是旧内存 |
| 2 | `FleetCleanup` 关掉 worktree 最后一个 tab 后 Herdr 回收整个空 workspace；再次 dispatch 时 `runner.ts#workspaceFor` 回退到 `HERDR_WORKSPACE_ID`，pane 静默落进主会话 workspace | **已修**：删掉回退，改为 `herdr worktree open --path`（幂等）自愈，失败才拒绝；新增 2 个 runner 测试 + 1 个 herdr 测试；SKILL 与两个工具描述同步 |
| 3 | `skills/fleet/SKILL.md` 步骤 5 要求把 ticket 设成 `done` 再派 review，而 `claimTicket` 只接受 `ready-for-agent`，review 必然被拒 | **已修**：步骤 5 改为把 ticket 设回 `ready-for-agent` 并记录 branch；`done` 移到 review 无阻塞之后；fix round 同样先设回 |

环境侧（不是本包的 bug）：codex 默认 provider 的 `/v1/responses` 返回 404，
claude 报 `unrecognized_model: tierflow_pro[1m]` 但仍出结果；用户重配后两条通道的
最小探针都通过。

## 流程变更：executor 不 commit，review 通过后由 pi commit

用户定下的流程，已落地到代码与技能文档：

1. executor 只改 worktree，**不 commit**。
2. review 看的是**未 commit 的 worktree**。pi dispatch 前先 `git -C <worktree> add -A`，
   否则 `git diff` 看不到新文件。
3. review 无阻塞 → pi 自己 `git commit`（conventional commit，subject 取 ticket 标题），
   `git merge --no-ff` 合入 main，合并后跑一遍 `npm run check`，再把 ticket 设 `done` 并记下
   branch 与 sha。最后 `FleetCleanup` 关 tab，`git worktree remove` 删 worktree，
   `git branch -d <branch>` 删分支（`herdr worktree remove` 只认活着的 workspace，此处不可用）。
4. review 有阻塞 → ticket 设回 `ready-for-agent` → codex 在同一未 commit 的 worktree 上改 →
   重新 review。fix round 上限照旧（`PI_FLEET_MAX_FIX_ROUND`，默认 2）。
5. dispatch 文本不再一刀切禁止子代理（implement 侧删除该禁令）；review 侧保留反递归
   守卫，因为“不能无限循环”正是它要防的事故。

改动文件：`brief.ts`（规则与 review 输入）、`contract.ts`（implement schema 删除
`commits`，改为显式拒绝该字段）、`index.ts`（工具描述）、`skills/fleet/SKILL.md`
（步骤 5–7）、`README.md`，以及 brief/contract/runner 三套测试。`npm run check` 81
通过。

**注意**：当前会话的扩展是旧内存，需 `/reload` 后新流程才生效。T1 的 codex 已经
commit 了（旧流程产物），所以 T1 不需要 pi 补 commit；新流程从下一个 ticket 开始。

## 自动衔接：job settle 即唤醒会话（已实现，待 /reload）

用户要求“codex 执行完毕后直接 claude review”，不要等人输入。pi 提供
`pi.sendUserMessage()`（文档：always triggers a turn），这就是缺失的钩子。

实现（第二轮改为信号驱动）：

- **等 Herdr 的状态信号，不轮询**：`runner.waitAgent()` 调 `herdr agent wait <name>
  --timeout 300000`，agent 状态一变就返回。Herdr 没有事件订阅命令（`herdr api` 只有
  拉取式 `snapshot`/`schema`），`agent wait` 就是它的状态通知机制。
- 醒来后用 `runner.harvest()` 判定；`running` 就节流 15 秒再等，避开“agent 已 settled
  但 contract 未写”引起的空转。**contract 文件仍是唯一成功判据**，Herdr 的 idle/done 仍只表示
  ready for input。
- settle 后用 `pi.sendUserMessage()`（pi 文档：always triggers a turn，
  `deliverAs: "followUp"`）唤醒会话，消息只说“某 job settled，去 FleetHarvest”，不搬运
  contract 内容。
- 扩展加载时扫描 `runner.all()` 里未 settle 的 job 并接管：`/reload` 或重启后，旧 job
  完成也会唤醒。手动 harvest 同一个 job 会注销 watcher，避免多唤一次。
- 开关：`PI_FLEET_AUTO_CONTINUE`（默认 on）。常量在 `extensions/lib/watch.ts`：
  `WATCH_WAIT_SLICE_MS = 5min`、`WATCH_THROTTLE_MS = 15s`。

`npm run check` 84 通过。

## P0 — 首次真跑

- [x] **T1 一个 ticket、codex、pane**：完成，两半都过校验（详见上节）。
  `/matt-pocock-skills-bootstrap` → `setup-matt-pocock-skills` →
  `herdr worktree create` → `FleetDispatch` → executor 写 `result.json` →
  `FleetHarvest` 过校验。
- [x] **T2 同一个 ticket claude review**：完成，还多跑了一轮 fix 后的复审。两轴分开报，
  claude 没有递归 spawn（它甚至自己重建代码验证测试断言是否为真）。
- [x] **T3 并发 claim / T4 坏 contract / T5 idle 宽限**：2026-10-12 真跑完成，三条全部
  按设计判定。证据在 `.scratch/fault-paths/issues/01-fault-fixture.md` 的 Comments，
  真跑另捞出两条真 bug（F1 blocked agent 复用失败、F2 失败 dispatch 留下孤儿 run 目录），
  见下面「故障路径真跑」一节。

## P1 — 环境假设（已由 T1 真跑验证）

- [x] `herdr agent start --timeout <ms>`：有效。每次 dispatch 都带 `--timeout 120000`，
  herdr 0.9.3 接受并正常启动 codex 与 claude。
- [x] `herdr tab create --workspace --label --cwd --no-focus`：有效，5 个 job 都这么开 tab。
- [x] `herdr worktree create`：语法已用（`--cwd --branch --base --no-focus
  --trust-repository`）。另发现 `herdr worktree open --path` 用于恢复被 Herdr 回收的
  workspace（见 T1 记录第 2 条）。

## P2 — 明确留到后面的

- [ ] **只想要 matt skills、不想要 fleet 的项目**：现在
  `/matt-pocock-skills-bootstrap` 依赖本包已装。
  脚本仍可单独跑（`node <pkg>/scripts/install-planning.mjs`），但没有一条不装本包的路。
- [ ] **托管 tracker**：现在只支持本地 markdown。claim 要换成一次 API 调用，其余设计不受影响。
- [ ] **wayfinder**：它的决策 ticket 会调 `research` 与 `prototype`（执行类）。要做就把这两个
  一起放进 planning，或让它走一条独立的 pane。
- [ ] **多 ticket 并发**：现在一次一 ticket 走完。跨 ticket 并发只需在同一 tab 的 exec 列继续 split
  （`TAB_FANOUT_LIMIT` 已就位），收尾顺序需要决定。
- [x] **`excluded` 里的措辞重复**：已修（ticket `manifest-exclusions/01`，commit `a3e315c`，merge `74d9391`）：26 个非 `$` 条目里重复的解释收成 `$executor-provides`(8)、`$writing-prose`(3)、`$project-scaffold`(2) 三条共享说明。
- [ ] **`excluded` 是纯文档，无人校验，也没有启用路径**：想启用某个上游 skill 时无需改代码，
  只需把它从 `excluded` 移到 `planning`，然后重跑
  `/matt-pocock-skills-bootstrap`。这条没有待做的活，只在
  真要放行某个 skill 时才动。

## P3 — 上游补丁（T1 后的结论）

- [x] **去掉 `implement` 的加载需求**：已做到。brief 完全不引用上游 `implement`，
  它的自审指令不再进入 executor。
- [ ] **给 `code-review` 提 PR**：加反递归那一行。仍值得做；本包已用自己的守卫兜住
  （review 任务里显式禁止 spawn，两轮真跑都没有递归）。
- [x] **`invocation.md` 的约定冲突**：T1 现场显示 codex 的 pane 日志写着
  "Need use tdd skill … skill exists. Must read skill file"——按名字引用可用，
  不需要 fork 上游文件。

## 下次开工入口

T1 的 ticket 02 已完成（2026-10-12）：`.scratch/manifest-exclusions/issues/01-collapse-repeated-exclusion-reasons.md`
两轮 review 后合并进 main（worktree commit `a3e315c`，merge `74d9391`），worktree 与
branch 已删除，`npm run check` 96 绿。

下一张票：`.scratch/` 下没有 `ready-for-agent` 的票。刚合入的 `.scratch/dispatch-failure-cleanup/`
两张票已 `done`；F1/F2 与它们顺手捞出的 ELOOP 崩溃点都已修完并合入（见下节）。
候选见 P2、P3，以及「已记账、未修」节。

## 故障路径真跑（2026-10-12）

用一张一次性 fixture 票（`.scratch/fault-paths/issues/01-fault-fixture.md`：在仓库根写一个
`fault-fixture.txt`）跑了三条只有单测覆盖的路径。三次判定全部在读 run 目录之前不可预测，
证据与逐条时间戳写在那张票的 Comments 里。

| 路径 | 结果 |
| --- | --- |
| T3 二次 claim | 同一票同回合再 dispatch → `ticket 01 is not claimable: its status is "claimed"`，run 目录数不变（16→16），票停在 `claimed` |
| T4 坏 contract | 444 的 `{"status":"done"}` 被首次 harvest 判定 → `result.status: must be implemented\|blocked\|failed, got "done"`，票不动 |
| T5 idle 宽限 | Esc 把 codex 按在提示符 → watcher 发过一次 nudge `continue`（pane 里可见，agent 恢复工作）→ 无 contract → 120s 后判 `contract_failed`，agent 仍活着 |

T4 顺带实测出两条行为事实：

- **判定是粘的**：executor 事后补写了合法 contract，再 harvest 仍报最初那条错。所以
  `contract_failed` 的出路只有重新 dispatch，修 `result.json` 没用。
- **`idleSince` 是采样钟**：`meta.json` 里它落在 `startedAt` 之后 348ms（首次 harvest
  见到还没开始生成的 codex），而用 Esc 压住 agent 会让后续每次采样都落在 idle 分支，
  于是那句 `120s` 是从 dispatch 起算的墙上时间，不是连续空闲 120 秒。正常跑由第一次
  `working` 采样清零（`runner.harvest`），无需改。

真跑捞出两个真 bug（本轮只跑路径、未修，下一轮修完）：

- **F1 复用 blocked agent 会整个 dispatch 失败**。`herdr agent prompt` 拒绝对处于
  approval 的 agent 发话（`agent_blocked`），而 `planPaneAction` 正是复用那个 pane。
  于是有未回答 approval 的上一轮，下一轮 fix round / 复审发不出去。报错本身也难读：
  `execFile` 的 message 把整份 task 文本（约 60 行）回显在错误里，可操作的那一行埋在中间。
- **F2 失败的 dispatch 留下孤儿 run 目录**。`mkdirSync` 与 `brief/schema/task` 三个文件
  写在 `meta.json` 之前，而 `meta.json` 只在任务送到 agent 之后才写。残留目录没有 meta，
  `readMeta` 判为 `absent`，`listJobs` 与 `listStale` 都跳过：磁盘上 17 个 run 目录，
  `FleetStatus` 只列 15 个。

两条都已在 `.scratch/dispatch-failure-cleanup/` 修完并合入，见下节。

## dispatch 失败路径的修复（2026-10-12）

`.scratch/dispatch-failure-cleanup/` 两张票，一个 commit `81fefd9`（merge `9e9e163`），
合并后在 main 跑 `npm run check`：101 通过。

| 票 | 修了什么 |
| --- | --- |
| 01 | prompt 被拒时给出可读的错误（点名 pane 与 agent、说明在等 approval、保留 Herdr 原文、435 字符、不含 task 文本）；`#call` 不再回显整份 argv（超 80 字符的参数缩成 `<argument of N characters>`）；失败 dispatch 删掉自己建的 run 目录；`FleetStatus` 把无 meta 的 run 目录报成遗留 |
| 02 | run 根的扫描不再因读不到的条目抛异常。`isDirectory()` 用 try/catch 兜任何 stat 失败，不枚举错误码：自指链接（`ELOOP`）只被跳过，旁边的可读 job 与无 meta 目录照旧 |

票 02 是因票 01 的 fix round 上限用满而开的：cap 到点后我停手问你，你选了开新票 round 0。
两张票跑在同一个 worktree、改同一批文件，事后无法拆成两个干净 commit，所以合成一个：
subject 取票 01 标题，票 02 的改动搭在里面。两票的 Comments 都记了原因。

复审轮次（都用 claude，base `main`）：票 01 三轮（用了 1、2 两轮 fix），票 02 两轮（用了 1 轮 fix）。
**每一轮 reviewer 都自己造场景验证**，三轮报出的都是上一轮修复新引入的问题：

1. 新遗留分支把 run 根每个条目都当 run 目录 → 普通文件被报成「dispatch 没跑完」。
2. 改成只认 dirent 报告的目录 → 透过符号链接到达的 run 目录消失，而 `readMeta` 还读得到。
3. 改成 `statSync` 跟随链接 → 自指链接抛 `ELOOP`，把 `runner.all()` 的所有调用方（`FleetStatus`、
   `FleetCleanup(all: true)`、dispatch 默认选执行器）一起带走。

教训：**“缩小一处误报”很容易换来一处漏报，而单测在新写的那一刻都绿。** 这三个洞全是
reviewer 用同一个 probe 在 main 与本 worktree 上对照出来的，不是读代码读出来的。

### provider 400 造成的真实 T5（同日）

票 02 第一次 dispatch（`job_02_1791818229451_g8ip`）没进到活：tierflow 对任务回
`status_code=400 任务请求不合法 (invalid_task_request)`，watcher 的 `continue` nudge 又换来
第二个 400，agent 停在提示符，121s 宽限到点判 `contract_failed`。worktree 一个文件都没动，
票停在 `claimed`，run 目录留下记录，随后按 round 0 重发成功（`job_02_1791818384402_z3er`）。

这是 T5 路径第一次**无人为干预**地触发，也是 nudge 边界的现场证据：一次 `continue` 能救回
偶发拒单的 provider，救不回持续拒单的。失败合理，但没有假 `complete`——fail-safe 按设计工作。
另外：tierflow 的配额再吃紧一次（同日第二次），换 provider 的事已记在下面「tierflow 中转诊断」节。

## ticket 02 遗留的三条非阻塞观察（2026-10-12，已修）

第三轮 review 的 spec 轴全绿（reviewer 在临时副本里破坏验证过 guard：把句子内联回条目
会失败、悬空指针会失败、改写共享解释会通过），standards 轴只剩三条风格项，不足一轮
fix round（cap 也已用满，`PI_FLEET_MAX_FIX_ROUND=2`）。三条已在主 checkout 直接清掉（commit
`5c27f53`），不走 fleet：改动只有注释、AGENTS.md 一句话和一处取值方式，dispatch 的代价
大于收益。

- [x] `test/skills.test.ts:87` 的新 guard 没有"为什么存在"的注释，而该文件其他非平凡
guard 都有（如 `:27-31`、`:42-44`）。后面改动最容易撤销的两个选择——在原始文件文本
里数出现次数、对两侧排序——正好是没被解释的那两个。已补注释，逐条说明这两个选择。
- [x] `AGENTS.md:18` 把 `$` 约定限定在 `excluded` 里，而票自己引用的先例是顶层键
（`skills/manifest.json:6` 的 `$planning`、`:19` 的 `$execution`），这一行仍未提到。
已改成：`$` 键一律是共享说明，顶层解释整张列表，`excluded` 里的条目用 $ 键当理由。
- [x] 同一个值在测试里有三种取法：`sharedReasons`、`exclusionReason`（`:83` 定义）、
以及新 guard 里的 `manifest.excluded[key]`。新 guard 改成 `exclusionReason(key)`，
现在取同一个值只有一条路。

## tierflow 中转诊断（2026-10-12）

codex 反复报 `status_code=400 任务请求不合法 (invalid_task_request)`。实测结论：

- **tierflow 是多后端路由**：同一个 `model: tierflow_pro`，小请求返回
  `Qwen3.8-Flash`，40k 与 400k 字符的请求返回 `DeepSeek-V4.1-Flash`。
- 两个端点（`/v1/responses`、`/v1/chat/completions`）本身都通，最小请求都成功，
  所以不是端点或密钥问题。
- 判断：请求被路由到对 OpenAI Responses + tool calling 支持不全的后端时被拒；
  手动 `continue` 或重发都能过——重发等于重新掷一次路由。
- 规避方向是换 provider。pi 配置里的 `sub2api-openai`（`gpt-6-luna` @
  `http://192.168.5.5:8080/v1`）实测是原生 Responses 端点，其响应自带
  `instructions: "You are Codex, a coding agent based on GPT-5…"`。

## fix round 复用同一 executor（2026-10-12）
`planPaneAction` 的 exec 分支不再堆叠新 pane：一个 ticket 一个 executor pane，fix round
re-prompt 首轮的 executor（`exec[0]`），保留它自己的 context。`occupancyOf` 改为按 pane
去重（同一 pane 现在会被多个 job 指向），`TAB_FANOUT_LIMIT` 随堆叠行为一起删除。
提交 `f2c305e`，`npm run check` 90 通过。

## agent 与 tab 命名（2026-10-12）

`fleet-01-4myt` 与 `fleet: 01` 对看侧边栏的人没有信息量。现在：

- **agent**：`<role>-<ticket id>`，例 `implement-01`、`reviewer-01`（role `review` 写成
  `reviewer`）。
- **tab label**：`<nn> <标题>`。Herdr 按侧边栏宽度截断 label，票号在前才能活下来；
  复用来的 tab（`herdr worktree create` 自带的第一个 tab 叫 `1`）也会被 rename 成票名。
- fix round 复用同一 executor，所以一个 ticket 每个 role 只有一个 agent 名。

提交 `7edfa08`、`39629ea`、`938a1d0`，`npm run check` 95 通过。

## pane 复用、nudge 与 watcher 生命周期（2026-10-12）

- **worktree 自带的 tab 不再空着**：`herdr worktree create` 开 workspace 时自带一个 tab
  （label 是 `1`）。以前本包再 `tab create` 一个，第一个就永远空着。现在 `#place` 先看该
  workspace 的第一个 pane，空闲就直接在上面 `agent start`，被占用或不存在才新建
  （`39629ea`）。
- **provider 拒单自动续跑**：tierflow 偶发 400 会让 codex 停在提示符，idle grace 一到
  job 就被判 `contract_failed`——人手来不及回。watcher 现在在 agent idle 满 15 秒且没有
  contract 时替人发 `continue`，最多 3 次（`39629ea`）。
- **watcher 跟着 session 走**：watcher 在 `session_start` 接管未结算的 job、在
  `session_shutdown` 清空，唤醒那一步加了保护。否则 `/reload` 之后旧 watcher 拿着失效的
  `pi` 抛异常，异常落在无人接管的 async 循环里（`938a1d0`）。smoke 建的是 headless
  session，所以它在读设置的那次 reload 之前就把 watcher 关掉。
