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

## P0 — 首次真跑

- [ ] **T1 一张票、codex、pane**：`/fleet-setup` → `setup-matt-pocock-skills` →
  `herdr worktree create` → `FleetDispatch` → 执行器写 `result.json` →
  `FleetHarvest` 过校验。
- [ ] **T2 同票 claude review**：base 取 implement 契约的 `branch`。验收：两轴
  findings 分开，且 claude 没有递归 spawn。
- [ ] **T3 并发认领 / T4 坏契约 / T5 idle 宽限**：见前一轮清单，未变。

## P1 — 待复核的环境假设

- [ ] `herdr agent start --timeout <ms>` 这个 flag 来自旧架构的真跑记录，但
  herdr 文档只对 `agent prompt` / `agent wait` 记了 `--timeout`。跑 T1 就知道；
  不行就删，靠默认 30 秒。
- [ ] `herdr tab create --workspace --label --cwd --no-focus` 的完整 flag 集合同理。
- [ ] `herdr worktree create` 的确切语法。skill 让模型先跑 `herdr worktree` 读帮助。

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

## P3 — 上游补丁（上一轮列出、尚未做）

- [ ] **去掉 `implement` 的加载需求**。`implement/SKILL.md` 六条指令里五条我们已有更可靠的
  实现（brief 拷票、task 给 tdd 路径、契约的 `tests` 字段强制跑测试、task 说提交），
  第六条"自审"是我们主动要移除的。**净贡献为零，而它带来一处与上游的指令冲突。**
  去掉后只剩 `code-review` 一处需要处理。
- [ ] **给 `code-review` 提 PR**：加反递归那一行。matt 自己的文档承认这是未修的 bug，
  而 `1dab982` 证明他会合这类修复。
- [ ] **`invocation.md` 的约定冲突**：上游要求 skill 之间按名字调 Skill tool。我们的任务
  文本现在也按名字引用，所以冲突消失了，但问题还在：执行器读到
  `Call the Skill tool with "tdd"` 时能否解析，取决于 harness。
  这决定我们是否需要改上游文件——即 fork 才是否必要。**先做 T1，用现场结果回答。**

## 下次开工入口

从 **T1** 开始。它同时回答三个悬而未决的问题：`agent start --timeout` 是否有效、
路径投递的 skill 能否被 codex 正常加载、以及执行器会不会因为 `implement` 的自审指令
而多烧一轮。这三个答案决定 P3 要不要做、以及要不要 fork。
