/**
 * Which harness runs which job.
 *
 * Pure: it reads a job list and returns a kind. No fs, no spawning, no pi
 * imports, so the rule is testable without a session.
 *
 * The rule is one line long and easy to get wrong: a review must run on the
 * harness that did not write the code. An agent reviewing its own work is biased
 * toward its own solution, which is exactly what `FleetDispatch` avoids by
 * choosing for the caller rather than asking the caller to remember.
 */

import type { ExecutorKind, FleetRole, JobMeta } from "./types.ts";

/**
 * The harness a job runs on when the caller did not name one.
 *
 * An implementation defaults to codex. A review defaults to whichever harness
 * did not write the code: the tool reads the ticket's latest implement job and
 * returns the other one. With no implement job on record there is nothing to
 * avoid, so a review defaults to claude.
 */
export function defaultExecutor(role: FleetRole, jobs: JobMeta[], ticket: string): ExecutorKind {
	if (role === "implement") return "codex";
	const writer = jobs.filter((job) => job.ticket === ticket && job.role === "implement").at(-1)?.executor;
	return writer === "claude" ? "codex" : "claude";
}
