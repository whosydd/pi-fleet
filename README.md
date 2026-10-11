# pi-fleet

One ticket at a time in a Herdr pane: a Codex or Claude executor builds it, the
other harness reviews the uncommitted change, pi commits it, and pi judges the
contract that comes back. A settled job wakes pi by itself, so the hand-off from
build to review needs no prompting.

## Install

```bash
pi install git:github.com/whosydd/pi-fleet
```

Then, in each project you want to use it in:

```text
/fleet-setup
```

Requires pi `>= 1.0.0`, the `codex` and/or `claude` CLI on PATH, and Herdr.

## Where the skills come from

This package ships **one** skill: its own orchestration loop. The upstream
engineering skills are neither vendored nor copied.

| set | who uses it | where it comes from |
| --- | --- | --- |
| **planning** — grilling, to-spec, to-tickets, triage, domain-modeling, tracker setup | pi | `/fleet-setup` installs the upstream repository into the project behind a settings filter, so these **track upstream** |
| **execution** — tdd, code-review | the executors | the executor's own harness install. Both Codex and Claude already have these. The task text names them |
| **fleet** | pi | this package |

### Why the execution set is not shipped

Handing an executor an absolute path to a vendored copy looked like it bought
determinism, and it did the opposite:

- The upstream review skill is model-invocable in both harnesses. A task that
  reads like a review makes the executor load **its own** copy, so naming a path
  as well put two copies of one skill in one context.
- The two installs are not the same revision. Claude's plugin ships 1.2.3 and
  Codex's ships 1.3.1, and the review skill differs between them.
- The methods worth guaranteeing are small and belong to this package anyway: the
  two axes, the anti-recursion guard, and the output shape. Those travel in the
  task text, as text, where they cannot be shadowed.

The upstream `implement` skill is not named at all. Five of its six instructions
are covered here more reliably — the brief carries the ticket, the task says to
leave the change uncommitted, and the contract makes the executor report test
numbers it measured. The
sixth is its closing step invoking the upstream review skill, which is exactly the
self-review that the cross-harness review exists to avoid.

### Why the planning set is not shipped

pi matches a package's skill filter against the upstream path, and it does not
strip a leading `./`. Two consequences, both found by experiment:

- the filter must read `skills/engineering/to-tickets`, not
  `./skills/engineering/to-tickets`;
- a filter pattern that matches nothing **fails silently**. No skill loads, and
  pi reports no diagnostic.

That is why the list lives in `skills/manifest.json` and is applied by a script
rather than typed by hand, and why `npm run check-planning` exists.

Vendoring this set was tried and removed. When both this package and the upstream
repository are installed, the vendored copy is discovered first and wins the name
collision — with a warning, but it also means the project silently runs a pinned
copy and never sees upstream's latest.

## `/fleet-setup`

```bash
npm run install-planning -- --target <project>   # what the command runs
npm run check-planning                           # verify, write nothing
```

It runs `pi install -l`, then rewrites the resulting entry into the filtered
object form. Global settings are never touched.

```jsonc
// <project>/.pi/settings.json
{
  "packages": [
    {
      "source": "https://github.com/mattpocock/skills.git",
      "extensions": [],
      "skills": ["skills/productivity/grill-me", /* … the planning set … */],
      "prompts": [],
      "themes": []
    }
  ]
}
```

`extensions`, `prompts`, and `themes` are empty rather than absent, because an
absent property loads everything the package publishes.

Commit `.pi/settings.json`. `.pi/git/` holds the clone, `.pi/fleet/` holds the
fleet's run directories, and `FleetDispatch` adds both to the project's
`.gitignore`. `pi update --extensions` moves the clone to upstream's latest.

## What an executor is told

Every job gets one task text and one brief file, and nothing else. The task
carries the rules that a mistake would cost a worktree to learn:

- Do not commit: leave the change in the worktree. The orchestrator stages it, a
  second harness reviews it, and the orchestrator commits after the review
  passes.
- Never `git stash`, `git commit --amend`, or a force push. `refs/stash` is
  shared by every worktree.
- Do not close, tick, or edit the tracker ticket.
- Write the contract as one JSON object into the file named in the task.
  Nothing else goes in that file.
- For a review: the two axes, the rule against merging them, and the guard
  against invoking the harness's own review command.

## The tools

### FleetDispatch

Claim one ticket and put an executor to work on it.

| parameter | description |
| --- | --- |
| `ticket` | Absolute path of the ticket file, e.g. `.scratch/login/issues/03-token-refresh.md`. |
| `worktree` | Absolute path of an existing git worktree. Create it with `herdr worktree create` first. |
| `role` | `implement` builds the ticket in the worktree, without committing. `review` reviews that uncommitted change against `base`. |
| `executor` | `codex` or `claude`. Omit it and the tool chooses. |
| `base` | For `review`: the fixed point the change was built on. Required, and normally the worktree's starting commit. |
| `fix_round` | Increment after a review found blockers. Capped in code. |
| `findings` | The blockers a fix round must resolve. |
| `model` | Passed through to the executor CLI. |

