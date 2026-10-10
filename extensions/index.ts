/**
 * pi-fleet — fleet orchestration for pi.
 *
 * Dispatch one-shot executors (`codex exec`, `claude -p`) against tickets in
 * git worktrees, enforce the result contract, and recompute the frontier.
 * The division of labour this extension enforces:
 *
 *   - The orchestrating model decides WHAT to dispatch and writes the brief.
 *   - The executor process does the ticket's work and stops at a commit.
 *   - This extension owns the mechanical protocol: spawn, timeout, contract
 *     validation, fix-round caps. It never decides whether a
 *     ticket is truly done — closing tickets stays with the model.
 *
 * A dispatch is detached: it returns a job id and the turn continues. Harvest
 * happens on a later turn (FleetHarvest), usually after the user pings or the
 * model checks back. Jobs survive the session: state lives on disk under
 * PI_FLEET_STATE_DIR (default .fleet, resolved to an absolute path at load so
 * the executor's worktree cwd never resolves a run-dir path against itself).
 *
 * Jev judgments (degradable, PI_FLEET_JUDGMENTS=off disables): the
 * pre-dispatch gate turns brief readiness into three thresholded nouls, and
 * the review triage turns review findings into blocker/style/ignore choices.
 * Both are advisory inputs to the model, never a replacement for its
 * judgment, and a failed judgment channel must never block a dispatch.
 *
 * Configuration (environment, read once at load — reload to change):
 *   PI_FLEET_STATE_DIR         run-dir root (default: .fleet, made absolute)
 *   PI_FLEET_MAX_CONCURRENCY   concurrent executors (default: 4)
 *   PI_FLEET_TIMEOUT_MS        default wall-clock per job (default: 1800000)
 *   PI_FLEET_MAX_FIX_ROUND     fix-round cap before escalation (default: 2)
 *   PI_FLEET_CODEX_BIN         codex binary (default: codex)
 *   PI_FLEET_CLAUDE_BIN        claude binary (default: claude)
 *   PI_FLEET_JUDGMENTS         on (default) | off — Jev gate and triage
 *   PI_FLEET_JUDGE_PROVIDER    classifier provider (default: typesafe)
 *   PI_FLEET_JUDGE_ID          classifier id (default: jev-latest)
 *   PI_FLEET_GATE_FLOOR        noul hard floor, refuse below (default: 0.7)
 *   PI_FLEET_GATE_WARN         noul warn line (default: 0.85)
 *   PI_FLEET_TRIAGE_CONFIDENCE triage confidence floor (default: 0.8)
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildGateContext,
	buildTriageContext,
	classifyViaRegistry,
	interpretGate,
	interpretTriage,
	readJudgmentSettings,
	type ClassifyRegistry,
	type TriageFinding,
	type TriageVerdict,
} from "./lib/judgments.ts";
import { dispatchedEntry, harvestedEntry } from "./lib/ledger.ts";
import { planDispatch, readSettings, type DispatchParams } from "./lib/plan.ts";
import { Supervisor, type HarvestOutcome } from "./lib/supervise.ts";
import { isExecutorKind, isTaskKind, type JobMeta } from "./lib/types.ts";
const DISPATCH_TOOL_DESCRIPTION = `Dispatch a one-shot executor (codex exec or claude -p) to implement or review one ticket in its own git worktree. Detached: returns a job id immediately; harvest with FleetHarvest on a later turn.

Rules the tool enforces (it refuses instead of guessing):
- The brief is what the executor sees. Write it complete: seam list, spec pointer, acceptance criteria. Executors never see this conversation.
- The Jev gate scores implement briefs on three nouls (entry points, acceptance criteria, scope boundary). Below the floor the dispatch is refused with the missing dimensions named; between floor and warn line it proceeds with a warning. Gate unavailable degrades to a note, never a block.
- task_kind "review" needs base: the fixed point to diff against. Reviews see committed work only, so commit-before-review is the caller's job (verify with git log <base>..HEAD).
- fix_round is capped; past the cap the tool refuses and you should escalate to the user.
- Executors are told to stop at a commit and never close tickets. Closing the ticket and recomputing the frontier is yours, after a contract_complete harvest.

Contract: the executor's final output must be JSON. implement jobs report ticket/status/branch/commits/tests; review jobs report per-axis worst issues (standards + spec, never merged). The tool validates it; a zero exit with a broken contract is contract_failed, not complete.`;

const HARVEST_TOOL_DESCRIPTION = `Harvest a dispatched fleet job: checks whether the executor process finished, validates its result contract, and reports the outcome with the run dir for full logs.

Outcomes: running (harvest again later), contract_complete (fold the result in and decide: close the ticket? dispatch the next frontier ticket?), contract_failed (read contract_error; fix the brief, not the schema), failed / timeout (read the run dir's stderr.log).

A job you dispatched is not finished until a harvest says contract_complete. Do not close tickets, do not report the spec as done, and do not dispatch dependents before that.

Review jobs get a Jev triage on harvest: each finding is classified blocker/style/ignore. Only blockers should consume a fix round; uncertain verdicts are flagged for you to read yourself. Triage unavailable degrades to a note, never a block.`;

const STATUS_TOOL_DESCRIPTION = `List fleet jobs: id, ticket, executor, task kind, state, fix round. Use it to rehydrate after a reload or to pick what to harvest next. Inherited jobs from a dead session show here after loadFromDisk.`;

function textResult<T>(text: string, details: T): { content: { type: "text"; text: string }[]; details: T } {
	return { content: [{ type: "text", text }], details };
}

function jobLine(meta: JobMeta): string {
	const gate = meta.gate ? ` · gate ${meta.gate.outcome}` : "";
	return `${meta.id} · ${meta.ticket} · ${meta.executor}/${meta.taskKind} · ${meta.state} · fix ${meta.fixRound}${gate}`;
}

export default function fleetExtension(pi: ExtensionAPI) {
	const settings = readSettings();
	const judgeSettings = readJudgmentSettings();
	const supervisor = new Supervisor(settings);

	pi.on("session_start", async (_event, ctx) => {
		const loaded = supervisor.loadFromDisk();
		if (loaded > 0) {
			// Stale "running" metas settle on the next harvest; say what exists.
			ctx.ui.notify(`pi-fleet: rehydrated ${loaded} job(s) from ${settings.stateDir}`, "info");
		}
	});

	pi.on("session_shutdown", () => {
		supervisor.clearTimers();
		supervisor.persistAll();
	});

	/**
	 * Run the Jev gate over a brief. Degrades to undefined on any channel
	 * failure: an unavailable judgment channel must not block dispatching.
	 */
	async function gateBrief(brief: string, registry: ClassifyRegistry): Promise<{ verdict?: ReturnType<typeof interpretGate>; note?: string }> {
		if (!judgeSettings.enabled) return {};
		try {
			const attempt = await classifyViaRegistry(registry, judgeSettings, buildGateContext(brief));
			if (!attempt.ok) return { note: `judgment channel unavailable, gate skipped (${attempt.reason})` };
			return { verdict: interpretGate(attempt.answers, { floor: judgeSettings.gateFloor, warn: judgeSettings.gateWarn }) };
		} catch (error) {
			return { note: `judgment channel failed, gate skipped (${error instanceof Error ? error.message : String(error)})` };
		}
	}

	const dispatchTool = defineTool({
		name: "FleetDispatch",
		label: "Fleet Dispatch",
		description: DISPATCH_TOOL_DESCRIPTION,
		promptSnippet: "Dispatch one-shot executor agents against tickets in worktrees",
		promptGuidelines: [
			"Use FleetDispatch for a ticket that is fully specified and ready to build AFK, or for an independent review of committed work. For work that is still vague, grill first; do not dispatch.",
			"A dispatch is detached. Keep working or end your turn; the executor is a separate process. Do not report the ticket as done until a FleetHarvest returns contract_complete.",
			"Fix rounds are capped. When the cap refuses, escalate to the user with the worst finding instead of rephrasing the same brief.",
		],
		parameters: Type.Object({
			ticket: Type.String({ description: "Ticket id or name from the tracker, e.g. '42' or 'auth-refactor'. Recorded in the job and the contract." }),
			worktree: Type.String({ description: "Absolute path of the git worktree the executor runs in. Create it yourself (git worktree add) before dispatching." }),
			executor: Type.String({ description: "Which executor binary runs the job: 'codex' or 'claude'." }),
			task_kind: Type.Optional(
				Type.String({ description: "'implement' (default) builds the ticket and commits; 'review' reviews committed work against base and reports two axes." }),
			),
			brief: Type.String({ description: "Complete instructions for the executor: what to build or review, seams, spec pointer, acceptance criteria. This is all it sees." }),
			base: Type.Optional(Type.String({ description: "For task_kind 'review': the fixed point (commit, branch, tag) to diff against. Required for reviews." })),
			skill_pointer: Type.Optional(Type.String({ description: "Absolute path of a SKILL.md the executor should load and follow, e.g. the tdd skill. Executors cannot auto-load skills." })),
			model: Type.Optional(Type.String({ description: "Model override passed to the executor CLI. Omit for the executor's default." })),
			fix_round: Type.Optional(Type.Number({ description: "0 for a first dispatch (default). Increment when re-dispatching after review findings; capped." })),
			timeout_ms: Type.Optional(Type.Number({ description: "Wall-clock limit for the executor process. Default PI_FLEET_TIMEOUT_MS." })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const args = params as DispatchParams;
			if (args.executor && !isExecutorKind(args.executor)) {
				return textResult(`executor: unknown kind "${args.executor}", expected codex or claude`, { status: "rejected" });
			}
			if (args.task_kind && !isTaskKind(args.task_kind)) {
				return textResult(`task_kind: unknown kind "${args.task_kind}", expected implement or review`, { status: "rejected" });
			}

			// Filesystem preflight: the plan module judges parameters; the tool
			// judges the machine. A worktree that is not a git checkout is a
			// rejection, not a spawn that dies in stderr.log (codex requires a
			// git repository; worktrees carry .git as a file).
			if (!args.worktree || !args.worktree.startsWith("/")) {
				return textResult("worktree must be an absolute path to an existing git worktree", { status: "rejected" });
			}
			if (!existsSync(args.worktree) || !statSync(args.worktree).isDirectory()) {
				return textResult(`worktree "${args.worktree}" does not exist or is not a directory. Create it first: git worktree add <path> -b <branch>`, { status: "rejected" });
			}
			if (!existsSync(join(args.worktree, ".git"))) {
				return textResult(`worktree "${args.worktree}" is not a git checkout (no .git). Executors require a git repository.`, { status: "rejected" });
			}

			const planned = planDispatch(args, settings, { runningCount: supervisor.runningCount() });
			if (!planned.ok) {
				return textResult(planned.message, { status: "rejected" });
			}
			const plan = planned.plan;

			// Jev gate: three atomic nouls over the brief. Refuse below the
			// floor with the missing dimensions named; warn between floor and
			// warn line; degrade silently (with a note) when the channel is out.
			// A fix round narrows an already-gated brief to named findings, so the
			// gate would misread it as under-specified; skip it.
			const gate = plan.fixRound > 0 ? {} : await gateBrief(args.brief, ctx.modelRegistry as unknown as ClassifyRegistry);
			if (gate.verdict?.outcome === "refuse") {
				const missing = gate.verdict.missing.map((dimension) => dimension.replace(/_/g, " ")).join(", ");
				return textResult(
					`Dispatch refused: the brief looks under-specified (${missing} below the ${judgeSettings.gateFloor} readiness floor).\n` +
						`Fix the brief before dispatching: name the entry points or APIs, add checkable acceptance criteria, state what is out of scope.\n` +
						`Probabilities: ${JSON.stringify(gate.verdict.probabilities)}`,
					{ status: "rejected", gate: gate.verdict },
				);
			}
			const gateRecord = gate.verdict
				? {
						entryPoints: gate.verdict.probabilities.entry_points,
						acceptance: gate.verdict.probabilities.acceptance,
						scopeBoundary: gate.verdict.probabilities.scope_boundary,
						outcome: gate.verdict.outcome === "warn" ? ("warn" as const) : ("pass" as const),
					}
				: undefined;
			const warnNote =
				gate.verdict?.outcome === "warn"
					? `\nGate warning: weak dimensions (${gate.verdict.weak.map((dimension) => dimension.replace(/_/g, " ")).join(", ")}). The dispatch proceeds; consider strengthening the brief next round.`
					: "";
			const channelNote = gate.note ? `\nNote: ${gate.note}.` : "";

			let meta: JobMeta;
			try {
				meta = supervisor.dispatch(plan, args.brief, gateRecord);
			} catch (error) {
				return textResult(`dispatch failed: ${error instanceof Error ? error.message : String(error)}`, { status: "rejected" });
			}
			const entry = dispatchedEntry(meta);
			pi.appendEntry(entry.customType, entry.data);
			const skill = plan.skillPointer ? `\nSkill pointer: ${plan.skillPointer}` : "";
			return textResult(
				`Dispatched ${meta.id} (${meta.executor}/${meta.taskKind}) for ticket ${meta.ticket} in ${meta.worktree}.${gateRecord ? `\nGate: ${gateRecord.outcome} (entry ${gateRecord.entryPoints.toFixed(2)}, acceptance ${gateRecord.acceptance.toFixed(2)}, scope ${gateRecord.scopeBoundary.toFixed(2)})` : ""}${warnNote}${channelNote}\nRun dir: ${settings.stateDir}/runs/${meta.id}\nHarvest with FleetHarvest when you check back — the process runs detached and survives this session.${skill}`,
				{ status: "dispatched", jobId: meta.id, ticket: meta.ticket, runDir: `${settings.stateDir}/runs/${meta.id}`, gate: gateRecord },
			);
		},
	});

	const harvestTool = defineTool({
		name: "FleetHarvest",
		label: "Fleet Harvest",
		description: HARVEST_TOOL_DESCRIPTION,
		promptSnippet: "Collect finished fleet jobs and validate their result contracts",
		promptGuidelines: [
			"Harvest every job you dispatched before claiming any delegated work is done. contract_complete is the only success.",
			"On contract_failed, read the run dir and fix the brief; the schema is fixed by this extension and is not the thing to change.",
			"On contract_complete for an implement job: verify the branch and commits, close the ticket your tracker's way, then recompute what is ready next.",
		],
		parameters: Type.Object({
			job_id: Type.String({ description: 'The job id returned by FleetDispatch, e.g. "job_42_1699999999".' }),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const jobId = String((params as { job_id?: string }).job_id ?? "").trim();
			if (!jobId) return textResult("job_id is required", { status: "rejected" });
			if (!supervisor.get(jobId)) {
				return textResult(`unknown job "${jobId}". FleetStatus lists what this session knows.`, { status: "rejected" });
			}
			const report = supervisor.refresh(jobId);
			const outcome: HarvestOutcome = report.outcome;
			if (outcome.kind === "running") {
				return textResult(`${jobId} is still running (executor ${supervisor.get(jobId)!.executor}, started ${Math.round((Date.now() - supervisor.get(jobId)!.startedAt) / 1000)}s ago). Harvest again later.`, {
					status: "running",
				});
			}
			const meta = outcome.meta;
			// Idempotent harvest: the first settled harvest reports the job to
			// the model; later harvests return the same artifacts without
			// re-judging the contract, re-running the triage, or re-writing the
			// ledger entry.
			const alreadyReported = meta.harvestReported === true;
			if (!alreadyReported) {
				const harvested = harvestedEntry(meta, outcome.kind, outcome.kind === "contract_failed" || outcome.kind === "failed" ? outcome.error : undefined);
				pi.appendEntry(harvested.customType, harvested.data);
				meta.harvestReported = true;
				supervisor.persist(meta);
			}
			if (outcome.kind === "contract_failed") {
				return textResult(`${jobId} finished but violated the contract: ${outcome.error}\nRun dir: ${meta.paths.metaPath.replace(/\/meta\.json$/, "")} (stdout.log, stderr.log, result.json)`, {
					status: "contract_failed",
					jobId,
					error: outcome.error,
				});
			}
			if (outcome.kind === "failed") {
				return textResult(`${jobId} failed: ${outcome.error}\nRun dir: ${meta.paths.metaPath.replace(/\/meta\.json$/, "")}`, { status: "failed", jobId });
			}

			// contract_complete: hand the model the parsed contract, not the file.
			const { readFileSync } = await import("node:fs");
			let contract: unknown;
			try {
				contract = JSON.parse(readFileSync(meta.paths.resultPath, "utf8"));
			} catch (error) {
				return textResult(
					`${jobId} harvest could not read result.json: ${error instanceof Error ? error.message : String(error)}. Inspect the run dir by hand.`,
					{ status: "failed", jobId },
				);
			}
			const contractText = JSON.stringify(contract, null, 2);

			// Jev triage for review jobs: one choice per finding. Blockers are
			// the only findings that should consume fix rounds; uncertain
			// verdicts are flagged for the model to read itself.
			const axes = contract as { standards?: unknown; spec?: unknown };
			let triageNote = "";
			let triageRecords: JobMeta["triage"];
			if (meta.triage) {
				// Cached from a previous harvest: report it again without re-judging.
				triageRecords = meta.triage;
				const blockers = meta.triage.filter((record) => record.choice === "blocker");
				const uncertain = meta.triage.filter((record) => record.uncertain);
				triageNote =
					`\n\nTriage (cached): ${blockers.length} blocker(s), ${meta.triage.length - blockers.length - uncertain.length} style/ignore, ${uncertain.length} uncertain.` +
					(uncertain.length > 0 ? ` Read these yourself before acting: ${uncertain.map((record) => `#${record.index}`).join(", ")}.` : "");
			} else if (
				judgeSettings.enabled &&
				meta.taskKind === "review" &&
				!meta.triage &&
				axes.standards &&
				axes.spec
			) {
				const standardsFindings = (axes.standards as { findings?: unknown }).findings as { rule?: string; file?: string; line?: number; quote?: string }[] | undefined;
				const specFindings = (axes.spec as { findings?: unknown }).findings as { file?: string; line?: number; quote?: string }[] | undefined;
				const findings: TriageFinding[] = [
					...(standardsFindings ?? []).map((finding) => ({ axis: "standards" as const, label: finding.rule ?? finding.quote ?? "standards finding", file: finding.file, line: finding.line, quote: finding.quote })),
					...(specFindings ?? []).map((finding) => ({ axis: "spec" as const, label: finding.quote ?? "spec finding", file: finding.file, line: finding.line, quote: finding.quote })),
				];
				if (findings.length > 0) {
					try {
						const attempt = await classifyViaRegistry(ctx.modelRegistry as unknown as ClassifyRegistry, judgeSettings, buildTriageContext(findings));
						if (attempt.ok) {
							const verdicts: TriageVerdict[] = interpretTriage(attempt.answers, findings.length, judgeSettings.triageConfidence);
							triageRecords = verdicts.map((verdict, index) => ({
								index: verdict.index,
								axis: findings[index].axis,
								label: findings[index].label,
								choice: verdict.choice,
								confidence: verdict.confidence,
								uncertain: verdict.uncertain,
							}));
							meta.triage = triageRecords;
							supervisor.persist(meta);
							const blockers = verdicts.filter((verdict) => verdict.choice === "blocker");
							const uncertain = verdicts.filter((verdict) => verdict.uncertain);
							triageNote =
								`\n\nTriage: ${blockers.length} blocker(s), ${verdicts.length - blockers.length - uncertain.length} style/ignore, ${uncertain.length} uncertain.` +
								(blockers.length > 0
									? ` Only blockers consume a fix round: ${blockers.map((verdict) => `#${verdict.index} (${findings[verdict.index].axis})`).join(", ")}.`
									: "") +
								(uncertain.length > 0
									? ` Read these yourself before acting: ${uncertain.map((verdict) => `#${verdict.index}`).join(", ")}.`
									: "");
						} else {
							triageNote = `\n\nTriage unavailable (${attempt.reason}); read the findings yourself.`;
						}
					} catch (error) {
						triageNote = `\n\nTriage failed (${error instanceof Error ? error.message : String(error)}); read the findings yourself.`;
					}
				}
			}

			return textResult(
				`${jobId} contract_complete (executor ${meta.executor}/${meta.taskKind}).\n\n${contractText}\n\nRun dir: ${meta.paths.metaPath.replace(/\/meta\.json$/, "")}\nNext: for an implement job, close the ticket and dispatch the next ready one; for a review job, fold both axes into your report without merging them.${triageNote}`,
				{ status: "contract_complete", jobId, contract, triage: triageRecords },
			);
		},
	});

	const statusTool = defineTool({
		name: "FleetStatus",
		label: "Fleet Status",
		description: STATUS_TOOL_DESCRIPTION,
		promptSnippet: "List dispatched fleet jobs and their states",
		promptGuidelines: ["Call FleetStatus with no arguments when you need to see what is in flight or what to harvest next."],
		parameters: Type.Object({}),
		execute: async () => {
			const jobs = supervisor.all();
			if (jobs.length === 0) {
				return textResult("No fleet jobs in this session. Jobs from earlier sessions appear after loadFromDisk (a reload rehydrates them).", { jobs: [] });
			}
			const running = supervisor.runningCount();
			const lines = jobs.map(jobLine);
			return textResult(`${jobs.length} job(s), ${running} running:\n${lines.join("\n")}`, {
				jobs: jobs.map((job) => ({ id: job.id, ticket: job.ticket, state: job.state, executor: job.executor, taskKind: job.taskKind, fixRound: job.fixRound })),
			});
		},
	});

	pi.registerTool(dispatchTool);
	pi.registerTool(harvestTool);
	pi.registerTool(statusTool);
}
