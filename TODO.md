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
| `.fleet/`（旧架构 10 个 run 目录、5 份契约） | 删除 |
| `session.jsonl`（根目录 1.1MB 会话日志） | 删除 |
| `PI_FLEET_RUNS_DIR` 默认值 | `.fleet/runs` → `.pi/fleet/runs` |
| run 目录的 gitignore | 重建 `preflight.ts`：派发前把 `.pi/fleet/` 写进项目 `.gitignore` |
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
（`.pi/settings.json` 与 manifest），抓的是"改了 manifest 但忘了重跑 `/fleet-setup`"。

## 关键转折：本包不再发布任何上游 skill

起因是一个反问：**codex 和 claude 都装了完整的 matt skills，为什么还要在 pi 里找？**

查证后我原来的理由只成立一条，而那条可以绕开：

| skill | codex | claude | 结论 |
| --- | --- | --- | --- |
| `implement` | `allow_implicit_invocation: false` | `disable-model-invocation: true` | 执行器看不到它 |
| `tdd`、`code-review` | 模型可自主加载 | 无该标记 | 执行器能自己拿到 |

于是"给绝对路径"反而制造了新问题：

1. **双份加载。** `tdd`/`code-review` 是模型可自主加载的。我们的任务文本本身就足以触发执行器加载**它自己那份**，而我们又额外塞了路径 → 一个 skill 的两份指令同时进上下文。
2. **版本不同。** codex 装 1.3.1、claude 装 1.2.3，实测 `code-review` 差 4 处（claude 那份还缺"两个 sub-agent 同时发起"那一句）。
3. **`implement` 净贡献为零。** 六条指令里五条我们已有更可靠的实现（brief 拷票、契约强制报真实测试数、task 说提交），第六条"自审"正是我们要移除的。

**所以最终形态**：本包只发一个自己的 skill（`fleet`）。planning 装上游到项目里（要最新），execution 靠执行器自己的安装（按**名字**引用，不给路径），而真正需要保证的东西——两轴定义、反递归、输出格式——收进 `brief.ts` 的文本里。

那三样本来就该是我们的事：上游至今没修反递归（两边装的都是 0 处命中），而上游输出的是散文，不是我们的契约。

## 已定边界


| 决定 | 选择 | 理由 |
| --- | --- | --- |
| planning 从哪来 | 项目级装上游 + settings 过滤 | 要最新；票格式变了会在 claim 时大声失败 |
| execution 从哪来 | 执行器自己的安装，按名字引用 | 按路径给会造成双份加载与版本打架；真正要保证的三样收进 brief 文本 |
| 谁当 fleet | pi 逐票派发 | `implement-spec` 自己起 subagent 加 worktree 加 frontier，两个 orchestrator 抢分支 |
| 票的写入权 | 只有 `Status:` 一行归扩展 | 认领是并发问题，并发问题归代码 |
| 执行器看不看得到票 | 看不到 | brief 拷票正文，未提交的票在工作树里也可见 |
| 交付形态 | 只有 pane，无降级 | worktree 的 git 元数据在工作树之外，sandbox 写不了 |
| 上限在哪 | 工具里 | fix 轮上限与认领都不能交给模型裁量 |
| git 拦截 | 保留自研，不装 matt 的 guardrail | 两者零交集：matt 拦 push/reset/clean 且只在 claude 侧，stash 与 amend 无人管 |

## 已记账、未修（不阻塞 T1）

- [ ] **`smoke/load.ts` 只打印不判定。** 实测：给 `extensions/index.ts` 尾部加一句
  `throw new Error("BOOM")`，`npm run smoke` 仍退出 0。它唯一设置退出码 1 的地方是
  "`skills/planning` 或 `skills/execution` 目录存在"，而扩展是否加载、四个工具是否注册、
  `fleet` skill 是否读进来，全都只是 `console.log`。它 docstring 写着 "Two claims are
  checked"，实际只检查了半个。
  另一个毛病：`extension.path.includes("pi-fleet")` 用来认"自己"会认错。那次实测里，
  本机全局 pi 配置指向的副本先注册成功，把被测入口的加载失败盖住了——所以
  `active tools` 才全显示 `true`。
  修法：按传入的 `entry` 路径认自己；加三条断言（本入口的 loader 无错误、四个工具都在
  `getActiveToolNames()` 里、`fleet` skill 加载成功）。
- [ ] **`.github/workflows/check.yml` 从未运行。** `git remote` 是空的，仓库没推送过，
  只有一个提交者，所以它今天价值为零，激活条件是推上 GitHub。修完上面那条之后它才有
  实际意义：CI 跑的是新鲜克隆，没有本机全局配置可以掩盖失败。**先做 T1，之后再决定留删。**

## T1 真跑记录（完成）

- **implement**：codex，`job_01_1791733796513_9lr8`，契约 `complete`；commit
  `5f202eb fix(smoke): judge the loaded entry and its tools`（重构 `smoke/load.ts`，
  新增 `test/smoke.test.ts`）；契约自报 `npm run check` 84 通过。
