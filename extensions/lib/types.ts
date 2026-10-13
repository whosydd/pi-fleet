/**
 * Shared types and settings for pi-fleet.
 *
 * A fleet job is one ticket handed to one executor: a dispatcher created a
 * worktree and a Herdr pane, started the executor's own TUI in it, and told it
 * to read a brief and write a contract. The executor owns its process; pi owns
 * nothing but the run directory and the pane handle.
 *
 * Because Herdr owns the process, a job's liveness is a question for Herdr, not
 * for a pid table. Nothing here is a timer or a child handle.
 */

import { resolve } from "node:path";

export type ExecutorKind = "codex" | "claude";

/** One ticket is implemented, then reviewed by the other harness. Never both by one. */
export type FleetRole = "implement" | "review";

/**
 * `dispatched` means the agent was started and told to work. It is the only
 * pre-settlement state: whether the work landed is the contract's answer, and
 * the contract is read at harvest time.
 */
export type JobState = "dispatched" | "complete" | "contract_failed" | "failed";

export interface PaneTargets {
	workspaceId: string;
	/** The tab this package created for the ticket; FleetCleanup may close it. */
	tabId: string;
	paneId: string;
	/** The Herdr agent name, unique per job. */
	agentName: string;
}

export interface JobMeta {
	/**
	 * The shape of this record.
	 *
	 * Bumped when a field changes meaning. The run directory is the source of
	 * truth, which means an older release's run directories sit next to this one's
	 * and must be told apart: a record from a previous shape has no `role`, so
	 * reading it as a job reports `undefined` as a harness, an already-settled job
	 * as still running, and a pane Herdr closed days ago as still open. A record
	 * this package cannot read is not a job it may judge.
	 */
	schemaVersion: number;
	id: string;
	/** The ticket id, as the tracker file names it: "03", "12". */
	ticket: string;
	/** The ticket's title at dispatch time; names the Herdr agent and the tab. */
	ticketTitle?: string;
	/** Absolute path of the ticket file this job was dispatched for. */
	ticketPath: string;
	role: FleetRole;
	executor: ExecutorKind;
	worktree: string;
	/** The fixed point a review diffs against. Absent for an implement job. */
	base?: string;
	fixRound: number;
	model?: string;
	runDir: string;
	briefPath: string;
	taskPath: string;
	schemaPath: string;
	resultPath: string;
	/** The job's own meta file, so a report can point at where the job lives. */
	metaPath: string;
	startedAt: number;
	pane?: PaneTargets;
	/** When FleetCleanup closed the ticket's tab; absent while it stays open. */
	paneClosedAt?: number;
	/** The last Herdr lifecycle state a harvest observed. Records waiting-for-a-human; never decides success. */
	agentStatus?: string;
	/** First time this job was seen idle with no contract; cleared when the agent works again. */
	idleSince?: number;
	contractOk?: boolean;
	contractError?: string;
	/** Set when a harvest first reported this job to the model. Later harvests reuse it. */
	harvestedAt?: number;
}

export interface FleetSettings {
	/** Absolute run-directory root, under pi's own project directory. */
	runsDir: string;
	/** Fix rounds past this cap are refused in code, never left to the model's discretion. */
	maxFixRound: number;
	/** How long an agent may sit idle with no contract before the job is reported as failed. */
	idleGraceMs: number;
	/** Block git stash, git commit --amend, and force push (PI_FLEET_GIT_GUARD=off disables). */
	gitGuard: boolean;
	/** Wake the session with a user message when a job settles (PI_FLEET_AUTO_CONTINUE=off disables). */
	autoContinue: boolean;
	/** Herdr's binary. The executor's own binary is not here: Herdr starts it from the agent's kind. */
	herdrBin: string;
}

function parsePositive(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Read settings once at load. `cwd` is a parameter rather than a hidden read so
 * tests can pin the resolution. The run root is absolute because the
 * orchestrator writes it and the executor reads paths out of the brief.
 */
export function readSettings(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): FleetSettings {
	return {
		// resolve() rather than string joining: the orchestrator's cwd and the
		// executor's worktree cwd are different roots, and a relative run dir lands
		// on no file when the two disagree.
		//
		// The default lives under `.pi/`, which is pi's own project directory, rather
		// than as a top-level `.fleet/` beside the source. What pi keeps for itself
		// belongs in pi's directory.
		runsDir: resolve(cwd, env.PI_FLEET_RUNS_DIR || ".pi/fleet/runs"),
		maxFixRound: parsePositive(env.PI_FLEET_MAX_FIX_ROUND, 2),
		idleGraceMs: parsePositive(env.PI_FLEET_IDLE_GRACE_MS, 120_000),
		gitGuard: (env.PI_FLEET_GIT_GUARD || "on").toLowerCase() !== "off",
		autoContinue: (env.PI_FLEET_AUTO_CONTINUE || "on").toLowerCase() !== "off",
		herdrBin: env.PI_FLEET_HERDR_BIN || "herdr",
	};
}

/** The record shape this release writes and reads. */
export const JOB_SCHEMA_VERSION = 1;

export const EXECUTOR_KINDS: readonly ExecutorKind[] = ["codex", "claude"];
export const FLEET_ROLES: readonly FleetRole[] = ["implement", "review"];

export function isExecutorKind(value: string): value is ExecutorKind {
	return (EXECUTOR_KINDS as readonly string[]).includes(value);
}

export function isFleetRole(value: string): value is FleetRole {
	return (FLEET_ROLES as readonly string[]).includes(value);
}
