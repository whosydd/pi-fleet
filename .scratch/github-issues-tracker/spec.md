# Spec: GitHub Issues as the ticket tracker

**Status:** draft. The open questions at the bottom need a human answer before any
ticket is cut.

**Scope:** the tracker medium only. Where a ticket's text comes from, where its status
lives, how a claim is written, how blocking edges are read, how the frontier is computed,
and how `FleetDispatch` names a ticket.

**Out of scope:** the dispatch, brief, contract, harvest and review machinery. Those do
not change, because none of them reads the tracker.

## Decided (2026-10-12)

| Question | Decision |
| --- | --- |
| How the claim is made atomic | A claim comment; the lowest claim-comment id wins. Section 3. |
| What picks the medium | `PI_FLEET_TRACKER`, values `markdown` or `github`, defaulting to `markdown`. No key in `.pi/settings.json`. Section 5. |
| What `done` means | The issue is closed. No `done` label. Section 2. |
| Where a blocking edge is written | A `**Blocked by:**` line in the body. GitHub's own dependency field is not read. Section 4. |

Two questions remain open. They are at the bottom.

## What does not change

These hold today and must hold after the medium moves. Each one is an invariant in
`AGENTS.md`, so a change here is an edit to `AGENTS.md` as well.

- The brief copies the ticket's text. The executor never reads the tracker, and it never
  writes to it.
- The contract is the only success signal.
- One claim per ticket, in code. A second dispatch on a claimed ticket is refused.
- `extensions/lib/runner.ts` owns the pane: spawning, liveness, and the Herdr argv.
- The review and fix-round loop, including the fix-round cap.
- Run directories are the source of truth for a job. The tracker is read at claim time
  and written at claim, release, and close. It is never re-read to judge a job.

## 1. How a ticket is named

`FleetDispatch.ticket` accepts three forms:

| Form | Example | Resolved how |
| --- | --- | --- |
| Absolute path | `/repo/.scratch/login/issues/03-token-refresh.md` | The local markdown medium, unchanged. |
| `owner/repo#N` | `whosydd/pi-fleet#12` | Used as written. Always valid. |
| `#N` or `N` | `#12`, `12` | The repository is taken from the worktree's `origin` remote. |

The rule is mechanical, so no form is guessed: a value whose first character is `/` is a
file. Any other value must match `^(?:[\w.-]+/[\w.-]+)?#?\d+$`. Anything else is refused
with both accepted forms in the refusal text.

The canonical form is `owner/repo#N`. The run directory records it in a new field,
`meta.ticketRef`. `meta.ticket` keeps the decimal number as a string (`"12"`), so the
agent name, the tab label and the contract's `ticket` field keep the shape they have now.

A bare number is resolved against the worktree's remote because the worktree is where the
job commits. When that remote is missing or ambiguous, the dispatch is refused and the
refusal asks for the `owner/repo#N` form. Do not guess from `process.cwd()`: the
orchestrator's checkout and the worktree can point at different repositories.

The spec stays a file: `.scratch/<feature>/spec.md`. Only tickets move. A spec is long,
the fleet never reads it, and an issue body is a poor place for it.

## 2. Status lives in labels, not in a `Status:` line

| Current string | GitHub |
| --- | --- |
| `ready-for-agent` | the label `ready-for-agent`, issue open |
| `claimed` | the label `claimed`, issue open |
| `done` | the issue is closed |

Three states, and the package writes only these. The label vocabulary comes from
`docs/agents/triage-labels.md`, which already maps the upstream triage role
`ready-for-agent` to the string `ready-for-agent`.

`done` is the closed state rather than a third label, because a closed issue is already
off the frontier, and closing is what the tracker's own convention means by done. A
`done` label would be a second source of the same fact.

The package never edits an issue's body. Acceptance criteria belong to the human and to
the orchestrating model, and the file medium already promised that a claim reformats
nothing.

Each of the two labels is exclusive with the other. The package removes `ready-for-agent`
when it adds `claimed`, and adds `ready-for-agent` when it removes `claimed`.

