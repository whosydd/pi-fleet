# TODO：跨会话任务计划

> 代码在本仓库（`af91d5f`，`npm run check` 全绿）。工作流移植的目标仓库是
> `../pi-mattpocock-skills`（空仓库，等 skills 装好后再起内容）。每个条目标明落点。

## 已定边界

代码边界见 `AGENTS.md` 的 Invariants（执行器自治、契约唯一成功信号、Jev
advisory、磁盘为准），本文件不复述。已移出清单的决定见文末。

## 环境版本（#15 验证对象）

- `codex-cli 0.162.1`：`--output-schema` + `-o` 写契约文件
- `claude 2.1.287`：`-p --output-format json --json-schema` 出 `structured_output`
- Jev 通道：`typesafe/jev-latest` 正常；`opencode/jev-1.13` 402 欠费、
  `jev-1.13-free` 451 不可用

---

## P0 — 前置验证

- [ ] **#15 真票端到端验证**（本仓库）
  范围：选一张真实小票，走 `git worktree add` → `FleetDispatch` → `FleetHarvest`，
  codex 与 claude 各跑一次。
  验收标准：codex 的 `-o/--output-schema` 确实把契约 JSON 写进 `result.json`；
  claude 的 `--json-schema` 确实在 stdout 给出 `structured_output` 且收割能过
  契约校验；gate 与 triage 在真实 brief 和真实 findings 上行为正确。
  依赖：无。这一项不过，后面所有改动都缺乏回归基线。
  风险：`claude -p` 在用户自己的权限配置下可能拒绝跑测试（pi 不干预权限），届时
  改执行器侧配置，不是 argv。

## P1 — 编排闭环

- [ ] **#16 frontier 暴露给模型**（本仓库）
  范围：`FleetStatus` 增加可选 `tickets` 参数，返回 `ready` / `waiting` / `errors`。
  `lib/frontier.ts` 目前是纯函数，模型调不到它。
  验收标准：传入带 blocking 边的票图，拿到与 to-tickets 声明一致的 ready 集；
  环与未知依赖以字符串报告，不抛异常。
  依赖：#15。

- [ ] **#17 执行器完成通知**（本仓库）
  范围：`supervise.ts` 的 exit handler 接上通知回调。TUI/RPC 用 `ctx.ui.notify`，
  无头场景用 `herdr notification show <title> --sound done`。
  验收标准：派发后本轮结束，执行器退出时人能被提醒；pi 不在前台时不留静默。
  依赖：#15。这是当前最大的体验缺口（收割只发生在用户 ping 时）。

## P2 — 工作流地基

- [ ] **#18 双侧安装 skills**（目标：`~/.agents/skills/` 与执行器侧目录）
  pi 侧：`npx skills add mattpocock/skills -a pi`，只取对话与规划类
  （grilling、grill-me、wait-what、to-questionnaire、ask-matt、wayfinder、to-spec、
  to-tickets、triage、retro、teach、handoff、writing-for-agents、loop-me）。
  执行器侧：取执行类（implement、implement-spec、tdd、code-review、pr、
  diagnosing-bugs、prototype、domain-modeling、codebase-design、
  improve-codebase-architecture、setup-matt-pocock-skills）。
  验收标准：claude 侧注意内置 `/code-review` 撞名——插件安装带 `mattpocock-skills:`
  前缀，本地文件安装则副本遮蔽内置；评审侧按最小集合装。
  依赖：无。

- [ ] **#19 跑 `/setup-matt-pocock-skills`**
  范围：一次配置 tracker、triage 标签、文档位置，配置写进仓库。
  验收标准：两个 harness 读同一份配置。
  依赖：#18。

- [ ] **#20 pi 侧 AGENTS.md 规则集**（目标：`~/.pi/agent/AGENTS.md` 或项目级）
  范围：委派边界规则已入队（待用 `/agents-md` 确认写入）；还需补 fleet 节拍规则——
  长任务派发即返回、收割在下一次用户消息、不轮询、不假设推送通知。
  验收标准：规则可验证，不写成愿望。
  依赖：#15。

- [ ] **#21 implement-spec 外层循环规则化**（目标：`../pi-mattpocock-skills`，新建
  pi 侧 skill）
  范围：把外层循环写成 pi 的节拍——读票图 → 每票建 worktree → 派发 → 收割 →
  关票 → 重算 frontier → 全部完成后独立派发 review → blocker 级 findings 才起
  fix round（上限 2，超限升级给人）→ 清理 worktree。
  内层（tdd、契约自报）留在执行器侧，靠 `skill_pointer` 指向 SKILL.md 路径。
  验收标准：跑通一张两票、带 blocking 边的规格。
  依赖：#16、#17、#19。

## P3 — 加固与小项

- [ ] **#22 pi 侧危险 git 拦截**（本仓库）
  范围：`user_bash` handler 拦 `git stash`、`git commit --amend`、force push。
  依据：上游文档记录的事故现场——`refs/stash` 跨 worktree 共享，worktree 隔离不住它。
  验收标准：拦截时给出原因与替代命令，不是静默失败。
  依赖：无。

- [ ] **#23 小项打包**（本仓库）
  gate 的 classify usage 附进 dispatch 结果；`test/plan.test.ts` 补 claude implement
  的 argv 正向断言（`-p`、`--output-format`、`--json-schema`）；`.fleet/` 在首次
  派发时自动写入项目 `.gitignore`。
  依赖：无。

---

## 已移出清单的决定

| 项 | 原因 |
| --- | --- |
| 执行器 cost 统计 | 边界：花费由执行器自记。 |
| `claude-handoff` 改写 | 依赖 `claude --bg`；如需要可用 `pi --print ... &`，出现真实需求再说。 |
| chief-of-staff 的 schedules | pi 无 scheduler 原语，上游 skill 自己也写了 "Harness-permitting"。 |
| 子代理等待桥 | pi-subagents 已禁用，且 one-shot 派发不需要它。 |

## 下次开工入口

从 **#15** 开始。它决定 #16/#17 的改动是否安全，也决定 #20 的规则该写什么。
