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

List jobs with state. Jobs from earlier sessions rehydrate from disk
on session start (see below).

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

## Where state lives

`PI_FLEET_STATE_DIR` (default `.fleet/`) holds one run dir per job:
`brief.md`, `schema.json`, `result.json`, `stdout.log`, `stderr.log`,
`meta.json`. The disk is the source of truth: dispatch-and-forget is the
documented semantic, jobs outlive the pi session (executors are spawned into
their own process group), and a later session rehydrates and settles inherited
jobs from disk evidence. A job inherited past its wall-clock ceiling settles
as `timeout` without being killed: the recorded pid may name a recycled
process after that long, so pi never kills blind — stop a stuck executor by
hand using the pid in `meta.json`. Add `.fleet/` to
`.gitignore`.

## Configuration

Environment, read once at load — reload pi to change it.

| variable | default | meaning |
| --- | --- | --- |
| `PI_FLEET_STATE_DIR` | `.fleet` | Run-dir root. |
| `PI_FLEET_MAX_CONCURRENCY` | `4` | Concurrent executors; further dispatches are refused, not queued. |
| `PI_FLEET_TIMEOUT_MS` | `1800000` | Default wall-clock per job. |
| `PI_FLEET_MAX_FIX_ROUND` | `2` | Fix rounds before dispatch refusal forces escalation. |
| `PI_FLEET_CODEX_BIN` | `codex` | codex binary. |
| `PI_FLEET_CLAUDE_BIN` | `claude` | claude binary. |

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
- No `user_bash` interception of dangerous git commands on the pi side; the
  ban travels in every dispatch prompt, and executor-side hooks (`.rules`,
  pre-commit) remain worth installing.
- Worktree creation is the caller's job (`git worktree add`, or herdr's
  worktree workspaces for human-visible panes).
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
  index.ts            tool registration: FleetDispatch / FleetHarvest / FleetStatus
  lib/
    types.ts          shared types
    profiles.ts       executor argv + prompt building (pure)
    plan.ts           dispatch validation and planning (pure)
    contract.ts       result contract validation (pure)
    frontier.ts       ticket-graph frontier computation (pure)
    judgments.ts      Jev gate and triage: question catalog, interpretation, thresholds (pure)
    supervise.ts      process supervision, disk-backed job state
    ledger.ts         appendEntry formatting (pure)
smoke/load.ts         headless load check
test/                 unit tests, including real process supervision against a fake executor
```