## 3. The claim is a comment, and the tie is broken by comment id

Both obvious options are read-then-write, and both lose a race:

- `gh issue edit --add-assignee @me` succeeds whether or not the issue is already
  assigned. Two dispatches both "win".
- `gh issue edit --add-label claimed` succeeds whether or not the label is already there.
  Same hole.

Required protocol, in this order:

1. Read the issue: state, labels, body.
2. Refuse unless it is open and carries `ready-for-agent`. The refusal names the state it
   found, the way the file medium's refusal does.
3. Post a claim comment that names the job id and the worktree.
4. Re-read the issue's comments.
5. Win only if this comment has the lowest id among the claim comments. Otherwise delete
   this comment and refuse.

Comment ids are assigned by GitHub and increase monotonically, so the lowest claim comment
is a deterministic winner and the loser can detect that it lost. This is the checkbox
compare-and-swap that the file medium gets from a synchronous read and write.

Release is the inverse: delete the claim comment and remove the `claimed` label. Today
`extensions/index.ts` releases the claim when a dispatch fails after claiming, and that
behaviour does not change.

The claim comment text carries the job id, so a reader of the issue can find the run
directory, and the run directory's `ticketRef` finds the issue.

Cost: four `gh` calls per claim. A dispatch already costs a worktree, a pane and an
executor run, so this is not the expensive part.

The upstream `setup-matt-pocock-skills` template for a GitHub tracker records the claim as
`gh issue edit <n> --add-assignee @me`. That is the racy form rejected above, and the
template is not wrong for what it was written for: the planning skills claim a ticket once,
by hand, in one session. The fleet claims one in code, and two panes can race. The written
`docs/agents/issue-tracker.md` must say which claim the fleet uses.

## 4. Blocking edges stay a line in the body

An edge is written the way it is written today:

```
**Blocked by:** #12, #15
```

The frontier is then:

```
gh issue list --state open --label ready-for-agent --json number,title,body --limit 100
```

Keep the issues whose body names no open blocker, sort by number ascending, and take the
first.

GitHub's own dependency field (`blocked by` / `blocking`) is not used. It is reachable
through GraphQL rather than the CLI's `--json` fields, and its shape can move. See open
question 4.

A task list (`- [ ] #12`) is not an edge. A checklist is a human's progress note; an edge
is a fact about dispatch order, and the two diverge the moment someone ticks a box early.

The upstream template prefers GitHub's native dependency field and keeps this line as a
fallback. This spec takes the fallback as the only form, for the reason in open question 4
of the earlier draft: the native field is reachable through GraphQL rather than the CLI's
`--json` fields. The template's own paragraph on it needs the database id
(`gh api repos/<owner>/<repo>/issues/<n> --jq .id`) rather than the number, which is a
second identifier to get wrong.

`Blocked by:` with no numbers means unblocked. A blocker that names a number which is not
an issue in the repository is treated as not done, and the frontier silently skips that
ticket — so the frontier report must name skipped tickets and the numbers they wait on.
That is a small addition to `FleetDispatch`'s or the skill's report, not to the tool's
refusals.

## 5. The medium is the `PI_FLEET_TRACKER` environment variable

`PI_FLEET_TRACKER`, whose value is `markdown` or `github`, read where the other `PI_FLEET_*`
settings are read, defaulting to `markdown`. A value that is neither is refused, and the
refusal names both accepted values.

```ts
// extensions/lib/types.ts
env.PI_FLEET_TRACKER === "github" ? "github" : "markdown"
```

A rejected option, for the record. A `pi-fleet.tracker` key in the project's
`.pi/settings.json` reads better on paper: the medium is a property of the repository, and
an environment variable is a property of the shell that started pi. Two facts killed it.

