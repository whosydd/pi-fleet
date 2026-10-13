# pi-fleet

A pi extension that runs one ticket at a time: a Codex or Claude executor builds it in a
Herdr pane, the other harness reviews the uncommitted change, and the pi session that
dispatched it commits the result. These are the terms its docs, its tools and its skill use,
each with the words this project does not use for the same thing.

## Language

### The two sides of the loop

**Orchestrator**:
The pi session that dispatches jobs, judges contracts, and commits the work. Every use of
"you" in this package's skill means the orchestrator.
_Avoid_: controller, supervisor, dispatcher

**Executor**:
The coding agent that runs one job, in its own worktree and its own pane.
_Avoid_: worker, agent, implementer

**Harness**:
The CLI product an executor runs as, and therefore the context and the skill install that
executor has: Codex or Claude. An executor is one instance of a harness; a review must run
on the harness that did not write the code.
_Avoid_: CLI, tool, model, provider

### The skills

**Upstream**:
The third-party repository `github.com/mattpocock/skills`. This package installs its skills
into a project instead of shipping them.
_Avoid_: remote, origin, the skills repo

**Planning set**:
The ten upstream skills the orchestrator may load. The name says who may load it, not what
the skills do.
_Avoid_: planning skills

**Execution set**:
The two upstream skills only an executor loads: `tdd` and `code-review`. The orchestrator
never loads them, because a session that can load them implements instead of dispatching.
_Avoid_: execution skills

### The work

**Spec**:
The plan for one version's worth of changes, published to the tracker as the parent of that
version's tickets.
_Avoid_: design doc, plan, epic

**Ticket**:
One unit of work: what to build, its acceptance criteria, and the tickets that block it.
Tickets are the only thing the fleet dispatches.
_Avoid_: issue, task, item, story

**Job**:
One dispatch: one ticket, one role, one executor, one run directory. A ticket gets at least
an implement job and a review job, and one more implement job per fix round.
_Avoid_: run, task, attempt

**Role**:
What a job does. `implement` builds the ticket; `review` judges the uncommitted change.
_Avoid_: phase, stage

**Blocking edge**:
A ticket that must be done before another ticket can start.
_Avoid_: dependency, blocker, link

**Frontier**:
The tickets a dispatch may start now, in work order: ready, unblocked, unclaimed, and inside
the lowest-numbered version plan that still has one.
_Avoid_: queue, backlog, todo list

**Claim**:
The one write that takes a ticket off the frontier for one job, so that a second dispatch
cannot start on the same ticket.
_Avoid_: lock, assign, checkout

### Where the work lives

**Medium**:
Where tickets live: local markdown files under `.scratch/`, or GitHub issues.
_Avoid_: backend, provider, tracker

**Tracker**:
The medium plus the repository's own conventions for using it, as written in
`docs/agents/issue-tracker.md`.
_Avoid_: board, project

### What a job produces

**Brief**:
The file an executor reads: the ticket's own text plus the rules for this job.
_Avoid_: prompt, instructions, ticket file

**Task**:
The one message the orchestrator sends into the pane. It names the brief to read and the
file to write the contract into.
_Avoid_: prompt, brief

**Contract**:
The JSON result an executor writes when it stops. It is the only success signal: a zero exit
with a broken contract is a failure.
_Avoid_: result, report, output

**Run directory**:
The per-job directory holding the brief, the task, the contract and the logs. It is the
source of truth for a job, and it outlives the pane.
_Avoid_: run folder, job directory, workdir

**Settled**:
A job that has stopped: a contract exists, or the grace passed with none. Settled says
nothing about whether the work landed.
_Avoid_: finished, done, complete

### Herdr's surfaces

**Workspace, tab, pane**:
Herdr's objects, largest first. A workspace holds tabs, a tab holds panes, and a pane runs
one agent. This package opens one tab per ticket, and closes only the tabs it opened.
_Avoid_: pane tab, window, session

**`idle` and `done` in Herdr**:
States of the agent in a pane. Both mean "ready for input", and neither means "finished". A
ticket is `done` when its issue is closed, which is a different fact.
_Avoid_: (do not read either as a task state)

### The review

**Standards axis**:
Whether the change follows this repository's own rules.
_Avoid_: style axis, code review

**Spec axis**:
Whether the change does what the ticket asked.
_Avoid_: acceptance axis, correctness axis
