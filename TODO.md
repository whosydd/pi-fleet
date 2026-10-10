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

- [ ] **#15 真票端到端验证**（本仓库）—— 部分完成，剩执行器腿（额度阻塞）
  范围：选一张真实小票，走 `git worktree add` → `FleetDispatch` → `FleetHarvest`，
  codex 与 claude 各跑一次。
  验收标准：codex 的 `-o/--output-schema` 确实把契约 JSON 写进 `result.json`；
  claude 的 `--json-schema` 确实在 stdout 给出 `structured_output` 且收割能过
  契约校验；gate 与 triage 在真实 brief 和真实 findings 上行为正确。
  依赖：无。这一项不过，后面所有改动都缺乏回归基线。
  风险：`claude -p` 在用户自己的权限配置下可能拒绝跑测试（pi 不干预权限），届时
  改执行器侧配置，不是 argv。

  2026-10-10 现场（真票 = #23 的 `.gitignore` 项，worktree
  `/Users/gy/Code/pi/.worktrees/p23`，分支 `fleet/p23-gitignore`，编排会话用
  `pi -p -e extensions/index.ts` 起）：

  - 已过：worktree 预检、gate（真 brief → entry 0.98 / acceptance 0.85 / scope
    0.99 → pass，走 pi 自带 registry，无额外凭据）、spawn 与 detached meta.json
    落盘、跨会话收割（新 session `loadFromDisk` 认出 job，报 failed + exit code +
    stderr 路径）。
  - 已修：run-dir 根目录是相对路径，编排者按主仓库解析、执行器按 worktree 解析，
    codex 0.6 秒退出并报 `Failed to read output schema file ... No such file or
    directory`。`48d7fe3` 把根目录解析成绝对路径。
  - 未过（额度）：契约文件真实写入、claude `structured_output` 提取、review triage
    在真 findings 上的行为。
  - 额度恢复后要验的第一件事：codex 的 `-o` 能否写在执行器工作区之外（现在 run
    dir 在编排者仓库的 `.fleet/` 下）。`--output-schema` 读工作区外文件已实测可行。
    若写不了，改法是 run dir 落进 worktree 或从 stdout 提取契约——`JobMeta` 里的
    `diskPath` 与 `resultSource` 字段是这条路的遗留，代码目前未使用。
  - 试金石场子已备好，补跑直接用：worktree `/Users/gy/Code/pi/.worktrees/p23`（分支
    `fleet/p23-gitignore`，`node_modules` 是指向主仓库的符号链接），brief 在
    `/tmp/p23-brief.md`（重启会没，下文四项要求照旧重写即可）。

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

#15 的四条腿已过三条（worktree + gate + 跨会话收割），执行器腿等 tierflow 额度
恢复后补跑，先验 codex 的 `-o` 能否写在执行器工作区之外。#24、#22 已落地。额度未
恢复时做 #25 或 #23（#23 的 `.gitignore` 项先留着，它是 #15 的试金石票）。#16 和
#17 继续等 #15 收尾。
