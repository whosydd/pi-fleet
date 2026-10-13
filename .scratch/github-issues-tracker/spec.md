# Spec: GitHub Issues as the ticket tracker

**Status:** decided. Every design question has an answer below, and the candidate tickets at
the bottom can be cut. "Not in this release" records the two things this release refuses
on purpose.

**Scope:** the tracker medium only. Where a ticket's text comes from, where its status
lives, how a claim is written, how blocking edges are read, how the frontier is computed,
and how `FleetDispatch` names a ticket.

**Out of scope:** the dispatch, brief, contract, harvest and review machinery. Those do
not change, because none of them reads the tracker.

## Decided (2026-10-12)

| Question | Decision |
| --- | --- |
| How the claim is made atomic | A claim comment; the lowest claim-comment id wins. Section 3. |
| What picks the medium | The H1 of `docs/agents/issue-tracker.md`, the file the upstream setup skill writes. No environment variable, and no key in `.pi/settings.json`. Section 5. |
| What counts as a ticket | An open item labelled `ready-for-agent` whose text carries "What to build". That is what excludes the spec issue, which is the parent of a version's tickets. Section 2. |
| Who creates the `claimed` label | The fleet, at session start, because the upstream skill does not know that label. The four triage labels stay the human's. Section 6. |
| What `done` means | The issue is closed. No `done` label. Section 2. |
| Where a blocking edge is written | GitHub's native dependency field, `blockedBy`. The body line is not read on this medium, and a body line with no native edge is reported as inconsistent. Section 4. |
| What the frontier order is | One version plan at a time: the lowest-numbered parent group first, the lowest-numbered ready ticket inside it. Section 4. |

Every decision this release needs is in that table. "Not in this release" at the bottom
records what is refused on purpose, and why.

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

The spec lives where the tracker doc says it lives. On the local medium that is
`.scratch/<feature>/spec.md`; on GitHub it is an issue, because the upstream `to-spec` skill
publishes it there. The fleet only ever reads tickets, and the spec issue is excluded by the
predicate in section 2.

## 2. Status lives in labels, not in a `Status:` line

### What counts as a ticket

```
open, labelled ready-for-agent, text contains "What to build", no open blocker
```

The text marker is the load-bearing part, because the label is not. The upstream `to-spec`
skill publishes the spec **as an issue labelled `ready-for-agent`**, and `to-tickets` then
publishes the tickets as that issue's children while instructing the model *not* to close or
modify the parent. Nothing upstream ever removes `ready-for-agent` from the spec.

So the spec issue looks dispatchable for its whole life: before the split, when it has no
children yet, and again after its last child closes. Three rules follow.

- **The ticket predicate is the body marker.** `to-tickets` gives the tickets of both media
a "What to build" section (`**What to build:**` locally, `## What to build` on GitHub), and
the `to-spec` template has no such section. A leaf that lacks it is a plan, not a ticket.
- **`subIssues` and `parent` are a second signal, never the only one.** They are verified to
be dimensions of `gh issue view --json`. An unsplit spec has no children, so children alone
cannot carry the rule.
- **The fleet never closes and never modifies a parent issue.** When a version's last ticket
merges, its spec stays open. Closing the plan belongs to the human, at release time.

### The status table

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

## 4. Blocking edges are GitHub's native dependency field

GitHub has one canonical representation for "this ticket waits on that one": the native
dependency, read as `blockedBy`. This medium uses it, and only it.

The frontier is one call:

```
gh issue list --state open --label ready-for-agent \
  --json number,title,body,labels,state,subIssues,blockedBy,parent --limit 100
```

That the field is reachable at all corrects this spec's earlier draft, which claimed the
native dependency needed GraphQL. It does not, and this was measured on `gh` 2.102, not
read:

```
$ gh issue view 1 --json bogus
Available fields: assignees author blockedBy blocking body closed closedAt
  closedByPullRequestsReferences comments createdAt id isPinned issueType labels
  milestone number parent projectCards projectItems reactionGroups state stateReason
  subIssues subIssuesSummary title updatedAt url
$ gh issue list --limit 5 --json number,title,body,labels,state,subIssues,blockedBy,parent
exit=0
```

A ticket is blocked when `blockedBy` names an issue that is not closed.

### Normalisation: one representation, and a report when another appears

Upstream's `to-tickets` writes the native edge first on a real tracker and keeps a
`Blocked by:` text line as the fallback, and its issue template says to omit that section
when the edges were set natively. So the normal shape of a GitHub ticket is a native edge
and no text line at all.

A `Blocked by:` line that names issue references while `blockedBy` is empty is therefore an
inconsistency, not a second form of the same fact. The fleet does not dispatch that ticket,
and the frontier report names it and the references it could not read. "None (can start
immediately)" names no reference, so it is not an inconsistency and the ticket is unblocked.

