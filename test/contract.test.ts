import assert from "node:assert/strict";
import test from "node:test";
import { claudeFailureNote, parseClaudeStdout, ticketsMatch, validateContract } from "../extensions/lib/contract.ts";

const implementContract = {
	ticket: "42",
	status: "implemented",
	branch: "fleet/42-login-form",
	tests: { command: "npm test", passed: 12, failed: 0 },
};

const reviewContract = {
	base: "main",
	standards: { worst_issue: "found reaching into internals", findings: [{ rule: "interface-is-the-test-surface", file: "src/auth.ts", line: 12, quote: "user.passwordHash" }] },
	spec: { spec_found: true, worst_issue: "missing rate limit", findings: [{ quote: "the form shall rate limit", file: "src/auth.ts", line: 30 }] },
};

test("implement contract: valid passes", () => {
	assert.deepEqual(validateContract("implement", implementContract), { ok: true });
});

test("implement contract: each required field reports itself", () => {
	assert.match(validateContract("implement", { ...implementContract, branch: "" }).error!, /branch/);
	assert.match(validateContract("implement", { ...implementContract, status: "done" }).error!, /status/);
	const missing = { ticket: "42", status: "implemented", branch: "b" };
	assert.match(validateContract("implement", missing).error!, /tests/);
});

test("implement contract: a commits field is refused, because an implement job does not commit", () => {
	const result = validateContract("implement", { ...implementContract, commits: [] });
	assert.match(result.error!, /does not commit/);
});

test("implement contract: blocked and failed are valid statuses too", () => {
	for (const status of ["blocked", "failed"]) {
		assert.deepEqual(validateContract("implement", { ...implementContract, status }), { ok: true });
	}
});

test("review contract: valid passes and the axes stay separate", () => {
	assert.deepEqual(validateContract("review", reviewContract), { ok: true });
});

test("review contract: a missing spec_found is an error, not an inference", () => {
	const broken = { base: "main", standards: reviewContract.standards, spec: { worst_issue: "x", findings: [] } };
	assert.match(validateContract("review", broken).error!, /spec_found/);
});

test("review contract: findings name their fields", () => {
	const broken = {
		...reviewContract,
		standards: { worst_issue: "x", findings: [{ rule: "r", file: "f", quote: "q" }] },
	};
	assert.match(validateContract("review", broken).error!, /line/);
});

test("non-object results fail with the field path", () => {
	assert.match(validateContract("implement", null).error!, /result/);
	assert.match(validateContract("review", "looks fine").error!, /result/);
});

test("claude stdout: structured_output comes out of the envelope", () => {
	const payload = { result: "...", structured_output: reviewContract, total_cost_usd: 0.1234 };
	const parsed = parseClaudeStdout(JSON.stringify(payload));
	assert.deepEqual(parsed.structured, reviewContract);
	// Executor spend is the executor's own business; the envelope's cost field
	// is not read, not judged, not propagated.
	assert.equal("spend" in parsed, false);
	assert.equal("costUsd" in parsed, false);
});

test("claude stdout: missing structured_output is an error naming the field", () => {
	const { error } = parseClaudeStdout(JSON.stringify({ result: "plain text" }));
	assert.match(error!, /structured_output/);
});

test("claude stdout: non-JSON is an error", () => {
	const { error } = parseClaudeStdout("assistant said a thing");
	assert.match(error!, /not JSON/);
});

const quotaEnvelope = JSON.stringify({
	type: "result",
	is_error: true,
	api_error_status: 403,
	terminal_reason: "api_error",
	result: "Failed to authenticate. API Error: 403 subscription quota insufficient",
});

test("claude failure note: the envelope's own reason, with the status", () => {
	assert.equal(claudeFailureNote(quotaEnvelope), "Failed to authenticate. API Error: 403 subscription quota insufficient (api_error_status=403)");
});

test("claude failure note: a healthy envelope yields nothing", () => {
	assert.equal(claudeFailureNote(JSON.stringify({ is_error: false, result: "done", structured_output: implementContract })), undefined);
	assert.equal(claudeFailureNote(""), undefined);
	assert.equal(claudeFailureNote("not json"), undefined);
});

test("claude stdout: a refused call reports the refusal, not the missing field", () => {
	const { error } = parseClaudeStdout(quotaEnvelope);
	assert.match(error!, /quota insufficient/);
	assert.doesNotMatch(error!, /structured_output/);
});

test("a contract that answers another ticket fails, and a slug or a # is the same ticket", () => {
	const good = { ticket: "23-gitignore", status: "implemented", branch: "fleet/23", tests: { command: "x", passed: 1, failed: 0 } };
	assert.equal(validateContract("implement", good, "23-gitignore").ok, true);
	assert.equal(validateContract("implement", { ...good, ticket: "#23" }, "23-gitignore").ok, true);
	assert.equal(validateContract("implement", { ...good, ticket: "23" }, "23").ok, true);
	assert.equal(validateContract("implement", { ...good, ticket: " 23-GitIgnore " }, "23-gitignore").ok, true);

	// A different number is a different ticket, however close the text looks.
	const wrong = validateContract("implement", { ...good, ticket: "#24" }, "23-gitignore");
	assert.equal(wrong.ok, false);
	assert.match(wrong.error ?? "", /is not the ticket this job was dispatched for/);
	assert.match(wrong.error ?? "", /"#24"/);
	assert.match(wrong.error ?? "", /"23-gitignore"/);
	// 23 vs 230 is not a match: the prefix rule only accepts a hyphen boundary.
	assert.equal(ticketsMatch("230", "23"), false);
	assert.equal(ticketsMatch("", "23"), false);
	assert.equal(validateContract("implement", good).ok, true, "expectedTicket stays optional");
});