- **pi reads project settings only when the project path is trusted**, and returns `{}`
  when it is not (`dist/core/settings-manager.js`, `loadFromStorage`). So the fleet would
  read its medium from a file that vanishes in a worktree, on a fresh clone, and before any
  trust prompt, and would silently fall back to `markdown`. Reading the file with
  `readFileSync` would dodge that, and adds a second settings surface with its own
  precedence, its own parsing, and its own failure mode.
- **pi's settings file is pi's.** The key survives a pi rewrite — verified, pi merges its
  modified fields into the file's current content (`persistScopedSettings`) — but that is
  tolerance, not a contract. This package does not own that file and does not write to it.

What the environment variable costs: the medium is not visible in the repository, so a
clone does not arrive knowing it, and one machine running two projects on different media
needs the variable set per shell rather than once. The README records the variable next to
the other `PI_FLEET_*` settings, which is where a reader already looks.

## 6. `gh` gets one module, and it is the only module that runs `gh`

`runner.ts` is the only module that spawns a process, and that invariant is load-bearing:
it is why the spawning is reviewable in one file. `gh` needs a home that does not break it.

Proposal: `extensions/lib/gh.ts` owns every `gh` argv and every parse of `gh` output, and
runs nothing else. `AGENTS.md`'s invariant is reworded to match:

> `runner.ts` is the only module that spawns for a job, and the only one that calls the
> herdr CLI. `gh.ts` is the only module that runs `gh`, and `gh.ts` runs nothing else.

`extensions/lib/tracker.ts` holds the decisions — which state a label means, whether a
claim won, what the frontier is — and takes the `gh` calls as an injected function. It
therefore tests without `gh`, the way `herdr.ts` and `tickets.ts` test without a session.

The end-to-end tests put a fake `gh` on `PATH`, exactly as `test/helpers/fake-herdr.mjs`
stands in for herdr. Tests must not hit the network.

Preconditions are checked before the first API call, and each refusal is one sentence that
names what is missing:

- `gh` is not on `PATH`.
- `gh auth status` reports no account. Keep `gh`'s own reason.
- The repo lacks the `ready-for-agent` or `claimed` label. Refuse with the
  `gh label create` line that fixes it. See below.

### Why the package does not create the two labels

`gh issue edit --add-label` fails outright on a label the repository does not have, so a
missing label is a hard failure either way. The choice is only between refusing with the
command and running the command.

Refusing is the default, for three reasons:

- **A label is shared vocabulary, and the issue tracker's document already says the human
  owns it.** `docs/agents/triage-labels.md` exists so that the strings in the package and
  the strings in the tracker can be reconciled by hand. Creating labels from code moves
  that decision into a tool call and hides it.
- **The package writes to the tracker, and it should not write to the tracker's schema.**
  The two labels are the only states the package owns. Colors, descriptions and every other
  label are not its business, and a partial create leaves half a vocabulary behind.
- **The package already has exactly one unrequested project mutation**, the `.gitignore`
  line in `preflight.ts`, and it earns that place by preventing a real defect: the fleet's
  own run directories appeared as the ticket's untracked work, and one live run committed
  them. A missing label produces a one-line refusal, not a wrong change in the repository.

The cost is one command at switch time, for a human who switches once per project:

```
gh label create ready-for-agent --description "Fully specified, ready for an AFK agent"
gh label create claimed --description "A fleet job holds this ticket"
```

The refusal prints that block.

## 7. Refusal text

Every `gh` failure is abbreviated the way `runner.ts` abbreviates Herdr argv: an argument
longer than 80 characters becomes a placeholder that says how long it was. An issue body
in a refusal is the same defect as the 60-line brief that `runner.ts` used to echo.

A refusal states: the medium (GitHub issues), the ticket reference in canonical form, and
`gh`'s own reason. It never contains the issue body.

## 8. Edge cases