Two consequences for the written tracker doc: it states that edges are set natively, and it
states that the fleet reads the native field only.

The text line is still the markdown medium's one form, and its parser does not change. It is
never consulted for a GitHub ticket.

### The order: one version plan at a time

The survivors are grouped by the version plan they belong to, and the fleet finishes one
group before it starts the next:

- a ticket's group is the issue its `parent` names;
- a ticket with no parent is its own group;
- a group's key is its parent's number, or the ticket's own number when it has no parent;
- groups are worked in ascending key order, and inside a group the lowest-numbered ready
  ticket goes first.

The lowest-numbered open plan is finished before the next plan starts, and a standalone
ticket competes with plans on its own number.

A task list (`- [ ] #12`) is not an edge, and neither is an assignee. A checklist is a
human's progress note; an edge is a fact about dispatch order, and the two diverge the
moment someone ticks a box early.

One shape to confirm at implementation time: whether each entry of `blockedBy` carries the
blocker's own state. When it does not, resolving a blocker's state costs one `gh issue view`
per blocker, which is affordable at a frontier of tens.

A blocker numbering an issue that is not in the repository is treated as not closed, so the
frontier skips that ticket.

## 5. The medium is read from the tracker doc the setup skill writes

`docs/agents/issue-tracker.md` is the repository's own declaration of where its issues live.
The upstream `setup-matt-pocock-skills` skill writes it from one of four sources:

| Skill choice | Template | H1 in the doc |
| --- | --- | --- |
| GitHub | `issue-tracker-github.md` | `# Issue tracker: GitHub` |
| GitLab | `issue-tracker-gitlab.md` | `# Issue tracker: GitLab` |
| Local markdown | `issue-tracker-local.md` | `# Issue tracker: Local Markdown` |
| Other (Jira, Linear, …) | none, the model writes it from the human's description | unpredictable |

The fleet reads the file, matches `^# Issue tracker: (.+)$`, and picks a medium:

| Recognised | Medium | Behaviour |
| --- | --- | --- |
| file absent | markdown | Read `.scratch/`, and report that no tracker doc was found |
| `GitHub` | github | Read issues |
| `Local Markdown` | markdown | Read `.scratch/` |
| `GitLab` | — | Refuse, and name the two media this release reads |
| anything else | — | Refuse, and quote the H1 and the file path |

The two refusals are the point of the table. An unrecognised doc must not fall back to
markdown: a Jira or Linear repository would then get a permanently empty frontier and no
diagnostic. This repository has paid for that class of failure once already, when a filter
pattern that matched no file loaded no skill and said nothing.

The file is read from the orchestrator's directory, where the claim happens. A copy on a
ticket's branch is not the declaration this process follows.

### Why GitLab is refused rather than supported

The recogniser has to know all four options, because the skill can produce any of them.
Implementing a medium is a separate question, and on the evidence GitLab fails it.

- **The part the fleet depends on most is the part that varies by tier.** GitLab's native
  blocking link is a Premium/Ultimate feature, and the documented fallback on the free tier
  is the same `Blocked by:` text line. The edge reader would need two paths and a tier
  check, where GitHub needs one field the frontier query already returns.
- **One edge costs a second call with a second identifier.** GitLab's link is reached
  through `glab api projects/:id/issues/<child-iid>/links`, so the project id and the
  internal issue id both enter the code. GitHub's is `blockedBy` on the issue that was
  already fetched.
- **There is nothing here to verify it against.** `glab` is not installed on this machine,
  and every remote is GitHub. The tests must not touch the network, so a `glab.ts` would be
  written against a fake `glab` whose argv and JSON this package invented. An adapter that is
  wrong fails at claim time — after the ticket is claimed and the pane is open. That is the
  worst place to be wrong and the least visible one.
- **The daily path is unaffected.** The claim CAS, the two labels, `done` as closed, the
  ticket predicate and the recogniser are all medium-agnostic. A `glab.ts`, one more branch
  in the recogniser and a fake-`glab` helper is the whole delta, and that ticket has one
  precondition: a GitLab repository and an installed `glab` to check it against.

Nothing changes on the markdown side. A repository whose doc is absent, or says Local
Markdown, behaves exactly as it does today.

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
- The repo lacks the `ready-for-agent` label. Refuse with the `gh label create` line that
  fixes it: that label is the human's triage vocabulary, and the upstream setup skill is
  what creates it, with the human's confirmation. The fleet does not write it.
- The repo lacks `claimed`. Refuse with its `gh label create` line as well. The session-start
  reconcile below normally creates it first, so this refusal is the net for the case where
  that reconcile did not run or did not succeed.

### The one label the fleet creates

