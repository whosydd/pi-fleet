import assert from "node:assert/strict";
import test from "node:test";
import { planDispatch, readSettings, type FleetSettings } from "../extensions/lib/plan.ts";

const base = {
	ticket: "42",
	worktree: "/tmp/fleet-wt",
	executor: "codex",
	task_kind: "implement",
	brief: "Build the login form at the auth seam.",
};

const settings: FleetSettings = {
	stateDir: ".fleet",
	maxConcurrent: 2,
	defaultTimeoutMs: 60_000,
	maxFixRound: 2,
	codexBin: "codex",
	claudeBin: "claude",
	gitGuard: true,
	paneMode: "auto",
	herdrBin: "herdr",
	agentStartMs: 90_000,
	notify: true,
};

test("rejects dispatches missing each required field, with a field-naming message", () => {
	for (const [key, value] of [
		["ticket", ""],
		["worktree", ""],
		["executor", ""],
		["brief", ""],
	] as const) {
		const params = { ...base, [key]: value };
		const result = planDispatch(params as never, settings, { runningCount: 0 });
		assert.equal(result.ok, false, `${key} should be required`);
		if (!result.ok) assert.match(result.message, new RegExp(key));
	}
});

test("rejects a relative worktree", () => {
	const result = planDispatch({ ...base, worktree: "../wt" }, settings, { runningCount: 0 });
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.message, /absolute/);
});

test("rejects unknown executor and task kinds", () => {
	const executor = planDispatch({ ...base, executor: "gemini" }, settings, { runningCount: 0 });
	assert.equal(executor.ok, false);
	const kind = planDispatch({ ...base, task_kind: "vibe" }, settings, { runningCount: 0 });
	assert.equal(kind.ok, false);
});

test("review requires a base fixed point", () => {
	const result = planDispatch({ ...base, task_kind: "review" }, settings, { runningCount: 0 });
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.message, /base/);
	const withBase = planDispatch({ ...base, task_kind: "review", base: "main" }, settings, { runningCount: 0 });
	assert.equal(withBase.ok, true);
});

test("enforces the concurrency cap without starting anything", () => {
	const result = planDispatch(base, settings, { runningCount: 2 });
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.message, /cap/);
});

test("caps fix rounds and points at escalation", () => {
	const result = planDispatch({ ...base, fix_round: 3 }, settings, { runningCount: 0 });
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.message, /Escalate|cap/);
});

test("a plan carries argv for the right executor and a prompt with the anti-recursion line for reviews", () => {
	const codex = planDispatch(base, settings, { runningCount: 0 });
	assert.equal(codex.ok, true);
	if (codex.ok) {
		assert.equal(codex.plan.command[1], "exec");
		assert.equal(codex.plan.command[2], "-C");
		assert.ok(codex.plan.prompt.includes("Do not close or edit the tracker ticket"));
	}

	const implement = planDispatch({ ...base, executor: "claude" }, settings, { runningCount: 0 });
	assert.equal(implement.ok, true);
	if (implement.ok) {
		const argv = implement.plan.command;
		// claude -p takes the prompt as a positional argument and shapes only the
		// output: the supervisor reads structured_output back out of stdout.
		assert.equal(argv[0], "claude");
		assert.equal(argv[1], "-p");
		assert.match(argv[2]!, /You are a fleet executor/);
		assert.equal(argv[argv.indexOf("--output-format") + 1], "json");
		const schema = JSON.parse(argv[argv.indexOf("--json-schema") + 1]!);
		assert.deepEqual(schema.required, ["ticket", "status", "branch", "commits", "tests"]);
		// The schema carries no `format` keyword: claude treats it as an annotation.
		assert.equal(JSON.stringify(schema).includes("\"format\""), false);
	}

	const review = planDispatch({ ...base, executor: "claude", task_kind: "review", base: "main" }, settings, { runningCount: 0 });
	assert.equal(review.ok, true);
	if (review.ok) {
		assert.ok(review.plan.prompt.includes("Do not invoke /code-review or spawn additional agents"));
		// Tool and permission policy is the executor's own business: the argv
		// carries output shaping only, no permission or tool-selection flags.
		assert.equal(review.plan.command.includes("--disallowedTools"), false);
		assert.equal(review.plan.command.includes("--permission-mode"), false);
	}
});

test("fix-round briefs tell the executor to touch only the findings", () => {
	const result = planDispatch({ ...base, fix_round: 1 }, settings, { runningCount: 0 });
	assert.ok(result.ok);
	if (result.ok) assert.match(result.plan.prompt, /fix round 1/);
});

test("ids are filesystem-safe", () => {
	const result = planDispatch({ ...base, ticket: "Auth/Refactor: part 2!" }, { ...settings, stateDir: ".fleet" }, { runningCount: 0 });
	assert.ok(result.ok);
	if (result.ok) assert.match(result.plan.id, /^job_auth-refactor-part-2_\d+_[a-z0-9]{4}$/);
});

test("readSettings falls back to defaults and honours overrides", () => {
	const defaults = readSettings({}, "/proj");
	assert.equal(defaults.maxConcurrent, 4);
	assert.equal(defaults.stateDir, "/proj/.fleet");
	const overridden = readSettings({ PI_FLEET_MAX_CONCURRENCY: "9", PI_FLEET_STATE_DIR: "/tmp/fleet-state" }, "/proj");
	assert.equal(overridden.maxConcurrent, 9);
	assert.equal(overridden.stateDir, "/tmp/fleet-state");
	assert.equal(readSettings({}, "/proj").gitGuard, true);
	assert.equal(readSettings({ PI_FLEET_GIT_GUARD: "off" }, "/proj").gitGuard, false);
	const relative = readSettings({ PI_FLEET_STATE_DIR: "../state" }, "/proj/.worktrees/wt");
	assert.equal(relative.stateDir, "/proj/.worktrees/state");
	assert.equal(readSettings({}, "/proj").notify, true);
	assert.equal(readSettings({ PI_FLEET_NOTIFY: "off" }, "/proj").notify, false);
	assert.equal(readSettings({ PI_FLEET_PANES: "on" }, "/proj").paneMode, "on");
	assert.equal(readSettings({ PI_FLEET_PANES: "garbage" }, "/proj").paneMode, "auto");
	assert.equal(readSettings({ PI_FLEET_HERDR_BIN: "/opt/herdr" }, "/proj").herdrBin, "/opt/herdr");
});
