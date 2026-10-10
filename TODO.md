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
- 两个执行器共用同一个 tierflow token（`~/.codex/config.toml` 的
  `experimental_bearer_token` 与 `~/.claude/settings.json` 的
  `ANTHROPIC_AUTH_TOKEN` 同值）。`codex login status` 报 Not logged in 是噪音：
  该配置不走 ChatGPT 登录。
- **额度阻塞**：tierflow 返回 `403 订阅额度不足: subscription quota
  insufficient, bucket=basic`（codex need=6889、claude need=6272）。codex 与
  claude 同时不可用，#15 的执行器腿需要额度恢复后补跑。

---

## P0 — 前置验证

- [x] **#15 真票端到端验证**（本仓库）—— codex 腿已过，剩 claude 腿并入 #3
  范围：选一张真实小票，走 `git worktree add` → `FleetDispatch` → `FleetHarvest`，
  codex 与 claude 各跑一次。
  验收标准：交互模式下执行器自己把契约 JSON 写进 run dir 的 `result.json` 且收割
  能过校验；one-shot 模式下 codex 的 `-o` 能写到工作区之外；claude 的
  `--json-schema` 在 stdout 给出 `structured_output`；gate 与 triage 在真实 brief
  和真实 findings 上行为正确。
  依赖：无。这一项不过，后面所有改动都缺乏回归基线。
  注：p23 的 worktree 位置是手工 `git worktree add` 的遗产（在 pi 仓库树内）；
  新票一律 `herdr worktree create`（落 `~/.herdr/worktrees/<repo>/<branch>`，
  自带 workspace），别再手摆路径。
  风险：`claude -p` 在用户自己的权限配置下可能拒绝跑测试（pi 不干预权限），届时
  改执行器侧配置，不是 argv。

  2026-10-10 现场（真票 = #23 的 `.gitignore` 项，worktree
  `/Users/gy/Code/pi/.worktrees/p23`，分支 `fleet/p23-gitignore`，编排会话用
  `pi -p -e extensions/index.ts` 起）：

  - 已过：worktree 预检、gate（真 brief → entry 0.98 / acceptance 0.85 / scope
    0.99 → pass，走 pi 自带 registry，无额外凭据）、spawn 与 detached meta.json
    落盘、跨会话收割（新 session `loadFromDisk` 认出 job，报 failed + exit code +
    stderr 路径）。
  - **codex 腿已过（2026-10-10，交互模式）**：`herdr worktree open` 给 p23 开
    workspace w29 → `FleetDispatch` 起 codex TUI（agent
    `fleet-23-gitignore-nmct`，pane w29:p4）→ `agent prompt` 递 brief → 中途
    `blocked` 等人工批 `git add && git commit`（sandbox 不写 worktree 外的 git
    元数据）→ 人批准后提交 `0ec6663` → codex 自己写 result.json → FleetHarvest
    **contract_complete**（工作树 `npm run check` 52 pass 基线自洽）。
  - gate 反向证据（同日，pane 演示现场）：一张把入口点写成“仓库根目录”的 brief
    被判 entry 0.64 / acceptance 0.98 / scope 0.99 → 拒派，并点名缺哪一维；
    改成列出具体文件与命令后过线。阈值 0.7 在真话上分得开薄与厚。
  - 已修：run-dir 根目录是相对路径，编排者按主仓库解析、执行器按 worktree 解析，
    codex 0.6 秒退出并报 `Failed to read output schema file ... No such file or
    directory`。`48d7fe3` 把根目录解析成绝对路径。
  - claude 腿已过（同日，评审任务走 detached spawn）：`--json-schema` 在 stdout
    给出 `structured_output`，收割过校验；triage 在真 findings 上跑了第一轮
    （1 blocker + 6 待人工）。遗留小病：triage 文案里 style 计数为 -1，查
    judgments.ts 的计数。
  - 未过：交互模式下的 claude（评审那次是 agent start 被自伤超时杀掉后退回的
    one-shot；修完 `agentStartMs` 已能起，见 #27）。
  - **sandbox 问题已答**：codex 的 `-o` 能写到执行器工作区之外（实测
    `/tmp/pf2/probe/result.json` 写出了内容）。`--output-schema` 读工作区外文件
    也已实测可行。但 `--output-schema` **不硬约束最终消息**：provider 403 时
    codex 仍 exit 0 且 `-o` 里是散文——契约靠本扩展自己校验，不靠那个 flag。
    （`JobMeta` 里的 `diskPath` 与 `resultSource` 字段是早期设计的遗留，代码
    目前未使用。）
  - 试金石场子已备好，补跑直接用：worktree `/Users/gy/Code/pi/.worktrees/p23`（分支
    `fleet/p23-gitignore`，`node_modules` 是指向主仓库的符号链接），brief 在
    `/tmp/p23-brief.md`（重启会没，下文四项要求照旧重写即可）。

