import assert from "node:assert/strict";
import test from "node:test";
import { blockerFindings, nextStep } from "../extensions/lib/loop.ts";
import type { JobMeta } from "../extensions/lib/types.ts";

function meta(overrides: Partial<JobMeta> = {}): JobMeta {
	return {
		id: "job_42_1",
		ticket: "42",
		worktree: "/tmp/wt",
		executor: "codex",
		taskKind: "implement",
		fixRound: 0,
		command: [],
		startedAt: 0,
		timeoutMs: 60_000,
		state: "complete",
		contractOk: true,
		paths: {
			metaPath: "/tmp/run/meta.json",
			promptPath: "/tmp/run/prompt.md",
			resultPath: "/tmp/run/result.json",
			schemaPath: "/tmp/run/schema.json",
			stdoutPath: "/tmp/run/stdout.log",
			stderrPath: "/tmp/run/stderr.log",
			exitCodePath: "/tmp/run/exit_code",
		},
		...overrides,
	};
}

function triage(...choices: ("blocker" | "style" | "ignore")[]): JobMeta["triage"] {
	return choices.map((choice, index) => ({ index, axis: index % 2 === 0 ? "standards" : "spec", label: `finding ${index}`, choice, confidence: 0.9, uncertain: false }));
}

test("a passed implementation contract earns a review", () => {
	assert.deepEqual(nextStep(meta(), { status: "implemented" }, 2, true), { kind: "review" });
	assert.deepEqual(nextStep(meta({ fixRound: 1 }), { status: "implemented" }, 2, true), { kind: "review" });
});

test("a review with blockers earns one fix round carrying those findings", () => {
	const step = nextStep(meta({ taskKind: "review", triage: triage("style", "blocker") }), undefined, 2, true);
	assert.equal(step.kind, "fix");
	assert.deepEqual((step as { findings: string[] }).findings, ["#1 (spec): finding 1"]);
});

test("a review without blockers closes the loop, and only blockers spend a round", () => {
	assert.deepEqual(nextStep(meta({ taskKind: "review", triage: triage("style", "ignore") }), undefined, 2, true), { kind: "done" });
	assert.deepEqual(nextStep(meta({ taskKind: "review", triage: [] }), undefined, 2, true), { kind: "done" });
});

test("the cap stops the loop instead of retrying forever", () => {
	const step = nextStep(meta({ taskKind: "review", fixRound: 2, triage: triage("blocker") }), undefined, 2, true);
	assert.equal(step.kind, "halt");
	assert.match((step as { reason: string }).reason, /capped at 2 with 1 blocker/);
});

test("a settled job without a passing contract halts with the contract's own reason", () => {
	const step = nextStep(meta({ state: "contract_failed", contractOk: false, contractError: "result.standards.findings is not an array" }), undefined, 2, true);
	assert.deepEqual(step, { kind: "halt", reason: "result.standards.findings is not an array" });
	const missing = nextStep(meta({ state: "failed", contractOk: false }), undefined, 2, true);
	assert.equal(missing.kind, "halt");
});

test("an unavailable triage channel degrades to a halt note, never a invented round", () => {
	const step = nextStep(meta({ taskKind: "review", triage: undefined }), undefined, 2, false);
	assert.equal(step.kind, "halt");
	assert.match((step as { reason: string }).reason, /triage unavailable/);
});

test("blockerFindings reads only blockers and keeps the axis for the fix brief", () => {
	assert.deepEqual(blockerFindings(triage("blocker", "style", "blocker") ?? []), ["#0 (standards): finding 0", "#2 (standards): finding 2"]);
	assert.deepEqual(blockerFindings([]), []);
});

test("a blocked implementation is not reviewed: nothing landed, so there is nothing to read", () => {
	const blocked = nextStep(meta(), { status: "blocked" }, 2, true);
	assert.equal(blocked.kind, "halt");
	assert.match((blocked as { reason: string }).reason, /reported "blocked".*nothing landed/);

	// A missing contract is a halt too, not a review of nothing.
	assert.equal(nextStep(meta(), undefined, 2, true).kind, "halt");
	// And a landed one still earns its review.
	assert.deepEqual(nextStep(meta(), { status: "implemented", commits: [{ sha: "a" }] }, 2, true), { kind: "review" });
});
