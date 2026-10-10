# pi-fleet

Fleet orchestration for pi: dispatch one-shot **Codex / Claude** executors against
tickets in git worktrees, enforce the result contract, and recompute the ticket
frontier — all in code, so the orchestrating model never hand-rolls process
management or parses terminal text.

Division of labour:

- **The model** decides what to dispatch and writes the brief (seams, spec
  pointer, acceptance criteria); it closes tickets and interprets review
  verdicts.
- **The executor process** does the ticket's work — its own tools, its own
  permission policy, its own spend. pi dispatches the task and judges the
  contract; it does not pick the executor's tools and does not account for
  the executor's cost.
- **This extension** owns the mechanical protocol: spawn, timeout, contract
  validation, fix-round caps. A zero exit with a broken contract is
  `contract_failed`, never a quiet completion.

## Install

Requires pi `>= 1.0.0` and the `codex` and/or `claude` CLI on PATH.

```bash
pi install git:github.com/whosydd/pi-fleet
```

## Tools

### FleetDispatch

Spawn one executor. Detached: returns a job id immediately; the process
survives the session. Parameters:

| parameter | description |
| --- | --- |
| `ticket` | Tracker id or name, recorded in the job and the contract. |
| `worktree` | Absolute path of an existing git worktree; create it before dispatching. |
| `executor` | `codex` or `claude`. |
| `task_kind` | `implement` (default) or `review`. |
| `brief` | Complete instructions. This is all the executor sees. |
| `base` | Required for `review`: the fixed point to diff against. Reviews see committed work only, so commit before dispatching a review. |
| `skill_pointer` | Absolute path of a SKILL.md the executor should load (executors cannot auto-load skills). |
| `model` | Passed to the executor CLI (`-m` / `--model`). |
| `fix_round` | Increment on re-dispatch after review findings; capped at `PI_FLEET_MAX_FIX_ROUND`, then the tool refuses and the model should escalate to the user. |
| `timeout_ms` | Wall-clock limit for the process. |
| `pane` | Run the executor as an interactive Herdr agent you can watch and talk to. Absent follows `PI_FLEET_PANES`. |

The dispatch injects the structural rules into the prompt: commit to the
current branch, never `git stash` / `--amend` / force push, never close or edit
the tracker ticket, never spawn subagents — and for reviews, the anti-recursion
line ("Do not invoke /code-review or spawn additional agents") plus the
committed-work-only rule.

### FleetHarvest

Check a job, validate its contract, report the outcome with the run dir for
full logs. Outcomes: `running`, `contract_complete` (the parsed contract comes
back inline), `contract_failed` (the exact field-level error), `failed` /
`timeout`. Harvesting the same settled job twice is safe: the first harvest
reports the job; later ones return the same artifacts without re-judging.

### FleetStatus

List jobs with state, including which pane tabs are still open. Jobs from
earlier sessions rehydrate from disk on session start (see below).

### FleetCleanup

Close the Herdr tabs that fleet jobs created. `job_id` closes one settled
job's tab; `all: true` closes every tab whose jobs have all settled. A running
job keeps its tab and is reported as blocked. Cleanup never closes a worktree,
a workspace, or a pane it did not create, and the run dir keeps every log, so
closing a tab loses no evidence.

## Interactive panes

With `PI_FLEET_PANES=auto` (the default) and pi running inside Herdr
(`HERDR_ENV=1`), a dispatch opens the executor's own TUI in a pane you can
watch and talk to, instead of a detached process nobody sees:

1. The worktree's Herdr workspace is found from `herdr workspace list`.
2. One tab per ticket, split by role: `herdr tab create --label "fleet:
   <ticket>" --cwd <worktree> --no-focus`. The tab's left column holds executors
   and stacks each further one downward (past three, a new tab opens); the
   ticket's reviewer sits right of the first executor and that one pane is kept,
   so a re-review reads where the first review did.
3. `herdr agent start <name> --kind codex|claude --pane <id>` starts the real
   TUI. The name is `fleet-<ticket>-<nonce>`, except in the kept review pane,
   where the standing agent is re-prompted instead of a second one being started.
4. `herdr agent prompt <name> <task>` delivers the task. The task text points at
   the brief file and states the contract rule: write the JSON into
   `<run-dir>/result.json` and put nothing else in that file.

You can switch into the pane at any time: watch the work, answer a question, or
press Esc to interrupt. `FleetHarvest` reports `running` plus a note when herdr
says the agent is `blocked`, which means it waits on you.