## P1 — 编排闭环

- [x] **#30 契约的 ticket 与作业的 ticket 不比对**（本仓库）—— 已落地
  现场：票号 `23-gitignore`，codex 契约写 `ticket: "#23"`，`validateContract` 只查
  「非空字符串」，照样 `contract_complete`。编排者据契约判断「这张票做完了」时读的
  是执行器自己抄的字符串。
  范围：`contract.ts` 增加 ticket 一致性判定（规范化后比较：去 `#`、去空白、大小写
  不敏感），不一致 → `contract_failed`，错误文案点明两个值。判定留在纯函数里，
  `validateContract` 签名增加 expected ticket。
  验收：`test/contract.test.ts` 覆盖一致/`#23` vs `23`/完全不同三例；真跑一次确认
  误伤率为零（执行器爱写 `#42`，这不是失败）。
  依赖：无。

- [x] **#31 triage 文案里 style 计数可能是负数**（本仓库）—— 已落地
  现场：真 findings 第一轮 triage 输出「1 blocker、6 待人工确认」，style 计数显示
  `-1`。算式是 `total - blockers - uncertain`，而 uncertain 与 blocker 可以重叠
  （一个 verdict 既 blocker 又低置信），于是被减两次。
  范围：`extensions/index.ts` 的 triageNote 计数改成按互斥集合算，或直接分别报
  「blockers / style / ignore / uncertain」四个数不相加。
  验收：把算式抽成 `judgments.ts` 的纯函数 `summarizeTriage(records)`，测试覆盖
  blocker∩uncertain 重叠例。
  依赖：无。
- [x] **#28 票内 pane 布局：左执行、右评审**（本仓库）—— 已落地 `29baa9a`
  范围：tab 仍按票分。票 tab 左侧是执行区（codex，可按并发 split 多个 pane），
  右侧固定一格评审区（claude，一轮评审一个 pane，跨 fix 轮不关，人随时能看）。
  `panes.ts` 新增纯函数 `ticketLayout(jobs)`：输入票内活跃 job（角色+序号），
  输出每个 job 的 pane 动作（reuse/split left/split right/new tab）；
  `#jobPane` 改按角色取位。评审 pane 复用规则与 #29 的循环绑定。
  验收：`test/panes.test.ts` 补布局用例（0/1/多执行 job、并发评审轮）；fake herdr
  断言 split 方向与 pane 归属。
  依赖：无（#29 依赖本项的评审 pane 复用）。