- **review**：claude，`job_01_1791735031901_7554`，契约 `complete`，两轴分开报，无递归
  spawn。它自己把 `smoke/load.ts` 改回 `includes("pi-fleet")` 重跑测试，证明了新测试
  抓不住那条验收。两轴各一条 blocker：
  - standards：`test/smoke.test.ts` 把真实 pi loader 与 session 拉进 `npm run test`
    （每例一次，共 5 次），与 AGENTS.md 把 loader 检查放在 `npm run smoke` 的分工冲突；
    `smoke/load.ts` 还算了一遍包根，而 `extensions/lib/skills.ts` 已导出 `PACKAGE_ROOT`。
  - spec：票的第二条验收（按传入 entry 路径归因）没有被测试钉住：改回 substring 匹配后，
    `node --test test/smoke.test.ts` 仍然 5 pass。脚本本身是对的，测试没锁住它。
- **fix round 1**：codex，`job_01_1791736483799_3viw`，契约 `complete`；把 smoke 判定抽成
  `extensions/lib/smoke.ts` 纯函数，`npm run check` 84 通过（未提交——新流程首次验证成功）。
- **第二次 review**：claude，`job_01_1791736945041_7yvq`，契约 `complete`。spec 全过：
  reviewer 重建了三个坏副本逐个验证 `exit 1`。standards 一条保留意见：集成测试被换成
  纯函数测试，坏树路径不再有回归守卫。判定不阻塞（判定分支有单测，健康树由
  `npm run smoke` 每次端到端跑），理由记在票的 Comments 里。
- **pi 提交**：`3977960 fix(smoke): make the smoke decision a pure function`（在 `5f202eb` 之上）。
  票 `Status: done`，5 个 settled job 的 tab 已 cleanup。

真跑暴露的三件事，前两件当场修掉：

| # | 现象 | 处理 |
| --- | --- | --- |
| 1 | 会话里跑的是 18:08 加载的旧扩展，磁盘上已删的 vendored execution 检查仍拒绝 dispatch | 与代码无关，`/reload` 后消失。教训：改扩展后不 reload，现场就是旧内存 |
| 2 | `FleetCleanup` 关掉 worktree 最后一个 tab 后 Herdr 回收整个空 workspace；再次派发时 `runner.ts#workspaceFor` 回退到 `HERDR_WORKSPACE_ID`，pane 静默落进主会话 workspace | **已修**：删掉回退，改为 `herdr worktree open --path`（幂等）自愈，失败才拒绝；新增 2 个 runner 测试 + 1 个 herdr 测试；SKILL 与两个工具描述同步 |
| 3 | `skills/fleet/SKILL.md` 步骤 5 要求把票设成 `done` 再派 review，而 `claimTicket` 只接受 `ready-for-agent`，review 必然被拒 | **已修**：步骤 5 改为把票设回 `ready-for-agent` 并记录 branch；`done` 移到 review 无阻塞之后；fix round 同样先设回 |

环境侧（不是本包的 bug）：codex 默认 provider 的 `/v1/responses` 返回 404，
claude 报 `unrecognized_model: tierflow_pro[1m]` 但仍出结果；用户重配后两条通道的
最小探针都通过。

## 流程变更：执行器不提交，review 通过后由 pi 提交

用户定下的流程，已落地到代码与技能文档：

1. 执行器只改工作树，**不提交**。
2. review 看的是**未提交的工作树**。pi 派发前先 `git -C <worktree> add -A`，
   否则 `git diff` 看不到新文件。
3. review 无阻塞 → pi 自己 `git commit`（conventional commit，subject 取票标题），
   再把票设 `done` 并记下 branch 与 sha。
4. review 有阻塞 → 票设回 `ready-for-agent` → codex 在同一未提交工作树上改 →
   重新 review。轮数上限照旧（`PI_FLEET_MAX_FIX_ROUND`，默认 2）。
5. 派发文本不再一刀切禁止子代理（implement 侧删除该禁令）；review 侧保留反递归
   守卫，因为“不能无限循环”正是它要防的事故。

改动文件：`brief.ts`（规则与 review 输入）、`contract.ts`（implement schema 删除
`commits`，改为显式拒绝该字段）、`index.ts`（工具描述）、`skills/fleet/SKILL.md`
（步骤 5–7）、`README.md`，以及 brief/contract/runner 三套测试。`npm run check` 81
通过。

**注意**：当前会话的扩展是旧内存，需 `/reload` 后新流程才生效。T1 的 codex 已经
提交了（旧流程产物），所以 T1 不需要 pi 补提交；新流程从下一张票开始。

## 自动衔接：job settle 即唤醒会话（已实现，待 /reload）

用户要求“codex 执行完毕后直接 claude review”，不要等人输入。pi 提供
`pi.sendUserMessage()`（文档：always triggers a turn），这就是缺失的钩子。

