import assert from "node:assert/strict";
import test from "node:test";
import { buildGateContext, buildTriageContext, classifyViaRegistry, interpretGate, interpretTriage, readJudgmentSettings, summarizeTriage, type ClassifierAnswer, type ClassifyRegistry, uncertainIndices } from "../extensions/lib/judgments.ts";

const bool = (probability: number): ClassifierAnswer => ({ type: "bool", probability });
const choice = (choice: string, confidence: number): ClassifierAnswer => ({ type: "choice", choice, probabilities: {}, confidence });

const FLOOR = 0.7;
const WARN = 0.85;

test("gate context: three atomic nouls over the brief state", () => {
	const context = buildGateContext("Build the login form.");
	assert.equal(context.state.brief, "Build the login form.");
	assert.deepEqual(Object.keys(context.questions).sort(), ["has_acceptance", "has_entry_points", "has_scope_boundary"]);
	for (const question of Object.values(context.questions)) {
		assert.equal(question.type, "bool");
	}
});

test("gate: pass when every dimension clears the warn line", () => {
	const verdict = interpretGate(
		{ has_entry_points: bool(0.97), has_acceptance: bool(0.95), has_scope_boundary: bool(0.99) },
		{ floor: FLOOR, warn: WARN },
	);
	assert.equal(verdict.outcome, "pass");
	assert.deepEqual(verdict.missing, []);
	assert.deepEqual(verdict.weak, []);
});

test("gate: warn between floor and warn, naming the weak dimensions", () => {
	const verdict = interpretGate(
		{ has_entry_points: bool(0.97), has_acceptance: bool(0.75), has_scope_boundary: bool(0.99) },
		{ floor: FLOOR, warn: WARN },
	);
	assert.equal(verdict.outcome, "warn");
	assert.deepEqual(verdict.weak, ["acceptance"]);
});

test("gate: refuse below the floor, naming the missing dimensions", () => {
	const verdict = interpretGate(
		{ has_entry_points: bool(0.97), has_acceptance: bool(0.09), has_scope_boundary: bool(0.05) },
		{ floor: FLOOR, warn: WARN },
	);
	assert.equal(verdict.outcome, "refuse");
	assert.deepEqual(verdict.missing, ["acceptance", "scope_boundary"]);
});

test("gate: a missing or malformed answer counts as absent, never as pass", () => {
	const missing = interpretGate({}, { floor: FLOOR, warn: WARN });
	assert.equal(missing.outcome, "refuse");
	assert.equal(missing.missing.length, 3);
	const malformed = interpretGate({ has_entry_points: choice("maybe", 0.9) }, { floor: FLOOR, warn: WARN });
	assert.equal(malformed.probabilities.entry_points, 0);
});

test("triage context: one choice question per finding, backticked state path", () => {
	const context = buildTriageContext([
		{ axis: "standards", label: "interface-is-the-test-surface", file: "src/auth.ts", line: 12, quote: "user.passwordHash" },
		{ axis: "spec", label: "missing rate limit", file: "src/auth.ts", line: 30 },
	]);
	assert.deepEqual(Object.keys(context.questions).sort(), ["f0", "f1"]);
	assert.equal(context.questions.f0.type, "choice");
	assert.match(context.questions.f0.instructions, /findings\[0\]/);
	assert.equal(JSON.stringify(context.state.findings).includes("interface-is-the-test-surface"), true);
});

test("triage: labels map through and blockers are identifiable", () => {
	const verdicts = interpretTriage({ f0: choice("blocker", 0.98), f1: choice("style", 0.99), f2: choice("ignore", 0.9) }, 3, 0.8);
	assert.deepEqual(verdicts.map((verdict) => verdict.choice), ["blocker", "style", "ignore"]);
	assert.equal(verdicts.every((verdict) => !verdict.uncertain), true);
});

test("triage: low confidence marks the finding uncertain for the model to read", () => {
	const verdicts = interpretTriage({ f0: choice("blocker", 0.55), f1: choice("ignore", 0.99) }, 2, 0.8);
	assert.equal(verdicts[0].uncertain, true);
	assert.equal(verdicts[1].uncertain, false);
});