The contract file is still the only success signal. herdr's `idle` and `done`
mean "ready for input", not "the task finished", so an agent that settles with
no contract file is `contract_failed`, never a quiet completion. A pane
transcript is never parsed: soft wraps, scrollback limits, and the TUI's own
chrome make it unreliable, which is why the contract travels as a file.

Nothing closes a pane by itself. Use `FleetCleanup` once the run is fully read.

If the interactive channel fails (no Herdr, no workspace for that worktree, an
agent that never came up), the dispatch degrades to a detached one-shot spawn
and says so in its result. Observability must never block a dispatch. Set
`PI_FLEET_PANES=off` to ask for that form directly: it is what an unattended run
uses, because one-shot argv needs no terminal.

In the detached form, `codex exec` gets `--output-schema` plus `-o`, and
`claude -p` gets `--output-format json --json-schema`. One caution measured
live: `codex exec --output-schema` documents that it constrains the final
response, but a refusal from the provider still exited 0 and `-o` held prose.
The extension's own contract check is what catches that, not the flag.

Create the worktree itself in Herdr when you can, so it arrives with its own
workspace:

```bash
herdr worktree create --cwd <repo> --branch fleet/<ticket> --label "fleet: <ticket>" --no-focus
```

`herdr worktree open` does the same for a worktree that already exists. A plain
`git worktree add` works too: the tab then lands in the session's own workspace.

### The review loop

A settled job drives the next step; no model turn sits in the loop. When a job
ends, the extension harvests it and asks `lib/loop.ts` what comes next:

- implement contract passed → a review is dispatched on the **other** harness, in
  the ticket's review pane, against the branch the implement contract named.
- review with blockers → one fix round, its brief assembled from the findings the
  triage classified as blockers. Style and ignore findings never spend a round.
- review without blockers → the loop closes and pings you: the branch is yours to
  merge.

Two caps bound the spend. `PI_FLEET_MAX_FIX_ROUND` stops repair rounds in
`plan.ts`, and the loop gets six dispatches per ticket per session. Past either,
the chain halts with a note instead of retrying. A judgment channel that is off
or unavailable halts the chain rather than inventing a round the model never
saw. `PI_FLEET_LOOP=off` makes every step yours to dispatch by hand.

### Completion ping

A finished executor pings instead of going quiet (`PI_FLEET_NOTIFY=off` stops
it). An interactive job pings through a background `herdr agent wait`, so the
ping arrives when the agent stops working, whether that is a finished turn or a
question it needs you to answer. A detached spawn pings from its own exit
event, through pi's UI when one exists and through Herdr when pi runs headless.
Exactly one channel fires per job.

The wording is deliberate: the ping names the agent's state or the exit code and
points at the harvest. It never claims the contract passed — only `FleetHarvest`
decides that. A ping that cannot be delivered is dropped in silence; the
notification channel never blocks or fails a job.

### What may start next

`FleetStatus` takes the tracker's ticket graph and returns the frontier:

```json
{ "tickets": [{ "id": "42", "status": "open", "blockers": ["41"] }] }
```

Ready means every blocker is `done`; waiting means at least one is not. Unknown
blocker ids and cycles come back as `Graph problems:` strings instead of dropping
a ticket out of both sets in silence. The extension never owns ticket state — it
reads the graph you hand it. Closing a ticket stays your tracker's job.

### What the dispatch reports about the worktree

Before a process exists, the dispatch inspects the checkout it is about to
run in and says what it found:

- the worktree's own `.gitignore` gets a line for the fleet state dir when it
  lacks one, because run dirs are fleet artifacts (this is the only place a
  dispatch writes into someone else's checkout);
- Node dependencies are **reported, never prepared**. A worktree has no
  `node_modules`, so `npm run check` fails on the environment and the executor
  can spend a round discovering it. Installing them, or symlinking the main
  checkout's, is the orchestrator's call — a dependency directory is the
  project's own policy.
- a symlinked `node_modules` is called out separately: git patterns ending in
  `/` match directories only, so `node_modules/` does not cover a link and
  `git status` shows it as untracked work. Expect it in the harvest diff, or
  ignore the bare name.

## Result contract

The executor's final output must be JSON matching the schema the extension
generates (written to `schema.json` in the run dir and embedded in the prompt):

- **implement**: `ticket`, `status` (`implemented` — which requires at least
  one commit — `blocked`, or `failed`), `branch`, `commits[]`, `tests`.
- **review**: `base`, plus `standards` and `spec` axes with `worst_issue` and
  per-finding `rule/file/line/quote`. The axes are never merged; the report is
  two blocks by construction.

Wiring: `codex exec` gets `--output-schema` + `-o result.json`; `claude -p`
gets `--output-format json --json-schema` (the supervisor extracts
`structured_output` from stdout and back-fills `result.json`, so both
executors leave the same artifact). Neither argv carries permission, tool, or
network flags: how the executor does the work is the executor's business.

## Jev judgments

Two soft calls the orchestrating model used to make on its own, turned into
typed, thresholded decisions through pi's own model registry (no extra
credentials):

