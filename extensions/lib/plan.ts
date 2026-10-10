/**
 * Dispatch planning: everything a tool call decides before a process exists.
 *
 * Pure: no fs, no process spawning, no pi imports, so the validation rules and
 * the exact wording of every rejection can be tested without a model call.
 * Filesystem preflight (worktree exists, git repo) happens in index.ts right
 * before dispatch; this module judges the parameters.
 */

import { resolve } from "node:path";
import { resolvePaneMode, type PaneMode } from "./panes.ts";
import { buildArgv, buildPrompt, schemaFor } from "./profiles.ts";
import { EXECUTOR_KINDS, TASK_KINDS, type ExecutorKind, type FleetSettings, type JobPaths, type TaskKind } from "./types.ts";

export interface DispatchParams {
	ticket: string;
	worktree: string;
	executor: string;
	task_kind: string;
	brief: string;
	base?: string;
	skill_pointer?: string;
	model?: string;
	fix_round?: number;
	timeout_ms?: number;
	/** Explicit pane choice; absent defers to PI_FLEET_PANES. */
	pane?: boolean;
}

export interface PlanContext {
	runningCount: number;
	/** HERDR_ENV value, for the auto pane decision. */
	herdrEnv?: string;
}

export interface DispatchPlan {
	id: string;
	ticket: string;
	worktree: string;
	executor: ExecutorKind;
	taskKind: TaskKind;
	model?: string;
	fixRound: number;
	base?: string;
	skillPointer?: string;
	timeoutMs: number;
	command: string[];
	prompt: string;
	/** The brief as written: the interactive form needs it, the one-shot form carries it in the prompt file. */
	brief: string;
	paths: JobPaths;
	now: number;
	/** True when the executor should run in a Herdr pane. */
	pane: boolean;
}

export type PlanFailure = { ok: false; message: string };
export type PlanResult = { ok: true; plan: DispatchPlan } | PlanFailure;

/**
 * Read settings once at load. `cwd` is a parameter, not a hidden read, so
 * tests can pin the resolution. The state dir is resolved to an absolute path
 * because a run dir is written by the orchestrator and read and written again
 * by the executor, whose cwd is the worktree: a relative path resolves against
 * two different roots and lands on no file (live codex failure: `Failed to read
 * output schema file .fleet/runs/.../schema.json: No such file or directory`).
 */
export function readSettings(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): FleetSettings {
	const stateDir = resolve(cwd, env.PI_FLEET_STATE_DIR || ".fleet");
	const maxConcurrent = parsePositive(env.PI_FLEET_MAX_CONCURRENCY, 4);
	const defaultTimeoutMs = parsePositive(env.PI_FLEET_TIMEOUT_MS, 1_800_000);
	const maxFixRound = parsePositive(env.PI_FLEET_MAX_FIX_ROUND, 2);
	return {
		stateDir,
		maxConcurrent,
		defaultTimeoutMs,
		maxFixRound,
		codexBin: env.PI_FLEET_CODEX_BIN || "codex",
		claudeBin: env.PI_FLEET_CLAUDE_BIN || "claude",
		gitGuard: (env.PI_FLEET_GIT_GUARD || "on").toLowerCase() !== "off",
		paneMode: parsePaneMode(env.PI_FLEET_PANES),
		herdrBin: env.PI_FLEET_HERDR_BIN || "herdr",
		notify: (env.PI_FLEET_NOTIFY || "on").toLowerCase() !== "off",
	};
}