- [x] **#29 票内自动评审循环：implement → review → fix → …**（本仓库）—— 已落地 `51441e8` + `20bc2ac` + `3e55cd8`
  进展：决策已落地 `extensions/lib/loop.ts`（纯函数 `nextStep` + `blockerFindings`，
  `test/loop.test.ts` 7 项全绿）。未接的是接线：`index.ts` 的 `onSettled` 目前只做 ping，
  需要在那里 harvest → nextStep → 自动派下一步；review job 的 base 取自 implement 契约的
  branch/commits；fix 轮 brief 由 blocker findings 文本组装；循环开关 `PI_FLEET_LOOP`。
  范围：循环不经模型，事件驱动挂在 `onSettled`：
  implement 契约过 → 自动派 review（claude，同 worktree，brief 带 base 与 diff 范围）；
  review 契约 `blockers>0` → 自动派 fix 轮（codex，brief 由 findings 组装，
  `fix_round: N+1`，跳过 brief gate）；收敛条件 = review 契约零 blocker（style/
  human-confirm 项不触发循环，只进 ledger）；`PI_FLEET_MAX_FIX_ROUND` 到帽 → 状态
  `escalated` + ping 人，不再自动派。每步失败降级为 note + ping 人，永不静默死循环。
  验收：fake herdr 走通 implement→review→fix→review→done 全链与到帽升级两条路；
  真票跑一轮（现成 findings：preflight catch 无测试、#23 仅交付 1/3 项）。
  分类一律走 Jev 通道（judgments.ts 现有 classify 用法之上）：blocker 还是 style、
  findings 是否值得起一轮 fix、派发/收割该报告给人还是自己消化——都是概率判断，不
  让编排模型逐条读散文。通道失败或读数缺失 → 降级 note + ping 人，绝不因此阻塞循环
  （invariant：判断永远是 advisory and degradable）。
  依赖：#28。
  落地证据（stand-in 执行器，零额度）：派一张 implement 票 → codex 契约过 →
  链**自己**派了 claude/review（模型没参与，日志里两个 job，第二个 id 是链造的）→
  评审契约过 → 链收敛并 ping「loop closed」。帽由 `PI_FLEET_MAX_FIX_ROUND`（plan.ts）
  与每票 6 次链内派发（index.ts `CHAIN_DISPATCH_BUDGET`）两道兜住；
  `PI_FLEET_LOOP=off` 交回手动。
  **这轮抓出的 P0**：`settle()` 先读 result.json，claude 一次性任务从不写那个文件
  （契约在 stdout 信封里），ENOENT 的 catch 提前返回，导致 `parseClaudeStdout`
  分支不可达——过去任何一次 claude spawn 都不可能通过契约校验。`20bc2ac` 修，
  `test/supervise.test.ts` 补回归（#15 的 claude 腿此前从未真验，正是缺这条测试）。

- [x] **#16 frontier 暴露给模型**（本仓库）—— 已落地
  范围：`FleetStatus` 增加可选 `tickets` 参数，返回 `ready` / `waiting` / `errors`。
  `lib/frontier.ts` 目前是纯函数，模型调不到它。
  验收标准：传入带 blocking 边的票图，拿到与 to-tickets 声明一致的 ready 集；
  环与未知依赖以字符串报告，不抛异常。
  依赖：#15。
  落地：`FleetStatus { tickets? }` 收整个票图，回 ready / waiting / errors；
  报告文本与 summary 都在 `frontier.ts` 的纯函数 `reportFrontier` 里生成，
  所以 ready 集与「未知 blocker 让该票两头都不出现」这件事实有测试而没有会话
  （`test/frontier.test.ts` 补三例：正常图、空 frontier 写 `(none)`、环以字符串回）。
  index.ts 只做一次调用。

- [x] **#26 执行器跑在可见的 Herdr pane 里**（本仓库）—— 已落地
  范围：`PI_FLEET_PANES=auto`（`HERDR_ENV=1` 即开）下，`FleetDispatch` 在
  worktree 所属 workspace 里 `herdr tab create` 开一个 tab，跑 `run.sh`；
  `run.sh` 把 stdout/stderr 各自 `tee` 进日志与 pane，记 `pid`，结束时写
  `exit_code`。pane 里默认 shell 是 fish，所以发给 pane 的只有一条
  `bash <abs>/run.sh`，所有 shell 语义留在脚本里。执行器退出后 tab 不关，人
  在里面看输出与文件改动；`FleetCleanup { job_id?, all? }` 只关本扩展建的 tab，
  running 的 job 拒绝关，worktree 与 workspace 永不自动关。
  降级：无 herdr / 反查不到 workspace / CLI 报错 → 退回静默 spawn，并在 dispatch
  结果里写明原因。观测通道永远不能阻塞派发。
  验收：`test/panes.test.ts` 11 项（fake herdr 走真 bash 跑真 run.sh，日志/pid/
  exit_code 落盘）；真会话验一次（stand-in 执行器，不等额度）。
  2026-10-10 真会话验过（`PI_FLEET_CODEX_BIN` 指到 stand-in，不花额度）：
  `herdr worktree create` 开 w26 → FleetDispatch 在 w26:t2 开 tab → pane 里
  实时看到执行器输出 → 跑完 tab 不关，worktree 里的 commit 留着可查 → 另一个
  headless 会话从磁盘认回 job 并判成 contract_complete → FleetCleanup all 只关掉
  w26:t2，w26:t1 和 worktree 不动。演示现场已清（worktree + 分支 + 临时 state 目录）。
  仍未验：pane 里真 codex 的 `-o` 能否写在执行器工作区之外（stand-in 绕过了
  sandbox），归 #15。
  依赖：无。本轮需求：用户要看到 codex 在干什么，不要黑箱。
  已被 #27 取代：pane 里跑 `codex exec` 可看不可插，用户明确要能交互，
  run.sh / `bash <abs>/run.sh` 那一套已拆掉（代码在 git 历史里）。