The tool claims the ticket, writes the run directory, opens or reuses the
ticket's Herdr tab, starts the executor's own TUI, and delivers the task. It
returns immediately: the executor is a Herdr agent, not a child of the turn.

Rules it enforces rather than leaves to the model:

- A ticket is claimable only from `Status: ready-for-agent`, so two dispatches
  cannot take the same ticket. A dispatch that starts nothing releases the claim.
- A review runs on the harness that did not write the code. Omit `executor` and
  the tool reads the build job's executor and picks the other one.
- `fix_round` past `PI_FLEET_MAX_FIX_ROUND` is refused.
- Outside Herdr, it refuses and says so. There is no detached fallback: a commit
  from a worktree needs git metadata outside it, which an executor's sandbox
  cannot write, so an unattended one-shot run could not deliver a ticket anyway.

### FleetHarvest

Read a job and decide it. Outcomes: `running`, `contract_complete`,
`contract_failed`, `failed`, `unknown`.

The contract file is the only success signal. Herdr's `idle` and `done` mean
"ready for input", not "finished", so neither settles a job. Only an idle agent
that produces no contract does, and then as a failure after
`PI_FLEET_IDLE_GRACE_MS`. Harvesting a settled job twice is safe: the second
harvest returns the same verdict without re-judging.

`unknown` means the id names no run directory, or one written by an earlier
release of this package. That is refused rather than judged: a record whose
`schemaVersion` this release does not read has no `role`, so treating it as a job
would report `undefined` as a harness and let a verdict be written onto somebody
else's record.

### FleetStatus

List the jobs on disk, including jobs from earlier sessions, with the pane tabs
still open. Run directories from another release are listed separately, with the
reason. This tool does not compute a frontier: the tracker's own convention
defines one, and the fleet skill says how to read it.

### FleetCleanup

Close the Herdr tabs this package created, once their jobs settled. A tab
holding an unsettled job is reported as blocked. Never a worktree, never a
workspace, never a pane you opened yourself. The run directory keeps every log,
so a closed tab loses no evidence.

## The ticket tracker

Local markdown only, as the upstream setup skill writes it: one file per ticket
under `.scratch/<feature>/issues/<NN>-<slug>.md`, with a `Status:` line.

The vocabulary is `ready-for-agent` → `claimed` → `done`. `FleetDispatch` writes
`claimed` because two dispatches racing for one ticket is a concurrency bug.
Everything else about the ticket is the orchestrating model's to write.

The executor never reads the ticket file. The brief copies the ticket's text, so
a ticket that is uncommitted, or that sits outside the worktree, is still visible
to the job.

## Updating upstream

`skills/manifest.json` holds two lists of upstream names: the `planning` set,
which `/fleet-setup` installs into the project, and the `execution` set, which
the task text names. The `excluded` map records the upstream skills this package
deliberately does not use, and why.

`pi update` is the only thing that moves the upstream clone, and it moves the
clone to whatever `main` is. Upstream moves skills between buckets, so a planning
path can stop matching. A pattern that matches no file loads no skill, and pi
reports no diagnostic.

No check runs on a schedule. A check that runs before the update would report a
state no install is in, because an unfetched rename breaks nothing. The drift
surfaces at the update instead, as a skill missing from the `/skill:` list. When
you see that, edit the path in `skills/manifest.json` and re-run `/fleet-setup`.

`npm run check-planning` keeps the offline half honest: the filter committed in
`.pi/settings.json` matches the manifest.

## Configuration

Read once at load.

| variable | default | meaning |
| --- | --- | --- |
| `PI_FLEET_RUNS_DIR` | `.pi/fleet/runs` | Run-directory root, made absolute. pi's own state lives under pi's own project directory. |
| `PI_FLEET_MAX_FIX_ROUND` | `2` | Fix rounds before a dispatch is refused. |
| `PI_FLEET_AGENT_START_MS` | `90000` | How long Herdr waits for an executor TUI. |
| `PI_FLEET_IDLE_GRACE_MS` | `120000` | Idle-without-contract grace before failure. |
| `PI_FLEET_GIT_GUARD` | `on` | Block `git stash`, `commit --amend`, and force push in this session's bash calls. |
| `PI_FLEET_AUTO_CONTINUE` | `on` | Watch dispatched jobs with `herdr agent wait` and wake the session with a user message when one settles. `off` makes the loop wait for the human. |
| `PI_FLEET_CODEX_BIN` | `codex` | Codex binary. |
| `PI_FLEET_CLAUDE_BIN` | `claude` | Claude binary. |
| `PI_FLEET_HERDR_BIN` | `herdr` | Herdr binary. |

## Development

```bash
npm run check             # typecheck, tests, load check, planning filter
npm run test              # node --test test/*.test.ts
npm run smoke             # load the package through pi's own loader
npm run check-planning    # does .pi/settings.json still match the manifest?
npm run install-planning  # what /fleet-setup runs
```

Tests never call a model and never hit the network. The Herdr CLI is replaced by
a stand-in that answers the same argv and records what it was asked, so dispatch,
pane placement, harvest, and cleanup run end to end without a session.
