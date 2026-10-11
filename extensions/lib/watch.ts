/**
 * The settle watcher's vocabulary.
 *
 * A dispatch ends the orchestrator's turn, and the executor runs in a pane that
 * pi does not own. Without a watcher the loop only moves when a human says so:
 * harvest, review, and commit all wait for the next message. pi supplies the
 * missing hook — `sendUserMessage` always starts a turn — so the extension polls
 * the run directories and wakes the session the moment a job settles.
 *
 * Pure: the message is a string built from a job's own record, so the wording
 * tests without a session and without a Herdr call.
 */

import type { JobMeta } from "./types.ts";

/**
 * One `herdr agent wait` slice.
 *
 * Herdr returns the moment the agent changes lifecycle state, so a slice is a
 * ceiling rather than a polling period. It exists only so the watcher re-checks
 * the run directory at least this often when no state ever changes.
 */
export const WATCH_WAIT_SLICE_MS = 300_000;

/**
 * The floor between two harvest checks for one job.
 *
 * A `wait` returns immediately when the agent is already settled, and an agent
 * waiting at a prompt is settled without a contract. Without this floor the
 * loop would spin on that case.
 */
export const WATCH_THROTTLE_MS = 15_000;

/**
 * The user message that wakes the session.
 *
 * It names the job and the verdict, and stops there. The orchestrator reads the
 * contract through `FleetHarvest`, which returns the same verdict from disk, so
 * this message must not restate a contract it has not read.
 */
export function wakeMessage(meta: JobMeta, verdict: string): string {
	return `[pi-fleet] job ${meta.id} (ticket ${meta.ticket}, ${meta.role} on ${meta.executor}) settled: ${verdict}. Call FleetHarvest ${meta.id}.`;
}
