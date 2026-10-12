import assert from "node:assert/strict";
import test from "node:test";
import type { JobMeta } from "../extensions/lib/types.ts";
import { NUDGE_TEXT, nudgeStep, wakeMessage, WATCH_NUDGE_LIMIT } from "../extensions/lib/watch.ts";

test("the wake message names the job, the ticket, and the verdict, and points at FleetHarvest", () => {
	const meta = { id: "job_01_123_ab", ticket: "01", role: "implement", executor: "codex" } as JobMeta;
	assert.equal(
		wakeMessage(meta, "complete"),
		"[pi-fleet] job job_01_123_ab (ticket 01, implement on codex) settled: complete. Call FleetHarvest job_01_123_ab.",
	);
	// Every verdict travels the same way: the orchestrator learns the detail from
	// FleetHarvest, which reads the same record from disk.
	for (const verdict of ["contract_failed", "failed", "unknown"]) {
		assert.match(wakeMessage(meta, verdict), new RegExp(`settled: ${verdict}\\. Call FleetHarvest job_01_123_ab\\.$`));
	}
});

test("an idle executor without a contract is nudged, but only a few times", () => {
	const t0 = 1_000_000;
	// Idle starts the clock and nothing else.
	const first = nudgeStep(undefined, "idle", t0);
	assert.equal(first.nudge, false);
	// Still inside the delay.
	assert.equal(nudgeStep(first.state, "idle", t0 + 5_000).nudge, false);
	// Past the delay: one nudge, and the clock restarts.
	const second = nudgeStep(first.state, "idle", t0 + 20_000);
	assert.equal(second.nudge, true);
	assert.equal(second.state?.count, 1);
	// An executor that went back to work clears its record.
	assert.deepEqual(nudgeStep(second.state, "working", t0 + 25_000), { nudge: false, state: undefined });
	// The count stops before the nudges become a loop.
	let state = { since: t0, count: WATCH_NUDGE_LIMIT };
	assert.equal(nudgeStep(state, "idle", t0 + 60_000).nudge, false);
	assert.equal(NUDGE_TEXT, "continue");
});