function parsePositive(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parsePaneMode(value: string | undefined): PaneMode {
	const lowered = (value || "auto").toLowerCase();
	return lowered === "on" || lowered === "off" ? lowered : "auto";
}

function ticketId(ticket: string): string {
	// Job ids are file names under the run dir: strip anything a path would
	// choke on rather than rejecting the ticket's own naming convention.
	return ticket.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "ticket";
}

export function planDispatch(params: DispatchParams, settings: FleetSettings, ctx: PlanContext, now: number = Date.now()): PlanResult {
	const ticket = params.ticket?.trim();
	if (!ticket) return { ok: false, message: "ticket is required: the id or name of the tracker ticket this dispatch implements or reviews" };
	const worktree = params.worktree?.trim();
	if (!worktree) return { ok: false, message: "worktree is required: the absolute path of the git worktree this dispatch runs in" };
	if (!worktree.startsWith("/")) return { ok: false, message: `worktree must be an absolute path, got "${worktree}"` };
	const executor = params.executor?.trim();
	if (!executor) return { ok: false, message: `executor is required: one of ${EXECUTOR_KINDS.join(", ")}` };
	if (!EXECUTOR_KINDS.includes(executor as ExecutorKind)) {
		return { ok: false, message: `executor: unknown kind "${executor}", expected one of ${EXECUTOR_KINDS.join(", ")}` };
	}
	const taskKind = params.task_kind?.trim() || "implement";
	if (!TASK_KINDS.includes(taskKind as TaskKind)) {
		return { ok: false, message: `task_kind: unknown kind "${taskKind}", expected one of ${TASK_KINDS.join(", ")}` };
	}
	const brief = params.brief?.trim();
	if (!brief) return { ok: false, message: "brief is required: what the executor should build or review. Executors see the brief, not this conversation" };

	const kind = taskKind as TaskKind;
	if (kind === "review" && !params.base?.trim()) {
		return { ok: false, message: 'task_kind "review" requires base: the fixed point (commit, branch, or tag) to review against' };
	}

	if (ctx.runningCount >= settings.maxConcurrent) {
		return {
			ok: false,
			message: `at the concurrency cap (${settings.maxConcurrent} running). Harvest or wait for a dispatch to finish, then dispatch again — nothing was started.`,
		};
	}

	const fixRound = params.fix_round ?? 0;
	if (!Number.isInteger(fixRound) || fixRound < 0) return { ok: false, message: "fix_round must be a non-negative integer" };
	if (fixRound > settings.maxFixRound) {
		return {
			ok: false,
			message: `fix_round ${fixRound} exceeds the cap of ${settings.maxFixRound}. Escalate to the user instead of dispatching another fix round — the review-fix loop must stop somewhere.`,
		};
	}

	const timeoutMs = params.timeout_ms ?? settings.defaultTimeoutMs;
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return { ok: false, message: "timeout_ms must be a positive integer" };

	const safeTicket = ticketId(ticket);
	// A random suffix keeps two dispatches in the same millisecond for the same
	// ticket from clobbering each other's run dir.
	const nonce = Math.random().toString(36).slice(2, 6);
	const id = `job_${safeTicket}_${now}_${nonce}`;
	const runDir = `${settings.stateDir.replace(/\/$/, "")}/runs/${id}`;
	const paths: JobPaths = {
		promptPath: `${runDir}/brief.md`,
		schemaPath: `${runDir}/schema.json`,
		resultPath: `${runDir}/result.json`,
		stdoutPath: `${runDir}/stdout.log`,
		stderrPath: `${runDir}/stderr.log`,
		metaPath: `${runDir}/meta.json`,
		exitCodePath: `${runDir}/exit_code`,
	};

	const input = {
		ticket,
		worktree,
		executor: executor as ExecutorKind,
		taskKind: kind,
		brief,
		base: params.base?.trim() || undefined,
		skillPointer: params.skill_pointer?.trim() || undefined,
		model: params.model?.trim() || undefined,
		fixRound,
	};
	const command = buildArgv(input, paths, settings);
	const prompt = buildPrompt(input, paths.promptPath);
	const pane = resolvePaneMode(params.pane, settings.paneMode, ctx.herdrEnv);

	return {
		ok: true,
		plan: {
			id,
			ticket,
			worktree,
			executor: executor as ExecutorKind,
			taskKind: kind,
			model: input.model,
			fixRound,
			base: input.base,
			skillPointer: input.skillPointer,
			timeoutMs,
			command,
			prompt,
			brief,
			paths,
			now,
			pane,
		},
	};
}

export { schemaFor };

export type { FleetSettings };
