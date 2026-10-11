import assert from "node:assert/strict";
import test from "node:test";
import { buildBrief, buildTask } from "../extensions/lib/brief.ts";
import { IMPLEMENT_SCHEMA } from "../extensions/lib/contract.ts";

const base = {
	ticket: "03",
	briefPath: "/runs/job_03/brief.md",
	resultPath: "/runs/job_03/result.json",
	fixRound: 0,
};

test("the task names the brief, the contract file, and the method", () => {
	const text = buildTask({ ...base, role: "implement" });
	assert.match(text, /Read the brief at: \/runs\/job_03\/brief\.md/);
	assert.match(text, /write the contract as ONE JSON object into the file named below/);
	assert.match(text, /\/runs\/job_03\/result\.json/);
	// The schema travels in the task, so the executor never has to guess the shape.
	assert.match(text, /"status"/);
	assert.match(text, /implemented/);
});

test("a role is told which upstream skill to use by name, never by path", () => {
	// Handing over a path made the executor load a copy its harness had not
	// indexed, while the same task also read like work for the copy it had.
	const implement = buildTask({ ...base, role: "implement" });
	assert.match(implement, /If your harness provides the `tdd` skill/);
	assert.equal(implement.includes("SKILL.md"), false, "no path is named");

	const review = buildTask({ ...base, role: "review" });
	assert.match(review, /`code-review` skill/);
	assert.equal(review.includes("SKILL.md"), false);
});

test("the review method travels with the task, so it does not depend on the executor's install", () => {
	const text = buildTask({ ...base, role: "review", base: "fleet/03" });
	// The two axes, and the rule that keeps them from being reranked into one.
	assert.match(text, /Standards: does the diff follow how this repository writes code/);
	assert.match(text, /Spec: does the diff do what the ticket asked/);
	assert.match(text, /Do not merge or rerank the axes/);
	assert.match(text, /A finding without a file and a line is not a finding/);
	// The anti-recursion guard upstream has not shipped. Both of its installs run
	// the axes in sub-agents, and neither forbids them from spawning more.
	assert.match(text, /Do not invoke your harness's review command or spawn additional agents/);
	assert.match(text, /Review committed work only/);
	assert.match(text, /git diff fleet\/03\.\.\.HEAD/);
	assert.match(text, /"spec_found"/);
	// The upstream implementation skill is not named: its closing step is to invoke
	// the upstream review inside the run that wrote the code.
	assert.equal(text.includes("`implement`"), false);
});

test("the task carries the rules whose breach costs a worktree, not just a retry", () => {
	const text = buildTask({ ...base, role: "implement" });
	assert.match(text, /Never run git stash, git commit --amend, or any force push/);
	assert.match(text, /Do not close, tick, or edit the tracker ticket/);
	assert.match(text, /Do not spawn subagents/);
});

test("an implement job is told not to review its own work, because another harness will", () => {
	const text = buildTask({ ...base, role: "implement" });
	assert.match(text, /Do not run a code review yourself/);
	// The contract makes the executor report numbers it measured, so an untested
	// build cannot pass as implemented with a zero pass count.
	assert.match(text, /report the numbers you actually observed/);
	assert.match(text, /Do not report implemented on untested work/);
});

test("a review job carries the anti-recursion guard upstream does not ship", () => {
	const text = buildTask({ ...base, role: "review", base: "fleet/03" });
	assert.match(text, /Do not invoke your harness's review command or spawn additional agents/);
	assert.match(text, /Review committed work only/);
	assert.match(text, /git diff fleet\/03\.\.\.HEAD/);
	assert.match(text, /"spec_found"/);
	assert.equal(buildTask({ ...base, role: "review" }).includes("Do not run a code review yourself"), false);
});

test("a fix round says so, and only a fix round does", () => {
	assert.equal(buildTask({ ...base, role: "implement" }).includes("fix round"), false);
	assert.match(buildTask({ ...base, role: "implement", fixRound: 2 }), /This is fix round 2: address only the findings named in the brief/);
});

test("the brief carries the ticket text, so the executor needs no tracker access", () => {
	const text = buildBrief({ ticket: "03", role: "implement", ticketText: "# 03: Token refresh\n\nBody line.\n", fixRound: 0 });
	assert.match(text, /# Ticket 03 — implement job/);
	assert.match(text, /# 03: Token refresh/);
	assert.match(text, /Body line\./);
});

test("a fix-round brief names the findings it must resolve", () => {
	const text = buildBrief({ ticket: "03", role: "implement", ticketText: "# 03: t\n", fixRound: 1, findings: ["#0 (standards): swallows an error", "#2 (spec): no rate limit"] });
	assert.match(text, /## Findings this round must resolve/);
	assert.match(text, /- #0 \(standards\): swallows an error/);
	assert.match(text, /- #2 \(spec\): no rate limit/);
	// A first dispatch names none: an empty list must not become an empty heading.
	assert.equal(buildBrief({ ticket: "03", role: "implement", ticketText: "x", fixRound: 0, findings: [] }).includes("Findings this round"), false);
});

test("the two roles get different schemas, and the implement schema has no format keyword", () => {
	const implement = buildTask({ ...base, role: "implement" });
	const review = buildTask({ ...base, role: "review" });
	assert.match(implement, /"commits"/);
	assert.equal(implement.includes("spec_found"), false);
	assert.match(review, /"worst_issue"/);
	// claude treats `format` as an annotation, so a schema carrying one would be
	// enforced by nothing.
	assert.equal(JSON.stringify(IMPLEMENT_SCHEMA).includes('"format"'), false);
});