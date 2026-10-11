/**
 * pi-fleet — plan with the bundled skills, then hand one ticket at a time to an
 * executor and judge what it produced.
 *
 * The division of labour this package enforces:
 *
 *   - The orchestrating model decides what to dispatch, writes nothing the
 *     executor reads except through this tool, and closes tickets.
 *   - The executor implements or reviews exactly one ticket, in its own
 *     worktree, in its own Herdr pane, with its own tools and its own spend.
 *   - This extension owns the mechanical protocol: the ticket claim, the run
 *     directory, the pane, the task text, and the contract check. A zero exit
 *     with a broken contract is `contract_failed`, never a quiet completion.
 *
 * The two skill sets ship in this package and are split on purpose. `planning`
 * is declared in the package manifest, so pi loads it. `execution` is not
 * declared, so pi never sees it; the extension hands an executor its absolute
 * path. A harness that can load `implement` will implement instead of
 * dispatching, so the boundary is enforced by what is loadable rather than by a
 * request to behave.
 *
 * Configuration (environment, read once at load):
 *   PI_FLEET_RUNS_DIR        run-directory root (default: .pi/fleet/runs, made absolute)
 *   PI_FLEET_MAX_FIX_ROUND   fix rounds before the dispatch is refused (default: 2)
 *   PI_FLEET_AGENT_START_MS  how long Herdr waits for an executor TUI (default: 90000)
 *   PI_FLEET_IDLE_GRACE_MS   idle-without-contract grace before failure (default: 120000)
 *   PI_FLEET_GIT_GUARD       on (default) | off — block git stash, commit --amend, force push
 *   PI_FLEET_CODEX_BIN       codex binary (default: codex)
 *   PI_FLEET_CLAUDE_BIN      claude binary (default: claude)
 *   PI_FLEET_HERDR_BIN       herdr binary (default: herdr)
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findGitHazard } from "./lib/gitguard.ts";
import { isAgentWaiting } from "./lib/herdr.ts";
import { ensureRunsDirIgnored } from "./lib/preflight.ts";
import { Runner } from "./lib/runner.ts";
import { defaultExecutor } from "./lib/selection.ts";
import { INSTALL_SCRIPT } from "./lib/skills.ts";
import { claimTicket, READY, setStatus } from "./lib/tickets.ts";
import { isExecutorKind, readSettings, type FleetRole, type JobMeta } from "./lib/types.ts";
import { wakeMessage, WATCH_THROTTLE_MS, WATCH_WAIT_SLICE_MS } from "./lib/watch.ts";

const execFileAsync = promisify(execFile);

const DISPATCH_DESCRIPTION = `Hand one ticket to one executor and get a job id back. The executor runs in its own git worktree, in a Herdr pane next to you, and writes a contract file when it stops.

An implement job leaves its changes uncommitted. The review job reads that working tree, and you commit only after the review passes.

What the tool does for you: claims the ticket (rewrites its Status line to "claimed"), creates the run directory, writes the brief and the JSON schema, opens or reuses the ticket's Herdr tab in the worktree's own workspace, starts the executor's own TUI, and delivers the task. When Herdr has closed that workspace — it closes an empty worktree workspace with the last tab cleanup closes — the tool reopens it instead of running the executor in the orchestrator's workspace. What it will not do: create the worktree, pick the executor's tools, set its permissions, or pay its bill.

The brief is what the executor sees — it never sees this conversation. Copy the ticket's text in; the ticket file itself stays out of the worktree.

Rules this tool enforces rather than leaves to you:
- role "review" needs base: the commit, branch, or tag the work was built on. The review reads the uncommitted working tree, so stage it with \`git -C <worktree> add -A\` before dispatching one.
- A review must run on the harness that did not write the code. Omit executor and the tool picks the other one on its own.
- fix_round is capped in code. Past the cap the tool refuses; escalate to the user instead of rephrasing the same brief.
- A ticket is claimable only from status "${"ready-for-agent"}", so two dispatches cannot take the same ticket.

A dispatch returns immediately: the executor is a Herdr agent, not a child of this turn. Do not report the ticket as done until a FleetHarvest returns contract_complete.`;

const HARVEST_DESCRIPTION = `Read a dispatched job and judge what it produced. This is the only place a job is decided.

Outcomes: running (harvest again later; a job waiting for you at an approval says so), contract_complete (the contract comes back inline), contract_failed (the exact field-level error), failed (the executor produced nothing; its own reason is reported when its output carries one).

Harvesting the same settled job twice is safe: the first harvest reports the job, later ones return the same artifacts without re-judging.

An executor's exit is not evidence. Herdr's idle and done mean "ready for input", not "finished" — a live run was idle mid-task and committed minutes later — so this tool only settles a job on the contract file, and on idleness that persists without one.`;

const STATUS_DESCRIPTION = `List the fleet jobs on disk: id, ticket, role, executor, state, fix round, and which pane tabs are still open. Jobs from earlier sessions appear here, because every job is read from its run directory rather than from this session's memory.

It does not compute a frontier. The tracker's own convention defines one: an issue file under \`.scratch/<feature>/issues/\` that is neither claimed nor done, with every ticket in its "Blocked by" line done, lowest number first. Read the files and pick; this tool only tells you what is already in flight.`;

const CLEANUP_DESCRIPTION = `Close the Herdr tabs that fleet jobs created, once those jobs have settled.

What it closes: only tabs this package created, and only when every job in them has been harvested. Never the worktree, never a pane you opened yourself. A tab holding an unsettled job is reported as blocked.

Closing the last tab of a worktree's workspace lets Herdr close that empty workspace too. That is expected: the next dispatch reopens it. The worktree and its files stay untouched either way.

The run directory and every log survive cleanup, so a closed tab loses no evidence. Read the pane's output and the file changes first: that is what the pane is for.`;

function textResult<T>(text: string, details: T): { content: { type: "text"; text: string }[]; details: T } {
	return { content: [{ type: "text", text }], details };
}

/**
 * One job as a line of the FleetStatus report. `running` here means "not yet
 * judged": whether the work landed is the contract's answer, not the agent's.
 */