- [x] **#27 交互模式：执行器跑成可见可插的 TUI**（本仓库）—— 已落地 `3eb6240`
  范围：有 herdr 时 `FleetDispatch` 默认在 worktree 所属 workspace 里
  `herdr tab create`（一票一 tab，后续 job `pane split`，超 3 个开新 tab）→
  `herdr agent start <name> --kind codex|claude --pane <id>` 起真 TUI →
  `herdr agent prompt` 递任务。人能切进 pane 看、能回答、能 Esc 打断。
  完成信号不变：契约 = 执行器自己写进 run dir 的 `result.json`。herdr 的
  `idle`/`done` 只表示可接输入，不表示做完，所以空闲无契约 = `contract_failed`；
  `blocked` = 在等人，harvest 明说。pane 转录不解析（soft wrap 加 TUI chrome，
  实测只能读回输入框）。
  降级：herdr 不可用 / 反查不到 workspace / agent 起不来 → 退回 one-shot
  detached spawn 并写明原因；`PI_FLEET_PANES=off` 直接要这一形态（#21 的 AFK
  批量外层靠它，one-shot argv 不需终端）。
  验收：`test/panes.test.ts` 13 项（fake herdr 认 agent start/prompt/get/wait、
  pane split、契约文件、idle/blocked/gone/散文四态）；真 codex 真票跑通（见 #15）。
  依赖：#26。

- [x] **#17 执行器完成通知**（本仓库）—— 已落地
  范围：`supervise.ts` 的 exit handler 接上通知回调。TUI/RPC 用 `ctx.ui.notify`，
  无头场景用 `herdr notification show <title> --sound done`。
  验收标准：派发后本轮结束，执行器退出时人能被提醒；pi 不在前台时不留静默。
  依赖：无（#26 已把可见性解决；剩下的只是“好了叫我”）。pane 模式下通知可以从
  `exit_code` 落盘触发，不依赖 child handle。
  落地形态：交互 job 由后台 `herdr agent wait` 看门进程触发 ping（agent 一停下
  就提醒，不管是在等人还是做完了）；spawn job 由 exit handler 回调。有 UI 走
  `ctx.ui.notify`，无头时走 `supervisor.notify()` 的 herdr 通道。一个 job 只弹
  一次，文案只报状态或退出码并指向收割，不声称契约过了。`PI_FLEET_NOTIFY=off`
  全关。

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
  范围：把外层循环写成 pi 的节拍——读票图 → 每票 `herdr worktree create`（一个
  worktree 一个 workspace，#26 的 pane 直接开在里面）→ 派发 → 收割 →
  关票 → 重算 frontier → 全部完成后独立派发 review → blocker 级 findings 才起
  fix round（上限 2，超限升级给人）→ `FleetCleanup all` 关 tab → 清 worktree。
  内层（tdd、契约自报）留在执行器侧，靠 `skill_pointer` 指向 SKILL.md 路径。
  验收标准：跑通一张两票、带 blocking 边的规格。
  依赖：#16、#17、#19。

## P3 — 加固与小项

- [x] **#24 收割上报执行器的真实死因**（本仓库）—— 已落地 `ebd0b7b`
  范围：claude 非零退出时，`supervise.ts` 目前只报 `executor exited with code
  1; see stderr.log`，而 stderr.log 是空的，真因在 stdout.log 的 JSON envelope
  里（`is_error`、`api_error_status`、`terminal_reason`、`result`）。额度 403
  实测：exit=1 + `api_error_status:403` + `result:"Failed to authenticate..."`。
  验收标准：执行器因鉴权或额度失败时，harvest 文本直接给出该原因，不让人去翻空文件。
  依赖：无。#15 现场发现。
  顺带修掉的：`persist` 在 run dir 已消失时抛 ENOENT，异常跑出 exit handler 会把会话
  带死（`88973b2`）。这条竞争是 #24 的新测试推出来的。

