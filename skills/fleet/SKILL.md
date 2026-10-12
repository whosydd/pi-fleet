---
name: fleet
description: "Run a ticket queue through Codex or Claude executors in Herdr panes. Use when a ticket is ready to build, when a build finished and needs review, or when the user asks to work the ticket queue."
---

# Fleet

This skill runs a ticket queue. You decide what to dispatch. An executor does one
ticket. A second executor reviews the result.

Four tools do the mechanical work: `FleetDispatch`, `FleetHarvest`,
`FleetStatus`, and `FleetCleanup`. This skill gives the order to call them in.

## Division of labour

You do not write the ticket's code. You do not run its tests. The executor does
that in its own worktree, with its own tools and its own account.

You own four things: what to dispatch, whether the contract passes, the ticket's
`Status:` line, and the commit. The executor never commits: you stage its
changes, a second harness reviews them, and you commit only after that review
passes.

## Before the first dispatch

Run these steps once for each repository.

1. Run `/matt-pocock-skills-bootstrap`. It installs the upstream skills into this
   project so the planning skills work, and it filters the execution skills out.
   Global settings stay untouched. Run `/reload` afterwards so the session picks
   them up.
2. Run the `setup-matt-pocock-skills` skill. Choose **Local markdown** as the
   issue tracker. It writes `docs/agents/issue-tracker.md`.
3. Check that this session runs inside Herdr. Run `test "${HERDR_ENV:-}" = 1`.
   If the check fails, stop and tell the user to start pi in a Herdr pane. A
   fleet job runs as a Herdr pane and in no other way.
4. Create the worktree. Run `herdr worktree create`. Run `herdr worktree` first
   to read the current syntax. The worktree arrives with its own Herdr
   workspace, which `FleetDispatch` needs. Herdr closes that workspace when its
   last tab closes, and cleanup closes exactly that tab. Dispatch reopens the
   workspace on the next job, so a reused worktree needs no manual step.
5. Re-run `/matt-pocock-skills-bootstrap` after a `pi update`. `pi update` is the
   only thing that moves the upstream clone, and upstream moves skills between
   buckets. A planning path can then match no file, which loads no skill and
   reports nothing. When a skill you expect is missing from the `/skill:` list,
   upstream moved it. Edit `skills/manifest.json` in the pi-fleet package, then
   re-run `/matt-pocock-skills-bootstrap`.

If `/matt-pocock-skills-bootstrap` is not available, this project does not have
the pi-fleet package. Install it first.

## The loop

Work one ticket to the end before you start the next one.

### 1. Pick a ticket

Read the files under `.scratch/<feature>/issues/`. A ticket is ready when both
conditions hold:

- Its `Status:` line reads `ready-for-agent`.
- Every ticket named in its `Blocked by:` line reads `done`.

Pick the ready ticket with the lowest number. Do not call `FleetStatus` for this
step. The tracker's files are the frontier, and `FleetStatus` reports only what
is already in flight.

### 2. Dispatch the build

Call `FleetDispatch` with these arguments:

- `ticket`: the absolute path of the ticket file.
- `worktree`: the path from step 0.
- `role`: `implement`.

The tool claims the ticket, opens the pane, and starts Codex. Send the ticket's
own text in the brief. Add the context the executor cannot read for itself: the
entry points, the acceptance criteria, and what is out of scope.

If the tool refuses, read the refusal and act on it. It refuses a claimed
ticket, a missing worktree, and a fix round past the cap.

### 3. End your turn

The executor is a Herdr agent. It is not a child of this turn. Do not poll it.
Do not harvest in the same turn.

The extension watches the run directory and wakes this session with a user
message when the job settles, so the loop continues by itself: harvest, then
review, then commit. When `PI_FLEET_AUTO_CONTINUE=off`, no message comes and you
wait for the human instead.

### 4. Harvest the build

Call `FleetHarvest` with the job id. Act on the outcome:

- `running`: stop. Say that the build runs, and harvest on a later turn. If the
  report says the agent waits for you, read pane and answer it.
- `contract_failed`: read the run directory. Fix the ticket or the brief. Do not
  change the schema: the package fixes it.
