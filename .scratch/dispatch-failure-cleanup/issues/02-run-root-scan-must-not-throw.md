# 02: The run-root scan must not throw on an entry it cannot read

**What to build:** `listRuns` in `extensions/lib/jobs.ts` now decides what is a run directory with

```
.filter((id) => statSync(join(settings.runsDir, id), { throwIfNoEntry: false })?.isDirectory() === true)
```

`throwIfNoEntry: false` covers a missing target only. A self-referential symlink in the run root makes that `statSync` raise `ELOOP`, and the exception leaves the module, so `listJobs` and `listStale` both throw. Every caller of `runner.all()` dies with them: `FleetStatus`, `FleetCleanup` with `all: true`, and `FleetDispatch`'s own default executor choice. Measured against a run root holding one readable job and one `ln -s loop loop`:

```
listJobs -> THREW ELOOP   listStale -> THREW ELOOP        (this worktree)
listJobs -> [job_ok]      listStale -> []                 (main, before the statSync filter)
```

So a root that main reads fine now takes the whole scan down.

Required: an entry the scan cannot stat is skipped, and the scan finishes. An entry that is not a directory — a plain file, a broken link, an unreadable link — is neither a job nor a leftover, so it is not reported; the readable jobs and the no-meta directories around it are. Do not enumerate error codes: any failure to stat an entry means the scan cannot call it a directory, and it must not throw.

This module reports rather than throws everywhere else (`readMeta` returns a stale reason for a `meta.json` it cannot parse, `readContract` returns undefined, `writeMeta` tolerates a missing parent), and its header says the disk is the source of truth. The scan of that disk is the one call that can still throw; make it join the rest.

Also correct the comment above the filter: it says a broken link is not listed, and says nothing about the entry that cannot be resolved at all.

**Blocked by:** None (can start immediately)

**Status:** done

**Branch:** fleet/01-failed-dispatch

**Commits:** `81fefd9` (merged as `9e9e163`; the same commit carries ticket 01, which owned the worktree)

- [x] With a self-referential symlink in the run root, `listJobs` lists the readable job and `listStale` returns the directories that have no `meta.json`; neither throws.
- [x] A test covers that case: `runner.all()` and `runner.stale()` both return normally with a looped link present in the run root.
- [x] A plain file in the run root is still not reported as a leftover (the existing test for it stays green).
- [x] The comment above the filter states which entries the scan skips and why.
- [x] `npm run check` passes: typecheck, tests, `npm run smoke`, and the planning filter check. (101 passing after the merge.)

**Out of scope:** Do not change which entries count as a job or as a leftover: a directory with a readable `meta.json` is a job, a directory without one is a leftover, and anything else is invisible. Do not change `FleetHarvest` or `FleetCleanup`'s refusal behaviour. Do not touch the dispatch-failure cleanup this ticket's sibling added.

## Comments

### Outcome (2026-10-12)

Fixed and merged in ticket 01's commit: `81fefd9` on `fleet/01-failed-dispatch`, merged into main as `9e9e163`, `npm run check` 101 passing in the main checkout after the merge.

Why one commit carries two tickets: this ticket exists because ticket 01 had used both of its fix rounds, and no second worktree was created for it — its job ran in ticket 01's worktree over the same files. Splitting the change afterwards would have meant committing a state neither job produced, so the commit subject is ticket 01's title and this ticket's change rides inside it.

- **First dispatch** (`job_02_1791818229451_g8ip`) never reached the work. The provider answered `status_code=400 任务请求不合法 (invalid_task_request)` twice — once to the task, once to the watcher's `continue` nudge — and the agent sat at its prompt until the idle grace settled the job as `contract_failed` after 121s. No file was touched, the ticket stayed `claimed`, and the run directory keeps the record. Re-dispatched at round 0 as `job_02_1791818384402_z3er`. This is the idle-grace path firing in the field for the first time, with no hand near the keyboard: the nudge rescues a provider that refuses one request, not one that keeps refusing.
- **Review 1** (`job_02_1791818596239_13fb`, claude): spec green — the looped link is skipped with no error code named, the readable job and the no-meta directory beside it are still listed, and `throwIfNoEntry` is gone from the package. standards — two comments that described behaviour this change had removed: `runner.ts:188` still justified the removal with two fates a scan no longer produces, and `jobs.ts:106` opened a colon with "reports what it can read" and then listed what it drops.
- **Review 2** (`job_02_1791819108218_7dub`, claude): no finding on either axis. Both corrected comments are true of the code as it now stands.
