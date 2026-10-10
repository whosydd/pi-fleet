import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planDispatch, type FleetSettings } from "../extensions/lib/plan.ts";
import { Supervisor } from "../extensions/lib/supervise.ts";

/** The stand-in executor: honours -o like the real codex exec does. */
const FAKE = new URL("./helpers/fake-codex.mjs", import.meta.url).pathname;
/** The stand-in for a claude run the provider refused: exit 1, cause on stdout. */
const FAKE_CLAUDE_REFUSED = new URL("./helpers/fake-claude-quota.mjs", import.meta.url).pathname;

function settingsFor(dir: string): FleetSettings {
	return {
		stateDir: join(dir, ".fleet"),
		maxConcurrent: 1,
		defaultTimeoutMs: 60_000,
		maxFixRound: 2,
		codexBin: "/bin/sh",
		claudeBin: "claude",
		gitGuard: true,
		paneMode: "off",
		herdrBin: "herdr",
	};
}

function planFor(dir: string, brief: string) {
	const result = planDispatch(
		{ ticket: "42", worktree: dir, executor: "codex", task_kind: "implement", brief },
		settingsFor(dir),
		{ runningCount: 0 },
	);
	if (!result.ok) throw new Error(result.message);
	// The plan's argv names the real codex binary; the network-free test
	// substitutes the stand-in executor it would otherwise spawn. The fake
	// receives the plan's own -o path, like the real CLI does.
	result.plan.command = ["node", FAKE, "-o", result.plan.paths.resultPath, "--output-schema", result.plan.paths.schemaPath];
	return result.plan;
}

async function settle(supervisor: Supervisor, id: string, deadlineMs = 15_000): Promise<string> {
	const started = Date.now();
	while (Date.now() - started < deadlineMs) {
		const outcome = supervisor.refresh(id).outcome;
		if (outcome.kind !== "running") return outcome.kind;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return "running";
}

test("a compliant executor harvests to contract_complete", { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-ok-"));
	try {
		const supervisor = new Supervisor(settingsFor(dir));
		const plan = planFor(dir, "Build the login form at the auth seam.");
		const meta = await supervisor.dispatch(plan, plan.prompt);

		assert.equal(await settle(supervisor, meta.id), "complete");
		const report = supervisor.refresh(meta.id);
		assert.equal(report.outcome.kind, "complete");
		if (report.outcome.kind === "complete") {
			assert.equal(report.outcome.meta.contractOk, true);
		}
		const schema = readFileSync(join(dir, ".fleet", "runs", meta.id, "schema.json"), "utf8");
		assert.ok(schema.includes("implemented"));
		const metaOnDisk = JSON.parse(readFileSync(join(dir, ".fleet", "runs", meta.id, "meta.json"), "utf8"));
		assert.equal(metaOnDisk.state, "complete");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a zero exit with a broken contract is contract_failed, never complete", { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-bad-"));
	try {
		const supervisor = new Supervisor(settingsFor(dir));
		const plan = planFor(dir, "Build the thing.");
		plan.command = ["node", FAKE, "--bad", "-o", plan.paths.resultPath];
		const meta = await supervisor.dispatch(plan, plan.prompt);

		assert.equal(await settle(supervisor, meta.id), "contract_failed");
		const report = supervisor.refresh(meta.id);
		if (report.outcome.kind === "contract_failed") {
			assert.match(report.outcome.error, /expected an object|result\.ticket/);
		} else {
			assert.fail(`expected contract_failed, got ${report.outcome.kind}`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a second session rehydrates the job from disk", { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-inherit-"));
	try {
		const first = new Supervisor(settingsFor(dir));
		const plan = planFor(dir, "Build the thing.");
		const meta = await first.dispatch(plan, plan.prompt);
		await settle(first, meta.id);

		const second = new Supervisor(settingsFor(dir));
		assert.equal(second.loadFromDisk(), 1);
		const report = second.refresh(meta.id);
		assert.equal(report.outcome.kind, "complete");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the concurrency cap rejects a dispatch past the limit", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-cap-"));
	try {
		const supervisor = new Supervisor(settingsFor(dir));
		const plan = planFor(dir, "Build the thing.");
		plan.command = ["/bin/sh", "-c", "true"];
		await supervisor.dispatch(plan, plan.prompt);
		const second = planDispatch(
			{ ticket: "43", worktree: dir, executor: "codex", task_kind: "implement", brief: "Another one" },
			settingsFor(dir),
			{ runningCount: supervisor.runningCount() },
		);
		assert.equal(second.ok, false);
		if (!second.ok) assert.match(second.message, /cap/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("persist survives a run dir removed while the job is still in flight", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-vanished-"));
	try {
		const supervisor = new Supervisor(settingsFor(dir));
		const plan = planFor(dir, "Build the thing.");
		plan.command = ["/bin/sh", "-c", "true"];
		const meta = await supervisor.dispatch(plan, plan.prompt);
		rmSync(dir, { recursive: true, force: true });
		// The exit handler runs this write after the dir is gone. Throwing there
		// would kill the session over state that is lost anyway.
		supervisor.persist(meta);
		assert.equal(supervisor.get(meta.id)?.state, "running");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an inherited running job past its wall-clock ceiling settles as timeout", { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-expired-"));
	try {
		const first = new Supervisor(settingsFor(dir));
		const plan = planFor(dir, "Build the thing.");
		plan.command = ["/bin/sh", "-c", "sleep 3600"]; // hung executor, never finishes
		const meta = await first.dispatch(plan, plan.prompt);

		// Simulate a later session looking at a job well past its ceiling:
		// rewind the start time on disk (the persisted meta is what a fresh
		// session rehydrates) and drop the in-memory child handle.
		meta.startedAt = Date.now() - meta.timeoutMs - 5_000;
		first.persist(meta);
		const second = new Supervisor(settingsFor(dir));
		second.loadFromDisk();
		const report = second.refresh(meta.id);
		assert.equal(report.outcome.kind, "failed");
		if (report.outcome.kind === "failed") {
			assert.equal(report.outcome.meta.state, "timeout");
			assert.match(report.outcome.error, /timed out after/);
			assert.match(report.outcome.error, /stop it by hand/);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a claude job the provider refused reports the refusal, not an empty stderr.log", { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-refused-"));
	try {
		const supervisor = new Supervisor(settingsFor(dir));
		const plan = planFor(dir, "Build the thing.");
		// The stand-in exits 1, writes nothing to stderr, and leaves the cause in
		// its stdout envelope, exactly as a quota rejection does.
		plan.executor = "claude";
		plan.command = ["node", FAKE_CLAUDE_REFUSED];
		const meta = await supervisor.dispatch(plan, plan.prompt);

		assert.equal(await settle(supervisor, meta.id), "failed");
		const report = supervisor.refresh(meta.id);
		assert.equal(report.outcome.kind, "failed");
		if (report.outcome.kind === "failed") {
			assert.match(report.outcome.error, /403/);
			assert.match(report.outcome.error, /quota insufficient/);
			assert.doesNotMatch(report.outcome.error, /see .*stderr\.log/);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
