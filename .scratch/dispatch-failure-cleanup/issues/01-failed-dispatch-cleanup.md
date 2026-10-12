# 01: A failed dispatch cleans up after itself, and its refusal is readable

**What to build:** Two defects, both observed in a real fleet run on 2026-10-12. The evidence, with timestamps and the exact panes, is in `.scratch/fault-paths/issues/01-fault-fixture.md` under "Two real faults this round found".

## 1. A refused prompt must produce a readable, actionable error

When a dispatch reuses a ticket's existing pane, it re-prompts the standing agent. Herdr refuses that prompt when the agent is sitting at an approval:

```
{"error":{"code":"agent_blocked","message":"agent implement-01 is blocked and requires interactive input"}}
```

`runner.ts` builds every Herdr failure from `\`${bin} ${args.join(" ")}\``, and the prompt's argument is the whole task text, so the dispatch error quotes about 60 lines of brief before the one line that matters.

Required: a dispatch whose prompt is refused fails with a short error that names the pane and the agent, says the executor is waiting for a human at an approval and that the pane must be answered or escaped, and does not contain the task text. Keep Herdr's own reason (`agent_blocked` and its message) in the text — it is the actionable part.

Do not replace, kill, or work around the blocked agent, and do not open a second pane: an approval is a decision a human owes, and the pane holds the context a fix round is reusing. The claim is released by `extensions/index.ts` already; keep that.

Make the abbreviation general rather than prompt-specific: an argument Herdr receives is not echoed in full when it is longer than a line. Replace any single argv entry longer than 80 characters with a placeholder that says how long it was.

## 2. A dispatch that fails must not leave an orphan run directory

`runner.dispatch` writes `brief.md`, `schema.json`, and `task.txt` before it places the pane, and writes `meta.json` only after the task reaches the agent. A failure in between leaves a directory with no meta at all, and nothing reports it: `readMeta` calls it `absent`, so `listJobs` and `listStale` both skip it, and `FleetStatus` listed 15 jobs while the run root held 17 directories.

Required, both halves:

- A dispatch that returns an error after it created its run directory removes that directory. This includes a failed `agent start` (which already closes the tab it opened) and a failed `agent prompt`.
- A run directory that holds no `meta.json` is reported by `FleetStatus` as a leftover with its reason, instead of being skipped. The report already has a "run directories this release cannot read" note; a directory whose dispatch never finished belongs in that list, with a reason that says the dispatch did not finish. A directory that holds a readable `meta.json` is unaffected.

**Blocked by:** None (can start immediately)

**Status:** done

**Branch:** fleet/01-failed-dispatch

**Commits:** `81fefd9` (merged as `9e9e163`; this commit also carries ticket 02, which had no worktree of its own)

- [x] A `herdr agent prompt` failure leaves no run directory behind: the run root holds no entry for that job.
- [x] A failed `agent start` likewise leaves no run directory behind, and still closes the tab it opened.
- [x] The prompt-failure dispatch error names the pane and the agent, states that the executor is waiting at an approval, and is shorter than 1000 characters. (Measured: 435 characters.)
- [x] No line of the ticket text appears in that error: the test asserts a distinctive ticket sentence is absent.
- [x] `FleetStatus` counts a run directory with no `meta.json` as a leftover and gives its reason; a readable job is not counted as one.
- [x] `test/helpers/fake-herdr.mjs` gains a switch that makes `agent prompt` answer with `agent_blocked` and exit non-zero, the way the real CLI does.
- [x] `npm run check` passes: typecheck, tests, `npm run smoke`, and the planning filter check. (101 passing after the merge.)

**Out of scope:** Do not change the fix-round design: a fix round still re-prompts the same executor. Do not change the claim guard, the status vocabulary, the contract schemas, or `FleetHarvest`'s judgement. Do not make `FleetHarvest` or `FleetCleanup` accept a directory that has no `meta.json`; reporting the leftover in `FleetStatus` is the whole requirement.

## Comments

### Outcome (2026-10-12)

Fixed and merged: `81fefd9` on `fleet/01-failed-dispatch`, merged into main as `9e9e163`, `npm run check` 101 passing in the main checkout after the merge. Ticket 02 rides in the same commit for the reason recorded there.

Three review rounds, both axes folded separately each time. The two fix rounds this ticket was allowed were both used.

- **Round 1** (`job_01_1791816672688_navf`, claude): spec — both requirements implemented and verified against a live run, one gap. The new leftover branch reported every entry of the run root, so a plain file was announced as a dispatch that did not finish; verified with `.DS_Store` and `notes.txt`. standards — `README.md:173` still described the old list, and the new `FAKE_HERDR_START_FAIL` switch carried no comment. All three went into fix round 1.
- **Round 2** (`job_01_1791817500386_v25r`, claude): spec — one regression the fix round introduced. Filtering on the dirent's own type dropped a run directory reached through a symlink, which `readMeta` still reads, so `FleetStatus` and the run root disagreed again; verified by the same probe against `main` and against the worktree. standards — the comment at `extensions/index.ts:439` still said "leftovers from another release", and `jobs.ts:95` justified the filter with an example no file in this repository produces. All three went into fix round 2.
- **Round 3** (`job_01_1791817940949_5fv7`, claude): both axes flagged one thing — `statSync` raises `ELOOP` on a self-referential link, so `listJobs` and `listStale` threw and took `FleetStatus`, `FleetCleanup(all: true)` and `FleetDispatch`'s own executor choice with them. Reproduced here against the same probe (`listJobs -> THREW ELOOP` in the worktree, `listJobs -> [job_ok]` on `main`). The fix-round cap was reached, so the loop stopped and the human was asked; the answer was ticket 02, not a third round.

The pane did the job it was built for in every round: the reviewer's own probe is what turned each regression into a citable finding, and the two bugs this ticket fixes were found the same way.