function jobLine(meta: JobMeta): string {
	const state = meta.contractOk === undefined ? "running" : meta.contractOk ? "complete" : "contract_failed";
	const pane = meta.pane ? (meta.paneClosedAt === undefined ? ` · pane ${meta.pane.paneId}` : " · pane closed") : "";
	const status = meta.agentStatus ? ` · agent ${meta.agentStatus}` : "";
	const round = meta.fixRound > 0 ? ` · fix ${meta.fixRound}` : "";
	return `${meta.id} · ${meta.ticket} · ${meta.role}/${meta.executor} · ${state}${round}${pane}${status}`;
}

/** The run directory a job's meta lives in, for a report that points at the logs. */
function runDirOf(settings: { runsDir: string }, id: string): string {
	return `${settings.runsDir.replace(/\/$/, "")}/${id}`;
}

export default function fleetExtension(pi: ExtensionAPI) {
	const settings = readSettings();
	const runner = new Runner(settings);

	// -----------------------------------------------------------------------
	// Git guard

	/**
	 * Fleet work puts one repository across several worktrees and points reviews
	 * at commit shas. Three commands break that from the orchestrator's side:
	 * `refs/stash` is shared by every worktree, and an amend or a force push
	 * invalidates a commit a review base already names.
	 *
	 * The upstream guardrail skill blocks `push`, `reset --hard`, `clean -f` and
	 * `branch -D`, and only inside Claude Code. It does not block stash or amend,
	 * which is exactly the accident its own documentation describes, so this
	 * package keeps its own guard.
	 */
	function guardReport(command: string): string | undefined {
		const hazard = findGitHazard(command);
		if (!hazard) return undefined;
		return `pi-fleet git guard blocked this command:\n  ${hazard.segment}\n${hazard.reason}\nUse instead: ${hazard.alternative}`;
	}

	if (settings.gitGuard) {
		pi.on("tool_call", async (event) => {
			if (event.toolName !== "bash") return undefined;
			const reason = guardReport(String((event.input as { command?: unknown }).command ?? ""));
			return reason ? { block: true, reason } : undefined;
		});
		pi.on("user_bash", async (event) => {
			const reason = guardReport(event.command);
			return reason ? { result: { output: reason, exitCode: 1, cancelled: false, truncated: false } } : undefined;
		});
	}

	// -----------------------------------------------------------------------
	// Settle watcher

	/**
	 * Jobs this session waits on, and the loops that ask after them.
	 *
	 * A dispatch ends the turn, so without a watcher the loop only moves when the
	 * human speaks again. `pi.sendUserMessage` always starts a turn: that is the
	 * hook which carries a settled job back to the orchestrator by itself, so a
	 * finished build is harvested and reviewed without anyone typing a prompt.
	 *
	 * The waiting is Herdr's own state signal (`agent wait`), which returns the
	 * moment the executor changes lifecycle state. That signal is not a verdict:
	 * `idle` and `done` mean ready for input, so every wake-up harvests the run
	 * directory and the contract file still decides whether the work landed.
	 */
	const watched = new Map<string, JobMeta>();

	const sleep = (ms: number) =>
		new Promise<void>((resolve) => {
			setTimeout(resolve, ms).unref();
		});

	function stopWatching(id: string): void {
		watched.delete(id);
	}

	function watchJob(meta: JobMeta): void {
		if (!settings.autoContinue || meta.contractOk !== undefined || watched.has(meta.id)) return;
		watched.set(meta.id, meta);
		void watchLoop(meta.id);
	}

	async function watchLoop(id: string): Promise<void> {
		while (watched.has(id)) {
			const agent = watched.get(id)?.pane?.agentName;
			// A live name wakes this loop on the next state change. A job whose agent is
			// gone skips the wait, so harvest can settle it as failed.
			if (agent) await runner.waitAgent(agent, WATCH_WAIT_SLICE_MS);

			const report = await runner.harvest(id);
			if (report.kind === "running") {
				await sleep(WATCH_THROTTLE_MS);
				continue;
			}
			const meta = watched.get(id);
			// A human may have harvested this job while the wait was open. Then the
			// verdict is already read, and a second wake-up would be a false alarm.
			if (!meta) return;
			stopWatching(id);
			pi.sendUserMessage(wakeMessage(meta, report.kind), { deliverAs: "followUp" });
			return;
		}
	}

	// A job dispatched by an earlier session is still on disk. Adopt it, so a
	// reload or a restart resumes the loop instead of stranding the ticket.
	for (const job of runner.all()) watchJob(job);

	// -----------------------------------------------------------------------
	// Dispatch

	const dispatchTool = defineTool({
		name: "FleetDispatch",
		label: "Fleet Dispatch",
		description: DISPATCH_DESCRIPTION,
		promptSnippet: "Hand one ticket to a Codex or Claude executor in its own worktree and pane",
		promptGuidelines: [
			"Dispatch only a ticket whose blockers are done and whose text is complete: what to build, acceptance criteria, what is out of scope. A vague ticket costs a whole executor run.",
			"After dispatching, end your turn or do other work. The executor runs in a pane; do not poll it. Harvest on a later turn, and only then decide the ticket is done.",
			"Do not create the worktree here: run `herdr worktree create` first so the worktree arrives with its own workspace and its own pane column.",
		],
		parameters: Type.Object({
			ticket: Type.String({ description: "Absolute path of the ticket file, e.g. /repo/.scratch/login/issues/03-token-refresh.md. Its NN prefix is the ticket id recorded in the contract." }),
			worktree: Type.String({ description: "Absolute path of an existing git worktree to run in. Create it with `herdr worktree create` before dispatching." }),
			role: Type.String({ description: '"implement" builds the ticket and commits; "review" reviews committed work against base and reports two axes. A ticket gets both, in that order.' }),
			executor: Type.Optional(Type.String({ description: 'Which harness runs the job: "codex" or "claude". Omit to let the tool choose — codex for implement, and for review the harness that did not write the code.' })),
			base: Type.Optional(Type.String({ description: 'For role "review": the commit, branch, or tag to diff against. Required for reviews, and normally the branch the implement job reported in its contract.' })),
			fix_round: Type.Optional(Type.Number({ description: "0 for a first dispatch (default). Increment when re-dispatching after a review found blockers; capped, and the tool refuses past the cap." })),
			findings: Type.Optional(Type.Array(Type.String({ description: "One blocker finding, as the review reported it." }))),
			model: Type.Optional(Type.String({ description: "Model override passed through to the executor CLI. Omit for the executor's own default." })),
		}),
		execute: async (_toolCallId, params) => {
			const args = params as { ticket?: string; worktree?: string; role?: string; executor?: string; base?: string; fix_round?: number; findings?: string[]; model?: string };

			const role = args.role?.trim() ?? "";
			if (role !== "implement" && role !== "review") {
				return textResult(`role must be "implement" or "review", got ${role === "" ? "nothing" : `"${role}"`}`, { status: "rejected" });
			}
			const fleetRole: FleetRole = role;
			const ticketPath = args.ticket?.trim() ?? "";
			if (!ticketPath || !ticketPath.startsWith("/")) {
				return textResult("ticket must be the absolute path of a ticket file", { status: "rejected" });
			}
			if (!existsSync(ticketPath) || statSync(ticketPath).isDirectory()) {
				return textResult(`no ticket file at ${ticketPath}`, { status: "rejected" });
			}
			const worktree = args.worktree?.trim() ?? "";
			if (!worktree || !worktree.startsWith("/")) {
				return textResult("worktree must be an absolute path", { status: "rejected" });
			}
			if (!existsSync(worktree) || !statSync(worktree).isDirectory()) {
				return textResult(`worktree ${worktree} does not exist or is not a directory. Create it first: herdr worktree create`, { status: "rejected" });
			}
			if (!existsSync(`${worktree}/.git`)) {
				return textResult(`worktree ${worktree} is not a git checkout (no .git). An executor requires one.`, { status: "rejected" });
			}
			if (fleetRole === "review" && !args.base?.trim()) {
				return textResult('role "review" requires base: the fixed point to diff against. Use the branch the implement job reported.', { status: "rejected" });
			}
			const fixRound = args.fix_round ?? 0;
			if (!Number.isInteger(fixRound) || fixRound < 0) {
				return textResult("fix_round must be a non-negative integer", { status: "rejected" });
			}
			if (fixRound > settings.maxFixRound) {
				return textResult(
					`fix_round ${fixRound} exceeds the cap of ${settings.maxFixRound}. Escalate to the user with the worst finding instead of dispatching another round: the review-fix loop has to stop somewhere, and this is where.`,
					{ status: "rejected" },
				);
			}
			if (args.executor !== undefined && !isExecutorKind(args.executor)) {
				return textResult(`executor must be "codex" or "claude", got "${args.executor}"`, { status: "rejected" });
			}

			const claim = claimTicket(ticketPath);
			if (!claim.ok || !claim.ticket) return textResult(claim.error ?? `could not claim ${ticketPath}`, { status: "rejected" });
			const ticket = claim.ticket;

			// The project must ignore the fleet's run directory before it exists, or its
			// own `git status` shows fleet artifacts as untracked work — and a live run
			// once committed them alongside the ticket. Housekeeping, so a read-only
			// `.gitignore` degrades to a note instead of blocking the dispatch.
			const ignoreFix = ensureRunsDirIgnored(process.cwd(), settings.runsDir);
			const ignoreNote = ignoreFix.appended
				? `\nGitignore: appended "${ignoreFix.appended}" to ${join(process.cwd(), ".gitignore")} — fleet run directories are this package's, not the ticket's work.`
				: ignoreFix.error
					? `\nNote: could not update ${join(process.cwd(), ".gitignore")} (${ignoreFix.error}); fleet run directories may show there as untracked files.`
					: "";

			// A review runs on the harness that did not write the code. The tool knows
			// which one that was, so it decides rather than asking every caller to
			// remember.
			const executor = args.executor && isExecutorKind(args.executor) ? args.executor : defaultExecutor(fleetRole, runner.all(), ticket.id);

			const outcome = await runner.dispatch({
				ticketId: ticket.id,
				ticketPath,
				ticketText: readTicketText(ticketPath),
				worktree,
				role: fleetRole,
				executor,
				base: args.base?.trim() || undefined,
				fixRound,
				findings: args.findings,
				model: args.model?.trim() || undefined,
			});
			if (!outcome.ok) {
				// A claimed ticket with no job would be invisible to the next scan of the
				// frontier and unbuildable by hand, so a failed dispatch releases it.
				releaseClaim(ticketPath);
				return textResult(`dispatch failed, ticket ${ticket.id} released: ${outcome.error}`, { status: "rejected" });
			}
			const meta = outcome.meta;
			watchJob(meta);
			return textResult(
				`Dispatched ${meta.id} — ticket ${meta.ticket} ${meta.role} on ${meta.executor}.${meta.base ? ` Base: ${meta.base}.` : ""}\n` +
					`Pane: ${meta.pane?.paneId} (tab ${meta.pane?.tabId}, agent ${meta.pane?.agentName}). Watch it there, answer it if it asks you something, interrupt it with Esc.\n` +
					`Run directory: ${meta.runDir}\n` +
					`The executor writes its contract to ${meta.resultPath}. FleetHarvest judges it; until then the ticket is not done.${ignoreNote}`,
				{ status: "dispatched", jobId: meta.id, ticket: meta.ticket, runDir: meta.runDir, role: meta.role, executor: meta.executor, pane: meta.pane },
			);
		},
	});

	// -----------------------------------------------------------------------
	// Harvest

	const harvestTool = defineTool({
		name: "FleetHarvest",
		label: "Fleet Harvest",
		description: HARVEST_DESCRIPTION,
		promptSnippet: "Read a dispatch's contract and decide whether the work landed",
		promptGuidelines: [
			"Harvest every job you dispatched before saying any delegated work is done. contract_complete is the only success.",
			"On contract_failed, read the run directory and rewrite the ticket or the brief. Do not change the schema: it is fixed by this package.",
			"On a review, the two axes are reported separately and must be folded into your report the same way. A finding is only worth a fix round when it blocks merging.",
		],
		parameters: Type.Object({
			job_id: Type.String({ description: "The job id FleetDispatch returned." }),
		}),
		execute: async (_toolCallId, params) => {
			const jobId = String((params as { job_id?: string }).job_id ?? "").trim();
			if (!jobId) return textResult("job_id is required", { status: "rejected" });
			const report = await runner.harvest(jobId);
			const dir = runDirOf(settings, jobId);

			if (report.kind === "unknown") {
				return textResult(`${jobId} cannot be harvested: ${report.error}`, { status: "rejected", jobId });
			}
			if (report.kind === "running") {
				const meta = report.meta;
				const waiting = isAgentWaiting(report.status ?? "") ? ` It waits for you at an approval or question in pane ${meta.pane?.paneId ?? "?"} — answer it there, or press Esc.` : "";
				return textResult(`${jobId} is still running (agent ${report.status ?? "unknown"}).${waiting} Harvest again later: the executor is a pane, not a child of this turn.`, {
					status: "running",
					jobId,
					agentStatus: report.status,
				});
			}

			// `running`, `complete`, `contract_failed`, and `failed` all carry a readable
			// meta, so the bookkeeping below is safe; `unknown` returned above.
			const meta = report.meta;
			// A job the human harvested by hand needs no wake-up message later.
			stopWatching(jobId);
			if (meta.harvestedAt === undefined) {
				meta.harvestedAt = Date.now();
				// Persist through the runner's writer so the run directory and this
				// session agree about a settled job.
				runner.persist(meta);
			}

			if (report.kind === "contract_failed") {
				return textResult(`${jobId} finished but violated the contract: ${report.error}\nRun directory: ${dir}`, { status: "contract_failed", jobId, error: report.error });
			}
			if (report.kind === "failed") {
				return textResult(`${jobId} produced nothing: ${report.error}\nRun directory: ${dir}`, { status: "failed", jobId, error: report.error });
			}
			return textResult(
				`${jobId} contract_complete (ticket ${meta.ticket}, ${meta.role} on ${meta.executor}).\n\n${JSON.stringify(report.contract, null, 2)}\n\nRun directory: ${dir}\n` +
					(meta.role === "implement"
						? `Next: confirm the branch and commits exist, then close ticket ${meta.ticket} the tracker's way. The ticket is reviewed next, on the other harness.`
						: `Next: fold both axes into your report without merging them. Blocker findings earn a fix round; style and preference findings do not.`),
				{ status: "contract_complete", jobId, ticket: meta.ticket, role: meta.role, contract: report.contract },
			);
		},
	});

	// -----------------------------------------------------------------------
	// Status

	const statusTool = defineTool({
		name: "FleetStatus",
		label: "Fleet Status",
		description: STATUS_DESCRIPTION,
		promptSnippet: "List fleet jobs on disk, including jobs from earlier sessions",
		promptGuidelines: ["Call this when you need to see what is in flight, or after a reload, before deciding what to dispatch or harvest next."],
		parameters: Type.Object({}),
		execute: async () => {
			const jobs = runner.all();
			const stale = runner.stale();
			const openTabs = [...new Set(jobs.filter((job) => job.pane && job.paneClosedAt === undefined).map((job) => job.pane!.tabId))];
			const details = {
				jobs: jobs.map((job) => ({
					id: job.id,
					ticket: job.ticket,
					role: job.role,
					executor: job.executor,
					fixRound: job.fixRound,
					state: job.contractOk === undefined ? "running" : job.contractOk ? "complete" : "contract_failed",
					paneId: job.pane?.paneId,
					paneClosedAt: job.paneClosedAt,
				})),
				openTabs,
				stale,
			};
			const head =
				jobs.length === 0
					? `No fleet jobs under ${settings.runsDir}. The frontier of ready tickets lives in the tracker's own files, not here.`
					: `${jobs.length} job(s) on disk${openTabs.length > 0 ? `, ${openTabs.length} pane tab(s) still open` : ""}:\n${jobs.map(jobLine).join("\n")}`;
			// Leftovers from another release are named rather than hidden. A run
			// directory this release cannot read is not a job, so it is not counted,
			// not harvested, and not closed — but the user still needs to know it is
			// there and why it is inert.
			const staleNote =
				stale.length > 0
					? `\n\n${stale.length} run director${stale.length === 1 ? "y" : "ies"} this release cannot read (leftovers from an earlier pi-fleet):\n${stale.map((run) => `  ${run.id} — ${run.reason}`).join("\n")}\nDelete them, or dispatch their tickets again.`
					: "";
			return textResult(`${head}${staleNote}`, details);
		},
	});

	// -----------------------------------------------------------------------
	// Cleanup

	const cleanupTool = defineTool({
		name: "FleetCleanup",
		label: "Fleet Cleanup",
		description: CLEANUP_DESCRIPTION,
		promptSnippet: "Close settled fleet job pane tabs once the run is fully read",
		promptGuidelines: ["Close tabs after the last harvest of a run, not before: the pane is where the human reads the executor's output and checks the file changes."],
		parameters: Type.Object({
			job_id: Type.Optional(Type.String({ description: "Close one settled job's tab." })),
			all: Type.Optional(Type.Boolean({ description: "Close every tab whose jobs have all settled. Ignored when job_id is present." })),
		}),
		execute: async (_toolCallId, params) => {
			const args = params as { job_id?: string; all?: boolean };
			const jobId = args.job_id?.trim();
			if (jobId) {
				const result = await runner.closeTab(jobId);
				if (!result.ok) return textResult(`FleetCleanup refused: ${result.error}`, { status: "rejected", jobId });
				return textResult(result.alreadyClosed ? `${jobId}: tab already closed.` : `${jobId}: tab closed. The worktree and its files are untouched.`, {
					status: "closed",
					jobId,
					alreadyClosed: result.alreadyClosed === true,
				});
			}
			if (args.all !== true) {
				return textResult("FleetCleanup needs job_id or all: true.", { status: "rejected" });
			}
			const jobs = runner.all();
			const paneJobs = jobs.filter((job) => job.pane !== undefined);
			if (paneJobs.length === 0) return textResult("No pane jobs on disk; nothing to close.", { status: "noop", closed: [] });
			const tabs = new Map<string, string>();
			for (const job of paneJobs) if (job.pane && job.paneClosedAt === undefined) tabs.set(job.pane.tabId, job.id);
			const closed: string[] = [];
			const blocked: string[] = [];
			const failed: string[] = [];
			for (const [tabId, id] of tabs) {
				// A tab holding an unsettled job keeps its pane: the pane is where the human
				// reads the executor's output and checks the file changes.
				if (jobUnsettled(jobs, tabId)) {
					blocked.push(tabId);
					continue;
				}
				const result = await runner.closeTab(id);
				if (!result.ok) failed.push(`${tabId}: ${result.error}`);
				else if (!result.alreadyClosed) closed.push(tabId);
			}
			const notes = `${blocked.length > 0 ? `\nBlocked, not settled yet: ${blocked.join(", ")}. Harvest those jobs first.` : ""}${failed.length > 0 ? `\nFailed: ${failed.join("; ")}` : ""}`;
			return textResult(closed.length > 0 ? `Closed ${closed.length} tab(s): ${closed.join(", ")}.${notes}` : `Nothing to close.${notes}`, {
				status: closed.length > 0 ? "closed" : "noop",
				closed,
				blocked,
				failed,
			});
		},
	});

	pi.registerTool(dispatchTool);
	pi.registerTool(harvestTool);
	pi.registerTool(statusTool);
	pi.registerTool(cleanupTool);

	// -----------------------------------------------------------------------
	// Setup

	/**
	 * `/fleet-setup` installs the upstream skills into this project, filtered.
	 *
	 * It is a command rather than a tool on purpose. The install is a one-time
	 * project decision with a deterministic answer, and a model turn would only add
	 * a way to do it half-way. It is a command rather than a prompt template for the
	 * same reason: this extension knows where its own package lives, and a template
	 * would leave the model to find the script.
	 */
	pi.registerCommand("fleet-setup", {
		description: "Install the upstream planning skills into this project, filtered, without touching global settings",
		handler: async (_args, ctx) => {
			const run = async (extra: string[]) => {
				try {
					const { stdout, stderr } = await execFileAsync(process.execPath, [INSTALL_SCRIPT, "--target", process.cwd(), ...extra], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 });
					return { ok: true as const, text: `${stdout}${stderr}`.trim() };
				} catch (error) {
					const failure = error as { stdout?: string; stderr?: string; message?: string };
					return { ok: false as const, text: `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim() || failure.message || "the install script failed" };
				}
			};

			const already = await run(["--check"]);
			if (already.ok) {
				ctx.ui.notify("pi-fleet: the planning skills are already installed here", "info");
				return;
			}

			const installed = await run([]);
			if (!installed.ok) {
				ctx.ui.notify(`pi-fleet: setup failed\n${installed.text}`, "error");
				return;
			}
			// The loader read this project's settings at startup, so the new skills
			// appear after a reload and not before. Say so rather than letting the user
			// conclude that the command did nothing.
			ctx.ui.notify(`pi-fleet: planning skills installed\n${installed.text}\nRun /reload so this session picks them up.`, "info");
		},
	});
}

/**
 * Read the ticket's current text. The brief copies it, so the executor needs no
 * access to the tracker and an uncommitted ticket is still visible to it.
 */
function readTicketText(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/**
 * Return a ticket to the frontier after a dispatch that started nothing.
 *
 * Swallowing the error is deliberate: a ticket left claimed by a failed dispatch
 * is recoverable by hand, and throwing here would replace a useful tool result
 * with an unrelated filesystem error.
 */
function releaseClaim(path: string): void {
	try {
		writeFileSync(path, setStatus(readFileSync(path, "utf8"), READY), "utf8");
	} catch {
		// Nothing to do: the run directory is absent, so the tool result is the only
		// record that this ticket needs its status reset.
	}
}

function jobUnsettled(jobs: JobMeta[], tabId: string): boolean {
	return jobs.some((job) => job.pane?.tabId === tabId && job.contractOk === undefined);
}