- `failed`: read the run directory. Report the executor's own reason.
- `contract_complete`: go to step 5.

### 5. Stage the build and dispatch the review

The implement job does not commit, so the work sits in the worktree as
uncommitted changes. Stage them:

    git -C <worktree> add -A

`git diff` cannot show a new file that was never staged, and the review reads
`git diff`. Then check that the worktree carries work at all:

    git -C <worktree> status --short

An implement contract with an empty worktree is not an implemented ticket,
whatever its `status` field says.

Record the branch in the ticket, and set its `Status:` line back to
`ready-for-agent`. The review job claims the ticket from that line, and a
`claimed` ticket cannot be dispatched again. You own this line; the executor
never touches it.

Then call `FleetDispatch` with these arguments:

- `ticket`: the same ticket file.
- `worktree`: the same worktree.
- `role`: `review`.
- `base`: the point the work was built on. Run `git -C <worktree> rev-parse HEAD`.
  Nobody has committed since the worktree was cut, so this is the branch tip.

Omit `executor`. The tool picks the harness that did not write the code.

The review reports two axes. Standards asks whether the code follows this
repository's rules. Spec asks whether the code does what the ticket asked. Keep
the axes apart in your own report.

### 6. Act on the findings

Read the findings. A finding earns a fix round only when it blocks merging. A
style or preference finding does not.

- No blocking finding: commit the work and merge it.

      git -C <worktree> add -A
      git -C <worktree> commit -m "<type>(<scope>): <subject>"
      git merge --no-ff <branch> -m "merge: <ticket title>"

  The subject is the ticket's title. The type and the scope follow this
  repository's commit convention. Run the merge from the main checkout, and run
  the repository's checks once after it. Record the branch and the commit sha in
  the ticket, set its `Status:` line to `done`, report the two axes, and stop.

- A blocking finding, and the fix round cap is not reached: set the ticket's
  `Status:` line back to `ready-for-agent`, then call `FleetDispatch` with
  `role: implement`, `fix_round` increased by one, and `findings` set to the
  blocking findings. The fix round re-prompts the executor that built the
  ticket, in its own pane, and changes the same uncommitted working tree. Then
  repeat from step 4.

- A blocking finding, and the cap is reached: stop and tell the user. Name the
  worst finding. Do not dispatch another round.

### 7. Clean up

After the last harvest of a run, call `FleetCleanup` with `all: true`. The
commit comes first: cleanup closes the tab, and an uncommitted worktree holds the
only copy of the work. Read the pane's output and the file changes before that.
The run directory keeps every log, so a closed tab loses no evidence.

Then remove the worktree and the branch of a ticket that is `done`:

    git worktree remove <worktree>
    git branch -d <branch>

Use `git branch -d`, not `-D`: the safe form refuses a branch that is not merged,
which is the check worth having here. Use the git command for the worktree too,
not `herdr worktree remove`: cleanup has just closed the worktree's last tab,
Herdr closed the workspace with it, and the Herdr command matches only a live
workspace.

## Rules that hold at every step

- The executor never commits. You stage the change and commit it after the
  review passes. An uncommitted worktree holds the only copy of the work.
- One ticket, one job, one pane. Never dispatch two builds for one ticket.
- The contract is the only success signal. A zero exit with a broken contract is
  `contract_failed`.
- Herdr's `idle` and `done` mean "ready for input". They do not mean "finished".
- The reviewer is never the harness that wrote the code.
- The fix round cap is 2. `FleetDispatch` enforces it in code.
- Never run `git stash`, `git commit --amend`, or a force push. This package
  blocks them, and the reason matters: `refs/stash` is shared by every worktree.
- Do not implement the ticket yourself when an executor is slow. Wait, or answer
  the executor in its pane.
- Never load `code-review`, `tdd`, or any other execution skill yourself. Those
  belong to the executor. `/matt-pocock-skills-bootstrap` keeps them out of this
  context on purpose.

## When the user asks for a status

Call `FleetStatus`. It reads the run directories, so it reports jobs from earlier
sessions too. For the queue itself, read the tracker's files as in step 1.
