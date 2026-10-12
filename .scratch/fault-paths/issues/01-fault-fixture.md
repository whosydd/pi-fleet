# 01: Fleet fault paths, run for real (T3 / T4 / T5)

**What this is:** The three failure paths that only had unit tests — a second claim on a claimed ticket, a contract the schema rejects, and an executor that sits idle without writing one — run against real panes, real executors, and the real run directories.

The vehicle is trivial on purpose, so each run cost one executor turn: create `fault-fixture.txt` at the repository root holding one line.

**Out of scope:** Fixing what the runs found. The two findings below are their own ticket.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] A second `FleetDispatch` on a claimed ticket is refused, and it creates no run directory.
- [x] A contract the schema rejects settles the job as `contract_failed`, naming the field, and leaves the ticket unclosed.
- [x] An executor that stays idle with no contract settles the job as `contract_failed` on the idle grace, after the watcher has nudged it.
- [x] Each verdict is read from the run directory after the run, not predicted from the code.

## Comments

### T3 — a second claim (2026-10-12)

Dispatched `job_01_1791815672045_dw3o` (implement/codex, worktree
`/Users/gy/.herdr/worktrees/pi-fleet/fleet-01-fault-fixture`), then dispatched the same ticket
again in the same turn:

```
ticket 01 is not claimable: its status is "claimed". Only "ready-for-agent" tickets are.
```

The refusal came before any pane or run directory work: the run root held 16 directories
before and after, and the ticket's `Status:` line read `claimed`. The claim guard holds.

### T4 — a contract the schema rejects (2026-10-12)

`job_01_1791815672045_dw3o` was given a `result.json` that a real executor could plausibly
have written — `{"ticket":"01","status":"done",...}`, copying the tracker's own word for a
finished ticket — written mode 444 so the executor's own write could not replace it.

First `FleetHarvest`:

```
job_01_1791815672045_dw3o finished but violated the contract:
result.status: must be implemented|blocked|failed, got "done"
```

So the file on disk is judged, the field is named, and the job does not pass. The ticket was
left untouched at `claimed` — nothing closes a ticket but the orchestrator.

Three side observations from the same run:

- **The verdict is sticky.** After the executor wrote a valid contract into that run
  directory, a second harvest still reported the original `status: "done"` error. By design
  (`runner.harvest` returns a recorded failure rather than re-judging), and it means the
  escape from `contract_failed` is a new dispatch, never a repaired `result.json`.
- **The 444 file bought a real observation.** The executor met `operation not permitted`,
  asked for approval to `rm` the file, and stopped there: `herdr agent get` reported
  `blocked`, and `FleetHarvest` says such a job waits for a human at an approval.
- **`herdr agent prompt` refuses a blocked agent.** See finding F1.

### T5 — the idle grace, and the nudge before it (2026-10-12)

Reset the ticket to `ready-for-agent` and dispatched `job_01_1791815762055_aev0` into the
same pane, so codex's standing agent `implement-01` was re-prompted in place. Then the run
was held at the prompt with `herdr agent send-keys implement-01 Escape`, which is the
induced form of the field symptom this path exists for: an executor sitting at its prompt
with the run stalled.

Observed, from the pane and `herdr agent get`:

- 22:36:06 Esc. Agent `done` at its prompt, no contract.
- 22:37:04 the watcher's nudge landed — the pane shows `› continue` — and the agent went
  `working` again. The nudge resumes a stalled executor, which is what it was built for.
- The job then settled without a contract:

```
job_01_1791815762055_aev0 finished but violated the contract:
the agent has been done for 120s without writing the contract: it answered in prose,
or the task never reached it. Read pane w28:p1 and re-brief.
```

The agent was still alive in the pane when that verdict was written, and the ticket stayed
`claimed`. Herdr's `done` did not close the job; the missing contract did.

One nuance worth recording: `meta.json` holds `idleSince` 348 ms after `startedAt` — the
first harvest sampled codex before it had begun generating, so the clock started at
dispatch. Holding the agent in `idle`/`done` with Esc kept every later sample in the idle
branch, so the reported `120s` counted wall time from dispatch, not 120 seconds of
continuous idleness. In an unmanipulated run the first `working` sample clears the clock
(`runner.harvest`); the number is a sampled clock, not a stopwatch.

### Two real faults this round found

**F1 — a dispatch that reuses a blocked agent fails outright.** The second dispatch at
22:35 went to the pane codex was already in and failed:

```
dispatch failed, ticket 01 released: herdr agent prompt implement-01 … failed:
{"error":{"code":"agent_blocked","message":"agent implement-01 is blocked and requires
interactive input"}}
```

`planPaneAction` reuses the pane, `#place` resolves the standing agent name, and
`agent prompt` refuses an agent at an approval. The whole dispatch dies — the claim is
released and the ticket is dispatchable again, but a fix round or a re-review cannot start
until a human answers the pane. The error is also hard to read: `execFile`'s message quotes
the entire task text back, so the one actionable line is buried in ~60 lines of brief.

**F2 — a failed dispatch leaves an orphan run directory.** The same dispatch had already
run `mkdirSync` and written `brief.md`, `schema.json`, and `task.txt`. `meta.json` is
written only after the task reaches the agent, so the leftover
(`.pi/fleet/runs/job_01_1791815728469_83t3/`) has no meta at all: `readMeta` calls it
`absent`, `listJobs` and `listStale` both skip it, and `FleetStatus` listed 15 jobs while
the disk held 17 run directories. Nothing reports it and nothing cleans it up.

This is not an artifact of the induced fault: the run root already held one such directory
before this round started — `job_01_1791812890476_5lxw`, the same three files and no meta,
left by an earlier session's failed dispatch. `FleetStatus` had been listing 14 jobs against
15 directories since then. Both orphans were deleted by hand after this run.

Both are fixed in a follow-up ticket, not here: this ticket only ran the paths.
**Cleanup:** tab `w28:t1` closed with `FleetCleanup`, worktree
`/Users/gy/.herdr/worktrees/pi-fleet/fleet-01-fault-fixture` removed, branch
`fleet/01-fault-fixture` deleted, the orphan run directory deleted by hand. The fixture file
lived only in that worktree, which is why nothing of it is committed.

### T5 again, uninduced (2026-10-12, later the same day)

The run above held the executor at its prompt by hand. Later the same day the same path fired on its own, while ticket 02 was being built: the provider answered `status_code=400 任务请求不合法 (invalid_task_request)` to the task, the watcher's `continue` nudge went out and drew a second 400, and the agent sat at its prompt until the grace settled the job:

```
job_02_1791818229451_g8ip finished but violated the contract:
the agent has been done for 121s without writing the contract: it answered in prose,
or the task never reached it. Read pane w29:p3 and re-brief.
```

No file in the worktree had changed, the ticket stayed `claimed`, the run directory keeps the record, and the ticket was re-dispatched at round 0. That is the whole fail-safe behaving as designed on a real provider fault — and it fixes the limit of the nudge in place: one `continue` rescues a provider that refuses a single request, not one that keeps refusing.