test("triage: a missing answer degrades to an uncertain ignore, not a blocker", () => {
	const verdicts = interpretTriage({}, 1, 0.8);
	assert.equal(verdicts[0].choice, "ignore");
	assert.equal(verdicts[0].uncertain, true);
});

test("judgment settings: defaults, overrides, and the off switch", () => {
	const defaults = readJudgmentSettings({});
	assert.equal(defaults.enabled, true);
	assert.equal(defaults.modelProvider, "typesafe");
	assert.equal(defaults.modelId, "jev-latest");
	assert.equal(defaults.gateFloor, 0.7);
	assert.equal(defaults.triageConfidence, 0.8);
	const overridden = readJudgmentSettings({
		PI_FLEET_JUDGMENTS: "off",
		PI_FLEET_JUDGE_PROVIDER: "opencode",
		PI_FLEET_JUDGE_ID: "jev-1.13",
		PI_FLEET_GATE_FLOOR: "0.8",
		PI_FLEET_TRIAGE_CONFIDENCE: "not-a-number",
	});
	assert.equal(overridden.enabled, false);
	assert.equal(overridden.modelProvider, "opencode");
	assert.equal(overridden.modelId, "jev-1.13");
	assert.equal(overridden.gateFloor, 0.8);
	assert.equal(overridden.triageConfidence, 0.8);
});

test("triage counts partition the findings, and uncertain is a separate axis", () => {
	const records = [
		{ index: 0, axis: "standards" as const, label: "a", choice: "blocker", confidence: 0.9, uncertain: false },
		// A blocker the classifier was unsure about: it belongs to the blocker
		// count and to the uncertain count, never to a subtraction of the other.
		{ index: 1, axis: "spec" as const, label: "b", choice: "blocker", confidence: 0.4, uncertain: true },
		{ index: 2, axis: "standards" as const, label: "c", choice: "style", confidence: 0.85, uncertain: false },
		{ index: 3, axis: "spec" as const, label: "d", choice: "ignore", confidence: 0.9, uncertain: false },
	];
	const tally = summarizeTriage(records);
	assert.deepEqual(tally, { blockers: 2, style: 1, ignore: 1, uncertain: 1 });
	assert.equal(tally.blockers + tally.style + tally.ignore, records.length);
	assert.deepEqual(uncertainIndices(records), [1]);
	assert.deepEqual(summarizeTriage([]), { blockers: 0, style: 0, ignore: 0, uncertain: 0 });
});

/** A registry that answers every gate noul with 0.9 and reports a token usage. */
function standInRegistry(result: Record<string, unknown>): ClassifyRegistry {
	return {
		findOfType: () => ({}),
		classify: async () => result,
	} as unknown as ClassifyRegistry;
}

test("a classifier call carries its own spend to the caller", async () => {
	const registry = standInRegistry({
		stopReason: "stop",
		answers: { has_entry_points: bool(0.9), has_acceptance: bool(0.9), has_scope_boundary: bool(0.9) },
		usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
	});
	const attempt = await classifyViaRegistry(registry, readJudgmentSettings({}), buildGateContext("Entry points: x. Acceptance: y. Out of scope: z."));
	assert.equal(attempt.ok, true);
	assert.deepEqual((attempt as { usage?: { tokens: number; cost: number } }).usage, { tokens: 120, cost: 0.003 });

	// A provider that reports no counts yields no usage, rather than a zero report.
	const silent = standInRegistry({ stopReason: "stop", answers: {} });
	const second = await classifyViaRegistry(silent, readJudgmentSettings({}), buildGateContext("x"));
	assert.equal((second as { usage?: unknown }).usage, undefined);

	// A failed call reports a reason and never a usage.
	const failed = standInRegistry({ stopReason: "error", errorMessage: "403 quota insufficient" });
	const third = await classifyViaRegistry(failed, readJudgmentSettings({}), buildGateContext("x"));
	assert.deepEqual(third, { ok: false, reason: "403 quota insufficient" });
});