| Case | Behaviour |
| --- | --- |
| The issue is closed while a job runs | The job settles on its contract. Harvest does not re-read the issue. Closing early is the human's call and is not undone. |
| The claim comment is deleted by hand | The `claimed` label and the open run directory still show the claim. The refusal text names both. |
| The `claimed` label is removed by hand | The next dispatch can claim the ticket, and the earlier job's harvest still judges its own contract. The run directory is the record. |
| The issue was edited after dispatch | The brief copied the text at dispatch time, so the job builds what the ticket said then. The run directory keeps `task.txt`. |
| More than 100 ready tickets | `--limit 100` covers the practical case. The frontier report says when it hit the limit. |
| `gh` rate limit | The refusal carries `gh`'s message. No retry loop: a dispatch is a human-initiated action. |
| Two remotes on the worktree | A bare-number reference is refused; `owner/repo#N` always works. |

## 9. Tests to add

All of these run against the fake `gh`, and none touches the network.

- A claim on a `ready-for-agent` issue wins and writes both the comment and the label.
- Two dispatches race, the fake `gh` gives the second one a higher comment id, and the
  second refuses. The issue keeps the first claim's comment and the job id in it.
- A claim on an issue without `ready-for-agent` refuses, and the refusal names the labels
  and state it found.
- A repository that lacks one of the two labels refuses, and the refusal carries the
  `gh label create` block for the missing one.
- A dispatch that fails after the claim removes the comment and the label.
- The frontier skips a ticket whose blocker is open, and reports that ticket and the
  number it waits on.
- A reference that matches no accepted form is refused with both accepted forms.
- A bare number with no `origin` remote is refused.
- Refusal text for an issue body of 4 KB stays under 1000 characters and contains no line
  of the body.
- An absent `PI_FLEET_TRACKER` reads `markdown`; an unknown value is refused with both
  accepted values.

## Still open

1. **Should the bootstrap command create the `claimed` label?** The upstream setup skill
   creates each missing triage label, `ready-for-agent` among them, and `claimed` is not one
   of the five triage roles. Section 6 refuses and prints the `gh label create` block
   instead. The whole argument against creating it is there, so this is a one-line answer
   for the human: yes creates it once per project, no keeps the refusal.

Settled but worth restating: GitHub's native dependency field is not read now. Section 4
says why, and the `**Blocked by:**` line keeps the two media identical, which is what makes
this spec small.

## Candidate tickets

Not opened yet. 01 and 02 depend on neither open question, so they can be cut now.

| # | Ticket | Blocked by |
| --- | --- | --- |
| 01 | `gh.ts`: argv, parsing, preconditions, fake-gh test helper | — |
| 02 | `tracker.ts`: the frontier, the claim and the release, against the fake `gh` | 01 |
| 03 | `FleetDispatch` accepts the three reference forms and records `meta.ticketRef` | 01 |
| 04 | Close a ticket and record the outcome; `done` is the closed state | 03 |
| 05 | The skill, `docs/agents/issue-tracker.md` and `AGENTS.md` describe the new medium | 03 |

Ticket 05 is larger than it looks. `docs/agents/issue-tracker.md` is not this package's
file: it is written by the upstream `setup-matt-pocock-skills` skill, and this repository's
copy is byte-identical to that skill's `issue-tracker-local.md` template. Two things follow.

- The fleet skill's step 2 tells the operator to choose **Local markdown** when they run
  that skill. It must choose **GitHub** instead, and the fleet skill must say so. The flip
  has to happen at the same moment `PI_FLEET_TRACKER` moves, because the planning skills
  read that doc to decide whether to write a `.scratch/` file or call `gh issue create`.
  Move one and not the other, and the planner writes markdown while the fleet reads issues.
- The generated doc needs the fleet's corrections on top of the template: the claim is the
  comment CAS of section 3, not `--add-assignee`; `done` is the closed state; the two
  labels the fleet owns are `ready-for-agent` and `claimed`; and the edge is the
  `**Blocked by:**` body line of section 4.

That skill's Section B creates each triage label the tracker lacks, `ready-for-agent`
among them, at setup time and with the human's confirmation. It does not create `claimed`,
because `claimed` is not one of the five triage roles. The refusal in section 6 stays as
the net for a repository where nobody has created `claimed` yet.
