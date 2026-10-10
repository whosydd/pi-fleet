/**
 * Ledger entries: what a dispatch or a harvest records into the session for
 * cost accounting and later auditing. Pure formatting — index.ts calls
 * pi.appendEntry() with what these return.
 */

import type { HarvestOutcome } from "./supervise.ts";
import type { JobMeta } from "./types.ts";

export interface LedgerEntry {
	customType: "fleet-job";
	data: {
		event: "dispatched" | "harvested";
		jobId: string;
		ticket: string;
		executor: JobMeta["executor"];
		taskKind: JobMeta["taskKind"];
		worktree: string;
		fixRound: number;
		outcome?: HarvestOutcome["kind"];
		contractError?: string;
		costUsd?: number;
		inputTokens?: number;
		outputTokens?: number;
		runDir: string;
		at: number;
	};
}

export function dispatchedEntry(meta: JobMeta): LedgerEntry {
	return {
		customType: "fleet-job",
		data: {
			event: "dispatched",
			jobId: meta.id,
			ticket: meta.ticket,
			executor: meta.executor,
			taskKind: meta.taskKind,
			worktree: meta.worktree,
			fixRound: meta.fixRound,
			runDir: meta.paths.metaPath.replace(/\/meta\.json$/, ""),
			at: meta.startedAt,
		},
	};
}

export function harvestedEntry(meta: JobMeta, outcome: HarvestOutcome["kind"], contractError?: string): LedgerEntry {
	return {
		customType: "fleet-job",
		data: {
			event: "harvested",
			jobId: meta.id,
			ticket: meta.ticket,
			executor: meta.executor,
			taskKind: meta.taskKind,
			worktree: meta.worktree,
			fixRound: meta.fixRound,
			outcome,
			contractError,
			runDir: meta.paths.metaPath.replace(/\/meta\.json$/, ""),
			at: Date.now(),
		},
	};
}
