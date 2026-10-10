import assert from "node:assert/strict";
import test from "node:test";
import { blockerFindings, fixBriefFor, nextStep, reviewBriefFor } from "../extensions/lib/loop.ts";
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

// The brief builders the loop writes for itself: they carry every fact the
// reviewer and the fixer get, so their wording is the contract's other half.
test("reviewBriefFor picks its fixed point as meta.base, contract.branch, then HEAD~1", () => {
	assert.match(reviewBriefFor(meta({ base: "origin/main" }), {}), /git diff origin\/main\.\.HEAD/);
	assert.match(reviewBriefFor(meta(), { branch: "fleet/42-work" }), /git diff fleet\/42-work\.\.HEAD/);
	assert.match(reviewBriefFor(meta(), {}), /git diff HEAD~1\.\.HEAD/);
	// Both present: the dispatch's own base wins over the one the contract reported,
	// which is the only case the three assertions above leave unpinned.
	assert.match(reviewBriefFor(meta({ base: "origin/main" }), { branch: "fleet/42-work" }), /git diff origin\/main\.\.HEAD/);
});

test("reviewBriefFor reports the commit count and names both review axes", () => {
	const brief = reviewBriefFor(meta(), { commits: [{ sha: "a" }, { sha: "b" }, { sha: "c" }] });
	assert.match(brief, /3 commit\(s\) reported by the implementation job/);
	assert.match(brief, /Axis 1 - standards/);
	assert.match(brief, /Axis 2 - spec/);
});

test("reviewBriefFor carries the implementer's summary, or says the claim is unstated", () => {
	assert.match(reviewBriefFor(meta(), { summary: "adds the loop tests" }), /What the implementer claims it does: adds the loop tests/);
	assert.match(reviewBriefFor(meta(), {}), /What the implementer claims is unstated/);
});

test("fixBriefFor names the next round and ticket, lists every finding, and bans history rewrites", () => {
	const brief = fixBriefFor(meta({ ticket: "42", fixRound: 1 }), [
		"#0 (standards): finding 0",
		"#1 (spec): finding 1",
	]);
	assert.match(brief, /Fix round 2 for ticket 42/);
	assert.match(brief, /- #0 \(standards\): finding 0/);
	assert.match(brief, /- #1 \(spec\): finding 1/);
	assert.match(brief, /git stash/);
	assert.match(brief, /--amend/);
	assert.match(brief, /force push/);
});