实现（第二轮改为信号驱动）：

- **等 Herdr 的状态信号，不轮询**：`runner.waitAgent()` 调 `herdr agent wait <name>
  --timeout 300000`，agent 状态一变就返回。Herdr 没有事件订阅命令（`herdr api` 只有
  拉取式 `snapshot`/`schema`），`agent wait` 就是它的状态通知机制。
- 醒来后用 `runner.harvest()` 判定；`running` 就节流 15 秒再等，避开“agent 已 settled
  但契约未写”引起的空转。**契约文件仍是唯一成功判据**，Herdr 的 idle/done 仍只表示
  ready for input。
- settle 后用 `pi.sendUserMessage()`（pi 文档：always triggers a turn，
  `deliverAs: "followUp"`）唤醒会话，消息只说“某 job settled，去 FleetHarvest”，不搬运
  契约内容。
- 扩展加载时扫描 `runner.all()` 里未 settle 的 job 并接管：`/reload` 或重启后，旧 job
  完成也会唤醒。手动 harvest 同一个 job 会注销 watcher，避免多唤一次。
- 开关：`PI_FLEET_AUTO_CONTINUE`（默认 on）。常量在 `extensions/lib/watch.ts`：
  `WATCH_WAIT_SLICE_MS = 5min`、`WATCH_THROTTLE_MS = 15s`。

`npm run check` 84 通过。

## P0 — 首次真跑

- [x] **T1 一张票、codex、pane**：完成，两半都过校验（详见上节）。
  `/fleet-setup` → `setup-matt-pocock-skills` → `herdr worktree create` →
  `FleetDispatch` → 执行器写 `result.json` → `FleetHarvest` 过校验。
- [x] **T2 同票 claude review**：完成，还多跑了一轮 fix 后的复审。两轴分开报，
  claude 没有递归 spawn（它甚至自己重建代码验证测试断言是否为真）。
- [ ] **T3 并发认领 / T4 坏契约 / T5 idle 宽限**：故障路径，单测已覆盖
  （`claimTicket` 二次认领、契约字段校验、idle grace），真跑未做。低优先。

## P1 — 环境假设（已由 T1 真跑验证）

- [x] `herdr agent start --timeout <ms>`：有效。每次 dispatch 都带 `--timeout 120000`，
  herdr 0.9.3 接受并正常启动 codex 与 claude。
- [x] `herdr tab create --workspace --label --cwd --no-focus`：有效，5 个 job 都这么开 tab。
- [x] `herdr worktree create`：语法已用（`--cwd --branch --base --no-focus
  --trust-repository`）。另发现 `herdr worktree open --path` 用于恢复被 Herdr 回收的
  workspace（见 T1 记录第 2 条）。

## P2 — 明确留到后面的

- [ ] **只想要 matt skills、不想要 fleet 的项目**：现在 `/fleet-setup` 依赖本包已装。
  脚本仍可单独跑（`node <pkg>/scripts/install-planning.mjs`），但没有一条不装本包的路。
- [ ] **托管 tracker**：现在只支持本地 markdown。认领要换成一次 API 调用，其余设计不受影响。
- [ ] **wayfinder**：它的决策票会调 `research` 与 `prototype`（执行类）。要做就把这两个
  一起放进 planning，或让它走一条独立的 pane。
- [ ] **多票并发**：现在一次一票走完。跨票并发只需在同一 tab 的 exec 列继续 split
  （`TAB_FANOUT_LIMIT` 已就位），收尾顺序需要决定。
- [ ] **`excluded` 里的 25 条全是文档，无人校验**：理由写在 `skills/manifest.json`。
  其中 7 条（`codebase-design`、`diagnosing-bugs`、`improve-codebase-architecture`、`pr`、
  `prototype`、`research`、`retro`、`wizard`）措辞完全相同，只为满足旧的"清单必须穷尽"
  检查而存在。那个检查已删，这几条可以合并成一条说明。哪个想启用就改分类并重跑
  `/fleet-setup`。

## P3 — 上游补丁（T1 后的结论）

- [x] **去掉 `implement` 的加载需求**：已做到。brief 完全不引用上游 `implement`，
  它的自审指令不再进入执行器。
- [ ] **给 `code-review` 提 PR**：加反递归那一行。仍值得做；本包已用自己的守卫兜住
  （review 任务里显式禁止 spawn，两轮真跑都没有递归）。
- [x] **`invocation.md` 的约定冲突**：T1 现场显示 codex 的 pane 日志写着
  "Need use tdd skill … skill exists. Must read skill file"——按名字引用可用，
  不需要 fork 上游文件。

## 下次开工入口

先提交主仓库的改动（新流程、watcher、workspace 修复），再 `/reload` 让 watcher 生效。
然后用**第二张票**做一次全自动链路真跑：dispatch 之后不动键盘，验证
wait 信号 → harvest → review → pi 提交 一路自己走完。票的内容从 P2 里挑一个小的，
或由用户指定。