`claimed` is the fleet's own state. It is not one of the five triage roles, so the upstream
setup skill does not know it and never creates it. The fleet creates it, once, and only
when all three of these hold:

- the recogniser of section 5 says the medium is GitHub;
- `gh label list` does not carry `claimed`;
- the session is starting.

The trigger is the state and not the setup skill's completion, because there is no
completion event to hook in pi: an extension sees `session_start`, `tool_call`,
`tool_result`, `user_bash` and the turn events, and no skill event exists. The state is also
the better trigger. A fresh clone whose tracker doc already says GitHub never runs the setup
skill, and a completion hook would miss it.

A failure here is reported and not retried: the dispatch-time refusal above is the net, and
a label that is missing at claim time produces one readable line rather than a silent wrong
write.

This is a write to the tracker's schema, and the package makes it on purpose. The boundary
that keeps it honest is ownership: the fleet creates exactly the label it writes, and it
never creates, edits, or deletes a triage label.

The four triage labels remain the human's, and this block still belongs in the refusal for
`ready-for-agent`:

```
gh label create ready-for-agent --description "Fully specified, ready for an AFK agent"
```

## 7. Refusal text

Every `gh` failure is abbreviated the way `runner.ts` abbreviates Herdr argv: an argument
longer than 80 characters becomes a placeholder that says how long it was. An issue body
in a refusal is the same defect as the 60-line brief that `runner.ts` used to echo.

A refusal states: the medium it resolved and the file it read it from, the ticket reference
in canonical form, and `gh`'s own reason. It never contains the issue body.

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
- The recogniser: `GitHub` gives github, `Local Markdown` gives markdown, an absent file
  gives markdown, and `GitLab` plus an unrecognised H1 are refused with the file path in the
  message.
- A spec issue labelled `ready-for-agent` is not picked. A leaf whose text lacks
  "What to build" is skipped, and so is one that has children.
- A ticket blocked only by a native `blockedBy` edge is skipped, and the blocker's number is
  reported.
- A ticket whose body names `Blocked by: #12` while `blockedBy` is empty is not dispatched,
  and the report names it and `#12`. A body reading "None (can start immediately)" is
  dispatched.
- Grouping: plan #7 holds ready tickets #9 and #10, and standalone ticket #8 is also ready.
  The groups are keyed 7 and 8, so plan #7's ticket #9 is picked first. Swap the numbers and
  the standalone ticket wins.

## Not in this release

- **GitLab.** The recogniser refuses it, on the evidence in section 5. A `glab.ts` sibling is
  the known path, and its precondition is a GitLab repository and an installed `glab` to
  check it against.
- **Creating the four triage labels.** Those are the human's vocabulary, and the upstream
  setup skill creates them with the human's confirmation. The fleet creates only `claimed`,
  the one label that skill does not know, and it does so on the state rather than on the
  skill's completion: a fresh clone whose doc already says GitHub is covered too.

## Candidate tickets

Not opened yet. Nothing here waits on a decision, so the order below is the dependency order.

| # | Ticket | Blocked by |
| --- | --- | --- |
| 01 | `gh.ts`: argv, parsing, preconditions, fake-gh test helper | — |
| 02 | `tracker.ts`: the recogniser, the ticket predicate, the frontier, the claim and the release, against the fake `gh` | 01 |
| 03 | `FleetDispatch` accepts the three reference forms and records `meta.ticketRef` | 01 |
| 04 | Close a ticket and record the outcome; `done` is the closed state | 03 |
| 05 | The skill, `docs/agents/issue-tracker.md` and `AGENTS.md` describe the new medium | 03 |
| 06 | Session-start reconcile: create `claimed` when the doc says GitHub and the label is missing | 01 |

Ticket 05 is larger than it looks. `docs/agents/issue-tracker.md` is not this package's
file: it is written by the upstream `setup-matt-pocock-skills` skill, and this repository's
copy is byte-identical to that skill's `issue-tracker-local.md` template. Two things follow.

- The fleet skill's step 2 tells the operator to choose **Local markdown** when they run
  that skill. It must choose **GitHub** instead, and the fleet skill must say so. That choice
  is also the whole of the medium switch, now that section 5 reads the doc: the H1 is the
  setting, so there is no second thing to keep in step.
- The generated doc needs the fleet's corrections on top of the template: the claim is the
  comment CAS of section 3, not `--add-assignee`; `done` is the closed state; `claimed` is
  the fleet's label; and a blocking edge is set natively, because the fleet reads `blockedBy`
  and never the body line.

That skill's Section B creates each triage label the tracker lacks, `ready-for-agent`
among them, at setup time and with the human's confirmation. It does not create `claimed`,
because `claimed` is not one of the five triage roles. Ticket 06 creates that one, and the
refusal in section 6 stays as the net for a repository where neither has run yet.