- [ ] **#25 worktree 依赖准备**（文档或代码，落点待定）
  范围：worktree 不带 `node_modules`，执行器跑不了 `npm run check`。当前手工
  `ln -s` 可行，但仓库 `.gitignore` 写的是 `node_modules/`（带斜杠只匹配目录），
  符号链接会被 `git status` 报成未跟踪，执行器可能把它提交进去。
  验收标准：派发到 Node 项目的 worktree 里，依赖就绪且 `git status` 干净。
  依赖：无。#15 现场发现。

- [x] **#22 pi 侧危险 git 拦截**（本仓库）—— 已落地
  范围：`user_bash` handler 拦 `git stash`、`git commit --amend`、force push。
  依据：上游文档记录的事故现场——`refs/stash` 跨 worktree 共享，worktree 隔离不住它。
  验收标准：拦截时给出原因与替代命令，不是静默失败。
  依赖：无。
  落地形态：纯模块 `extensions/lib/gitguard.ts`（分词 + 逐段判 git 子命令，引号里的
  词不误伤），接线同时盖 `tool_call`（模型的 bash 工具）与 `user_bash`（用户的 `!`），
  `PI_FLEET_GIT_GUARD=off` 可关。真会话实测：`git stash list` 被拦，回原因与替代命令。

- [ ] **#23 小项打包**（本仓库）—— 剩两项
  gate 的 classify usage 附进 dispatch 结果（已完成：claude implement 的 argv 正向
  断言已进 `test/plan.test.ts`，含 schema 无 `format` 关键字这一条）。`.fleet/` 在首次
  派发时自动写入项目 `.gitignore` 这一项先留着：它就是 #15 的试金石票，自己实现掉
  就没票可跑了。
  另记一项不一致：`profiles.ts` 的注释说 codex 走 `--json` 向 stdout 流事件，
  argv 里实际没有 `--json`，README 也没写。改代码或改注释，不能两边都留着。
  写法提醒（#15 现场）：`.gitignore` 里 `node_modules/` 这种带尾斜杠的模式
  只匹配目录，符号链接逃过忽略。追加忽略项前先确定要盖的是目录还是同名任意条目。
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

#15 四条腿全过（worktree、gate 正反、跨会话收割、codex 交互 + claude 契约）。
#28 布局与 #29 循环已落地并用 stand-in 验过。剩下的按顺序：

1. ~~合并票分支~~ 已做（`a4a37a7`）：三文件冲突全是「两边都保留」——
   `gitignoreLine` 与 `parsePaneMode` 并列，派发结果同时带 pane note、gitignore
   note 与 pane 字段。合并树 87 测试全绿（main 77 + 分支 10）。
   `preflight.ts` 那句过时注释已改写成仍然成立的理由。#23 的 `.gitignore` 项已关闭。
   另一处发现：仓库根其实是 `packages/pi-fleet` 本身，所以 p23 那个 worktree 落在
   **仓库外面**，不是「在项目文件夹里」——新票改用 `herdr worktree create` 顺带解决。
2. ~~#30 / #31~~ 已落地：`ticketsMatch` 让 `#23` 与 `23-gitignore` 算同一张票
   （前缀只在连字符处断开才算数，`230` 对 `23` 不算），`summarizeTriage` 把
   blocker/style/ignore 算成互斥分区、uncertain 单独报数。
3. **真执行器跑一轮链**：现成输入是这次真评审的两条 findings（preflight 的 catch
   分支无测试；#23 三项只交付了 `.gitignore` 一项）。看链能否自动起 fix 轮。
4. #25 worktree 依赖准备。
   #23 剩 gate 的 classify usage 记账。

现场遗留：workspace `w29` = worktree `/Users/gy/Code/pi/.worktrees/p23`，
tab `w29:t3`（codex implement，idle 等你读）、`w29:t5`（claude review，idle）。
`FleetCleanup` 归你决定何时关。新票的 worktree 一律 `herdr worktree create`，
别再手摆路径（p23 那个在 pi 仓库树内，是遗产）。
