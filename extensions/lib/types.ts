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
	/** Final exit code, written by the spawn-mode exit handler. */
	exitCodePath: string;
}

export interface PaneTargets {
	workspaceId: string;
	/** The tab this extension created for the job; FleetCleanup may close it. */
	tabId: string;
	paneId: string;
	label: string;
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
	/** How the process started: pi's own child, or a Herdr-managed interactive agent. */
	runner?: "spawn" | "agent";
	/** Herdr locations for an interactive job. */
	pane?: PaneTargets;
	/** The herdr agent name for an interactive job. */
	agentName?: string;
	/** Last agent lifecycle state a harvest observed. Records waiting-for-a-human; never decides success. */
	agentStatus?: string;
	/** When FleetCleanup closed the pane's tab; absent while it stays open. */
	paneClosedAt?: number;
	/** Why an interactive dispatch fell back to a detached spawn, if it did. */
	paneFallback?: string;
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
	/** Block git stash, git commit --amend, and force push in this session's bash calls (PI_FLEET_GIT_GUARD=off disables). */
	gitGuard: boolean;
	/** Run executors as interactive Herdr agents: auto = when this session sits in Herdr (HERDR_ENV=1). */
	paneMode: "auto" | "on" | "off";
	herdrBin: string;
	/** How long to wait for an executor TUI to come up before degrading to a spawn. */
	agentStartMs: number;
	/** Ping a human when an executor finishes (PI_FLEET_NOTIFY=off disables). */
	notify: boolean;
}

export const EXECUTOR_KINDS: readonly ExecutorKind[] = ["codex", "claude"];
export const TASK_KINDS: readonly TaskKind[] = ["implement", "review"];

export function isExecutorKind(value: string): value is ExecutorKind {
	return (EXECUTOR_KINDS as readonly string[]).includes(value);
}

export function isTaskKind(value: string): value is TaskKind {
	return (TASK_KINDS as readonly string[]).includes(value);
}
