# Development Rules

## Commands

- `npm run check` — typecheck + tests + headless load check. Run before committing.
- `npm run smoke` — headless load check through pi's own loader, no model call.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run test` — `node --test test/*.test.ts`.

Tests must not hit the network: executor calls are faked with a stand-in that
honours the same argv (`-o`), and classifier calls are covered by pure
interpretation functions over canned answers.

## Roadmap

- Unfinished work lives in `TODO.md`. Its "下次开工入口" section names the entry
  point for the current session; do not duplicate that state here.

## Layout

- `extensions/index.ts` — pi extension entry: tool registration, gate and
  triage wiring, and the git guard handlers. Keep it thin.
- `extensions/lib/` — implementation modules (see README).
- Pure modules own the decisions, the wiring owns the I/O: `plan.ts` (dispatch
  validation and planning), `contract.ts` (contract validation), `frontier.ts`
  (ticket-graph frontier), `judgments.ts` (question catalog and interpretation),
  `gitguard.ts` (command screening), `panes.ts` (Herdr topology, run.sh text,
  cleanup decisions) stay free of fs, spawning, and pi imports so
  they test without a session or a model call. `supervise.ts` is the only module
  that spawns, and the only one that calls the herdr CLI.

## Invariants

- **Executor autonomy.** The argv carries output shaping only (`-o`,
  `--output-schema`, `--output-format`, `--json-schema`) plus the model
  override. Never add permission, tool-selection, or network flags: what tools
  an executor uses is the executor's own policy. Executor spend is never
  captured or attributed — executors bill their own accounts.
- **The contract is the only success signal.** A zero exit with a broken
  contract is `contract_failed`, never `complete`. The executor's final output
  must parse as the schema; prose around it fails.
- **Judgments are advisory and degradable.** A failed or missing classifier
  channel degrades to a note; it must never block a dispatch or a harvest.
  Thresholds live in code (settings), never in the model's discretion.
- **The disk is the source of truth.** Jobs survive the session; harvests of
  inherited jobs settle from disk evidence. Never kill by recorded pid without
  the in-memory child handle: after a session is gone, the pid may name a
  recycled process.
- **Fix rounds are capped in code.** Past the cap the dispatch refuses and the
  model escalates. A fix-round dispatch skips the brief gate (it narrows an
  already-gated brief).
- **One harvest reports once.** Re-harvesting a settled job must not re-run
  the triage or duplicate the ledger entry.
- **Panes stay open until cleanup says so.** A pane job's evidence is its own
  `exit_code` file, never the pid of the herdr CLI that launched it; a tab is
  closed only by `FleetCleanup`, only for settled jobs, and only for tabs this
  extension created. Pane channel failure degrades to a detached spawn.
- **The orchestrator never stashes, amends, or force-pushes.** `git stash`
  crosses worktrees through the shared `refs/stash`, and an amend or a force
  push invalidates a commit a review base or a fix round names. `gitguard.ts`
  blocks them in `tool_call` and `user_bash`; `PI_FLEET_GIT_GUARD=off` is the
  only escape and executors keep the ban in their prompt.
