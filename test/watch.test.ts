import assert from "node:assert/strict";
import test from "node:test";
import type { JobMeta } from "../extensions/lib/types.ts";
import { wakeMessage } from "../extensions/lib/watch.ts";

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