- **Gate (pre-dispatch, implement briefs)** — three atomic nouls: does the
  brief name entry points, state checkable acceptance criteria, and exclude
  out-of-scope? Below `PI_FLEET_GATE_FLOOR` (0.7) the dispatch is refused with
  the missing dimensions named; between floor and `PI_FLEET_GATE_WARN` (0.85)
  it proceeds with a warning. This turns the implement workflow's known weak
  point ("nothing agrees the seams before the run") into a code-enforced
  check. Calibration note from live runs: compound questions wash out — the
  atomic questions separate thin from complete briefs at 0.05 vs 0.97.
- **Triage (post-harvest, review jobs)** — one choice per finding: `blocker`,
  `style`, or `ignore`, with confidence. Only blockers should consume a fix
  round; verdicts under `PI_FLEET_TRIAGE_CONFIDENCE` (0.8) are flagged
  uncertain for the model to read itself. Live calibration: interface-rule
  violations classify `blocker` at 0.99, import-order nits `style` at 0.99.

Both are advisory to the model, never a replacement for its judgment, and a
failed judgment channel degrades to a note — it must never block a dispatch.
`PI_FLEET_JUDGMENTS=off` disables both.

| variable | default | meaning |
| --- | --- | --- |
| `PI_FLEET_JUDGMENTS` | `on` | `off` disables gate and triage. |
| `PI_FLEET_JUDGE_PROVIDER` | `typesafe` | Classifier provider. |
| `PI_FLEET_JUDGE_ID` | `jev-latest` | Classifier id. |
| `PI_FLEET_GATE_FLOOR` | `0.7` | Noul hard floor; below it the dispatch is refused. |
| `PI_FLEET_GATE_WARN` | `0.85` | Noul warn line. |
| `PI_FLEET_TRIAGE_CONFIDENCE` | `0.8` | Choice confidence floor for uncertain flags. |

## Git guard

A fleet run splits one repository across several worktrees, and reviews and fix
rounds point at commit shas. Three commands break that guarantee from the
orchestrator side:

- `git stash` writes to `refs/stash`. One repository shares `refs/stash` with
  every worktree, so a stash made in one ticket's worktree can pop in another.
- `git commit --amend` rewrites a commit that a review base or a fix round
  already names by sha.
- `git push --force` replaces history that other clones already fetched.
  `--force-with-lease` and a bundled `-f` count as force pushes too.

The guard blocks those commands in the model's `bash` tool calls and in the
user's `!` commands. It reports the blocked command, the reason, and one safer
alternative; it never fails silently. `PI_FLEET_GIT_GUARD=off` disables it. The
guard screens command text, so treat it as a guard, not a sandbox. Executors
carry the same ban in their prompt, and their own permission policy stays
theirs.

## Where state lives

`PI_FLEET_STATE_DIR` (default `.fleet/`, resolved against the session's working
directory at load, so every recorded path is absolute) holds one run dir per job:
`brief.md`, `schema.json`, `result.json`, `stdout.log`, `stderr.log`,
`meta.json`. The disk is the source of truth: dispatch-and-forget is the
documented semantic, jobs outlive the pi session (executors are spawned into
their own process group), and a later session rehydrates and settles inherited
jobs from disk evidence. A job inherited past its wall-clock ceiling settles
as `timeout` without being killed: the recorded pid may name a recycled
process after that long, so pi never kills blind — stop a stuck executor by
hand using the pid in `meta.json`. A dispatch appends the state dir basename
(`.fleet/` by default) to the worktree's `.gitignore` when that file does not already
cover it, so fleet artifacts never show up as untracked executor work; a state
dir outside the worktree is left out of it.

## Configuration

Environment, read once at load — reload pi to change it.

