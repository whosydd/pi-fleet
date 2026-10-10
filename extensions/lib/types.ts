/**
 * Shared types for pi-fleet.
 *
 * A fleet job is one one-shot executor process: a `codex exec` or `claude -p`
 * run that starts in a worktree, follows a brief, and must end with a JSON
 * contract on disk. The orchestrating model never parses terminal text; it
 * reads the contract the supervisor validated.
 */

export type ExecutorKind = "codex" | "claude";

export type TaskKind = "implement" | "review";

/**
 * Lifecycle of one dispatch. `complete` means the process exited zero and the
 * contract file validated; a zero exit with a broken contract is
 * `contract_failed`, not `complete`.
 */
export type JobState = "running" | "complete" | "contract_failed" | "failed" | "timeout" | "rejected";

export interface JobPaths {
	promptPath: string;
	schemaPath: string;
	resultPath: string;
	stdoutPath: string;
	stderrPath: string;
	metaPath: string;
}

export interface JobMeta {
	id: string;
	ticket: string;
	worktree: string;
	executor: ExecutorKind;
	taskKind: TaskKind;
	model?: string;
	fixRound: number;
	/** Fixed point the review kind reviews against; recorded for the ledger. */
	base?: string;
	skillPointer?: string;
	command: string[];
	paths: JobPaths;
	startedAt: number;
	timeoutMs: number;
	state: JobState;
	pid?: number;
	finishedAt?: number;
	exitCode?: number | null;
	contractOk?: boolean;
	contractError?: string;
	briefChars?: number;
	/** Pre-dispatch Jev gate: the three brief-readiness nouls and the outcome. */
	gate?: GateRecord;
	/** Post-harvest Jev triage of review findings (review jobs only). */
	triage?: TriageRecord[];
	/** Set after the first harvest reported this job as settled to the model. */
	harvestReported?: boolean;
}

export interface GateRecord {
	entryPoints: number;
	acceptance: number;
	scopeBoundary: number;
	outcome: "pass" | "warn";
}

export interface TriageRecord {
	index: number;
	axis: "standards" | "spec";
	label: string;
	choice: string;
	confidence: number;
	uncertain: boolean;
}

export interface FleetSettings {
	/** Absolute run-dir root: a relative one would resolve against the executor's cwd (the worktree) instead of the session's. */
	stateDir: string;
	maxConcurrent: number;
	defaultTimeoutMs: number;
	maxFixRound: number;
	codexBin: string;
	claudeBin: string;
}

export const EXECUTOR_KINDS: readonly ExecutorKind[] = ["codex", "claude"];
export const TASK_KINDS: readonly TaskKind[] = ["implement", "review"];

export function isExecutorKind(value: string): value is ExecutorKind {
	return (EXECUTOR_KINDS as readonly string[]).includes(value);
}

export function isTaskKind(value: string): value is TaskKind {
	return (TASK_KINDS as readonly string[]).includes(value);
}
