# Development Rules

## Commands

- `npm run check` — typecheck + tests + headless load check + planning filter. Run before committing.
- `npm run smoke` — load the package through pi's own loader, no model call. It also asserts this package ships no upstream skill set.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run test` — `node --test test/*.test.ts`.
- `npm run install-planning` — what `/fleet-setup` runs. `npm run check-planning` verifies without writing.

Tests must not hit the network or call a model. The Herdr CLI is replaced by a
stand-in that answers the same argv and logs what it was asked.

## Layout

- `extensions/index.ts` — pi extension entry: four tool definitions, the `/fleet-setup` command, the git guard handlers, and the small decisions that need job state. Keep it thin.
- `extensions/lib/` — implementation modules. `runner.ts` is the only module that spawns, and the only one that calls the herdr CLI. `herdr.ts`, `brief.ts`, `contract.ts`, `gitguard.ts`, `selection.ts`, and `tickets.ts` own the decisions and stay free of spawning so they test without a session.
- `skills/manifest.json` — the upstream names in the `planning` and `execution` lists, plus the `excluded` map and its reasons. `$`-prefixed keys in `excluded` are shared explanations, not skills. Both live lists are names this package relies on, not content it ships.
- `skills/fleet/` — this package's own orchestrating skill. The only skill this package declares, and the only skill it ships.
- `scripts/install-planning.mjs` — writes the filtered upstream install into a project's `.pi/settings.json`.
- `extensions/lib/preflight.ts` — the one project mutation this package makes: the project's `.gitignore` must cover `.pi/fleet/`, or the fleet's artifacts appear as the project's untracked work.

There is no `skills/planning/` and no `skills/execution/`. The planning set is installed from upstream into each project, and the execution set comes from the executor's own harness. See the README for what each copy cost.

## Invariants

- **The skill split is the boundary.** `implement` and the upstream review skill must never be loadable by pi. A harness that can load `implement` will implement instead of dispatching, so the split is enforced by what is loadable, not by an instruction.
- **This package ships no upstream skill.** The planning set is installed into the project so it tracks upstream. The execution set comes from the executor's own harness and is named, never pointed at: a second copy puts two revisions of one skill in one context. `ROLE_SKILLS` in `brief.ts` is the only place a skill name is written.
- **The review method is text in this package, not a file from upstream.** The two axes, the rule against merging them, and the anti-recursion guard live in `brief.ts`. Upstream has not shipped the guard, and both of its installs run the axes in sub-agents without forbidding more.
- **A filter pattern that matches nothing fails silently.** pi strips no leading `./`, and reports no diagnostic when a pattern matches no file. The list comes from `skills/manifest.json`, and `check-planning` proves the committed filter still matches it.
- **Nothing compares the manifest to upstream.** `pi update` is the only thing that moves the upstream clone, and it moves the clone to whatever `main` is. A rename upstream then lands as a skill missing from the `/skill:` list, and the fix is an edit to `skills/manifest.json` plus `/fleet-setup`. A check that runs before the update reports a state no install is in.
- **`excluded` is documentation.** Nothing verifies that its keys still exist upstream. It records which upstream skills this package deliberately does not use, and why. A `$`-prefixed key is a shared explanation; a `$`-prefixed value is a pointer to another key in that same map.
- **The contract is the only success signal.** A zero exit with a broken contract is `contract_failed`, never `complete`. Herdr's `idle` and `done` mean ready for input, not finished.
- **Exactly one kind of delivery: a Herdr pane.** No detached fallback. A commit from a worktree needs git metadata outside it, and an executor sandbox cannot write that.
- **Herdr owns the process.** Liveness is a question for `herdr agent get`, never a pid table or an exit handler. Nothing about a job is held in session memory: the run directory is the source of truth.
- **One claim per ticket, in code.** `FleetDispatch` writes `Status: claimed` and refuses a second claim. A dispatch that starts nothing releases it.
- **The reviewer is never the harness that wrote the code.** The tool reads the build job's executor and picks the other one when the caller omits `executor`.
- **Fix rounds are capped in code.** Past `PI_FLEET_MAX_FIX_ROUND` the dispatch refuses; the human decides from there.
- **Caps and claims live in code; everything else about a ticket is the model's.** `setStatus` is the only tracker write this package makes.
- **The executor never reads the ticket file.** The brief copies the ticket's text, so an uncommitted ticket is still visible inside the worktree.
- **The upstream skills do not fully cover the loop.** `implement` self-reviews and `code-review` can recurse; `brief.ts` carries the two lines that stop both. Do not remove them.
- **The orchestrator never stashes, amends, or force-pushes.** `gitguard.ts` blocks them in `tool_call` and `user_bash`; `PI_FLEET_GIT_GUARD=off` is the only escape. The upstream guardrail skill blocks a different set and only inside Claude Code.
- **A pane stays open until cleanup says so.** Only tabs this package created are closed, and only for settled jobs.

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles keep their default strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