| variable | default | meaning |
| --- | --- | --- |
| `PI_FLEET_STATE_DIR` | `.fleet` | Run-dir root, resolved to an absolute path at load. |
| `PI_FLEET_MAX_CONCURRENCY` | `4` | Concurrent executors; further dispatches are refused, not queued. |
| `PI_FLEET_TIMEOUT_MS` | `1800000` | Default wall-clock per job. |
| `PI_FLEET_MAX_FIX_ROUND` | `2` | Fix rounds before dispatch refusal forces escalation. |
| `PI_FLEET_CODEX_BIN` | `codex` | codex binary. |
| `PI_FLEET_CLAUDE_BIN` | `claude` | claude binary. |
| `PI_FLEET_HERDR_BIN` | `herdr` | herdr binary used for pane tabs and cleanup. |
| `PI_FLEET_NOTIFY` | `on` | `off` stops the ping through the UI or the Herdr notification, and with it the loop's closure note. |
| `PI_FLEET_LOOP` | `on` | `off` hands the review chain back to you: a settled job pings but dispatches nothing. |
| `PI_FLEET_AGENT_START_MS` | `90000` | How long to wait for an executor TUI to come up before degrading to a detached spawn. |
| `PI_FLEET_GIT_GUARD` | `on` | `off` stops blocking `git stash`, `git commit --amend`, and force push. |
| `PI_FLEET_PANES` | `auto` | Run executors as interactive Herdr agents: `auto` = only when `HERDR_ENV=1`, `on` / `off` decide outright. `off` uses the one-shot `codex exec` / `claude -p` argv. |

## Intended shape in the workflow

This extension implements the orchestration layer for workflows like
mattpocock/skills: `to-spec` → `to-tickets` produce tickets with blocking
edges; the model dispatches each ready ticket (`FleetDispatch`), harvests,
closes the ticket the tracker's way, recomputes the frontier, and repeats.
Tickets stay the source of truth — the extension never owns ticket state; it
only validates dispatch preconditions and computes what may start (the frontier
logic is a pure function used in tests; pass the graph in, get the ready set).

Review separately from implementation, in a fresh session, ideally on the
other harness: cross-harness review kills the self-review bias the original
workflow documents.

## Known limitations

- v1 has no widget and no `/fleet` command group; the tools are the interface.
- The git guard screens command text (`git stash`, `git commit --amend`, force
  push) in pi's bash calls. It is not a sandbox: it does not parse every shell
  quoting trick, and it never reaches inside an executor. The executor-side ban
  travels in the dispatch prompt, and executor-side hooks (`.rules`, pre-commit)
  remain worth installing.
- Worktree creation stays outside the tools. Prefer `herdr worktree create`
  (one worktree, one workspace, one visible pane) or `git worktree add`.
- A pane job past its wall-clock ceiling is marked `timeout` and never killed by
  pi: closing its tab with `FleetCleanup` is what stops the executor, and the
  recorded pid may already name a recycled process after that long.
- Pane mode needs a running Herdr server in the session's environment. Without
  it the dispatch degrades to a detached spawn and says so.
- `codex exec` runs with its own default sandbox policy; set executor-side
  policy (`~/.codex/config.toml`) if your executor needs different rails.
- Executor spend is not captured or attributed to the session's `/cost`; the
  executors bill their own accounts.
- Judgments require the classifier's provider credentials in pi; a missing or
  exhausted channel degrades to a note (gate skipped, triage skipped), never a
  block.

## Development

```bash
npm run check     # tsc --noEmit + node --test + headless load check
npm run smoke     # loads the extension through pi's loader (no model call)
```

```
extensions/
  index.ts            tool registration: FleetDispatch / FleetHarvest / FleetStatus / FleetCleanup
  lib/
    types.ts          shared types
    profiles.ts       executor argv + prompt building (pure)
    plan.ts           dispatch validation and planning (pure)
    preflight.ts      pre-dispatch worktree fix: .gitignore covers the state dir
    contract.ts       result contract validation (pure)
    panes.ts          Herdr pane mode: pane placement by role, cleanup decision (pure)
    loop.ts           what a settled job triggers next: implement, review, fix (pure)
    gitguard.ts       command screening for the three fleet-breaking git calls (pure)
    frontier.ts       ticket-graph frontier computation (pure)
    judgments.ts      Jev gate and triage: question catalog, interpretation, thresholds (pure)
    supervise.ts      process supervision, disk-backed job state
    ledger.ts         appendEntry formatting (pure)
smoke/load.ts         headless load check
test/                 unit tests, including real process supervision against a fake executor
```
