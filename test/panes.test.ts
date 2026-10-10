import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planDispatch, type FleetSettings } from "../extensions/lib/plan.ts";
import {
	agentGetArgv,
	agentName,
	agentPromptArgv,
	agentStartArgv,
	agentWaitArgv,
	closableTabs,
	paneDirection,
	paneSplitArgv,
	parseAgentGet,
	parsePaneSplit,
	parseTabCreate,
	parseWorkspaceList,
	readExitCodeText,
	resolvePaneMode,
	workspaceForWorktree,
} from "../extensions/lib/panes.ts";
import { Supervisor } from "../extensions/lib/supervise.ts";

const FAKE_HERDR = new URL("./helpers/fake-herdr.mjs", import.meta.url).pathname;

function settingsFor(dir: string, overrides: Partial<FleetSettings> = {}): FleetSettings {
	return {
		stateDir: join(dir, ".fleet"),
		maxConcurrent: 4,
		defaultTimeoutMs: 60_000,
		maxFixRound: 2,
		codexBin: "codex",
		claudeBin: "claude",
		gitGuard: true,
		// Tests never touch the real Herdr session: the herdr binary defaults to the
		// stand-in, and interactive mode stays off unless a test asks for it by name.
		paneMode: "off",
		herdrBin: FAKE_HERDR,
		notify: true,
		...overrides,
	};
}

function planFor(dir: string, settings: FleetSettings, overrides: Partial<Parameters<typeof planDispatch>[0]> = {}) {
	const result = planDispatch(
		{ ticket: "42", worktree: dir, executor: "codex", task_kind: "implement", brief: "Build the thing.", ...overrides },
		settings,
		{ runningCount: 0, herdrEnv: process.env.HERDR_ENV },
	);
	if (!result.ok) throw new Error(result.message);
	return result.plan;
}

function herdrCalls(log: string): { args: string[]; task?: string; command?: string; workspace?: string; tabId?: string; title?: string; name?: string; kind?: string | null }[] {
	if (!existsSync(log)) return [];
	return readFileSync(log, "utf8")
		.trim()
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line));
}

/** Set environment variables for one test and restore them afterwards. */
function useEnv(values: Record<string, string | undefined>): () => void {
	const saved = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return () => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

async function settle(supervisor: Supervisor, id: string, deadlineMs = 15_000): Promise<string> {
	const started = Date.now();
	for (;;) {
		const outcome = (await supervisor.refresh(id)).outcome;
		if (outcome.kind !== "running") return outcome.kind;
		if (Date.now() - started > deadlineMs) return "running";
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

test("pane decision: the parameter wins, then the setting, then HERDR_ENV", () => {
	assert.equal(resolvePaneMode(true, "off", undefined), true);
	assert.equal(resolvePaneMode(false, "on", "1"), false);
	assert.equal(resolvePaneMode(undefined, "on", undefined), true);
	assert.equal(resolvePaneMode(undefined, "off", "1"), false);
	assert.equal(resolvePaneMode(undefined, "auto", "1"), true);
	assert.equal(resolvePaneMode(undefined, "auto", "0"), false);
	assert.equal(resolvePaneMode(undefined, "auto", undefined), false);
});

test("agent names stay inside herdr's rule and stay unique per dispatch", () => {
	const name = agentName("Auth/Refactor: part 2!", "ab12");
	assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
	assert.ok(name.startsWith("fleet-"));
	assert.ok(name.includes("auth-refactor-part-2"));
	assert.equal(agentName("42", "zz9"), "fleet-42-zz9");
	// A ticket of punctuation only still names a legal agent.
	assert.match(agentName("///", "x1"), /^[a-z]/);
	// Two dispatches of one ticket never collide on one name.
	assert.notEqual(agentName("42", "aa11"), agentName("42", "bb22"));
});

test("agent argv: the model override rides after --, the task is one argument", () => {
	assert.deepEqual(agentStartArgv("fleet-42-x1", "codex", "w1:p2"), ["agent", "start", "fleet-42-x1", "--kind", "codex", "--pane", "w1:p2"]);
	assert.deepEqual(agentStartArgv("fleet-42-x1", "codex", "w1:p2", "gpt-6"), ["agent", "start", "fleet-42-x1", "--kind", "codex", "--pane", "w1:p2", "--", "-m", "gpt-6"]);
	assert.deepEqual(agentStartArgv("n", "claude", "w1:p2", "sonnet"), ["agent", "start", "n", "--kind", "claude", "--pane", "w1:p2", "--", "--model", "sonnet"]);
	assert.deepEqual(agentPromptArgv("fleet-42-x1", "Build it."), ["agent", "prompt", "fleet-42-x1", "Build it."]);
	assert.deepEqual(agentGetArgv("fleet-42-x1"), ["agent", "get", "fleet-42-x1"]);
	assert.deepEqual(agentWaitArgv("fleet-42-x1", 5000), ["agent", "wait", "fleet-42-x1", "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", "5000"]);
	assert.deepEqual(paneSplitArgv("w1:p1", "down", "/wt"), ["pane", "split", "w1:p1", "--direction", "down", "--cwd", "/wt", "--no-focus"]);
	assert.equal(paneDirection(0), "right");
	assert.equal(paneDirection(1), "down");
});

test("herdr JSON parsers take the real shapes and fail closed on junk", () => {
	const agent = parseAgentGet(
		`{"result":{"agent":{"agent":"codex","agent_status":"idle","name":"codex23","interactive_ready":true,"pane_id":"w29:p3","tab_id":"w29:t1","workspace_id":"w29"}},"type":"agent_info"}`,
	);
	assert.deepEqual(agent, { status: "idle", name: "codex23", paneId: "w29:p3", tabId: "w29:t1", workspaceId: "w29" });
	assert.equal(parseAgentGet("fish: not json"), undefined);
	assert.equal(parseAgentGet(JSON.stringify({ result: {} })), undefined);
	assert.equal(parseAgentGet(JSON.stringify({ result: { agent: { agent_status: "garbage" } } })), undefined);
	const tab = parseTabCreate(`{"result":{"tab":{"tab_id":"w1K:t17"},"root_pane":{"pane_id":"w1K:p3K"}}}`);
	assert.deepEqual(tab, { tabId: "w1K:t17", paneId: "w1K:p3K" });
	assert.equal(parsePaneSplit(`{"result":{"pane":{"pane_id":"w30:p2"}}}`), "w30:p2");
	const list = parseWorkspaceList(`{"result":{"workspaces":[{"workspace_id":"w24","worktree":{"checkout_path":"/private/tmp/repo"}}]}}`);
	assert.ok(Array.isArray(list));
	// Herdr reports /private/tmp; the caller says /tmp. Either side matches.
	assert.equal(workspaceForWorktree(list!, "/tmp/repo"), "w24");
	assert.equal(workspaceForWorktree(list!, "/var/other"), undefined);
	assert.equal(parseWorkspaceList("nope"), undefined);
});

test("exit code text: signal and junk are not codes", () => {
	assert.equal(readExitCodeText("0\n"), 0);
	assert.equal(readExitCodeText("3"), 3);
	assert.equal(readExitCodeText("signal\n"), undefined);
	assert.equal(readExitCodeText(""), undefined);
});

test("closableTabs: a tab closes only when every job on it settled", () => {
	const pane = { workspaceId: "w", tabId: "w:t1", paneId: "w:p1", label: "fleet: 42" };
	const { tabs, blocked } = closableTabs([
		{ state: "complete", pane },
		{ state: "contract_failed", pane },
		{ state: "running", pane: { ...pane, tabId: "w:t2" } },
		{ state: "running", pane: undefined },
	]);
	assert.deepEqual(tabs, ["w:t1"]);
	assert.deepEqual(blocked, ["w:t2"]);
});

test("interactive dispatch end-to-end: tab, agent start, prompt, then the contract file settles it", { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-agent-"));
	const log = join(dir, "herdr.log");
	const restore = useEnv({ FAKE_HERDR_LOG: log, FAKE_HERDR_WORKSPACE: "wF", FAKE_HERDR_CWD: dir, FAKE_HERDR_AGENT_STATE: "working" });
	try {
		const supervisor = new Supervisor(settingsFor(dir, { paneMode: "on" }));
		const plan = planFor(dir, settingsFor(dir, { paneMode: "on" }));
		const meta = await supervisor.dispatch(plan, plan.prompt);

		assert.equal(meta.runner, "agent");
		assert.ok(meta.agentName?.startsWith("fleet-42-"));
		assert.equal(meta.pane?.workspaceId, "wF");
		assert.equal(meta.pane?.label, "fleet: 42");

		// The dispatch made four herdr calls, in order: find the workspace, open the
		// tab, start the agent, deliver the task.
		const calls = herdrCalls(log);
		assert.deepEqual(calls.map((call) => `${call.args[0]} ${call.args[1]}`), ["workspace list", "tab create", "agent start", "agent prompt"]);
		assert.match(String(calls[2]!.kind), /codex/);
		// The task text carries the contract file rule and the schema.
		const task = calls[3]!.task;
		assert.match(task ?? "", /result\.json/);
		assert.match(task ?? "", /Result contract/);

		// While the fake agent reports working, the job stays running.
		assert.equal((await supervisor.refresh(meta.id)).outcome.kind, "running");

		// The executor wrote the contract: that, not the agent state, settles it.
		writeFileSync(plan.paths.resultPath, JSON.stringify({ ticket: "42", status: "implemented", branch: "b", commits: [{ sha: "a", subject: "s" }], tests: { command: "x", passed: 1, failed: 0 } }));
		const report = await supervisor.refresh(meta.id);
		assert.equal(report.outcome.kind, "complete");

		// Cleanup: a settled job's tab closes once and reports already closed twice.
		assert.equal((await supervisor.closeTab(meta.id)).ok, true);
		assert.equal((await supervisor.closeTab(meta.id)).alreadyClosed, true);
		assert.equal(supervisor.listOpenTabs().length, 0);
		assert.deepEqual(herdrCalls(log).at(-1)!.args, ["tab", "close", meta.pane!.tabId]);
	} finally {
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a second job of one ticket splits the ticket tab instead of opening another", { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-split-"));
	const log = join(dir, "herdr.log");
	const restore = useEnv({ FAKE_HERDR_LOG: log, FAKE_HERDR_WORKSPACE: "wF", FAKE_HERDR_CWD: dir });
	try {
		const supervisor = new Supervisor(settingsFor(dir, { paneMode: "on" }));
		const first = await supervisor.dispatch(planFor(dir, settingsFor(dir, { paneMode: "on" }), { ticket: "42" }), "brief");
		const second = await supervisor.dispatch(planFor(dir, settingsFor(dir, { paneMode: "on" }), { ticket: "42" }), "brief");

		assert.equal(first.runner, "agent");
		assert.equal(second.runner, "agent");
		// The first job took a fresh tab; the second split it.
		// Each job looks up the workspace, then takes a pane: the first created the
		// ticket tab, the second split it.
		assert.deepEqual(herdrCalls(log).map((call) => `${call.args[0]} ${call.args[1]}`), [
			"workspace list",
			"tab create",
			"agent start",
			"agent prompt",
			"workspace list",
			"pane split",
			"agent start",
			"agent prompt",
		]);
		assert.equal(second.pane?.tabId, first.pane?.tabId);
		assert.notEqual(second.pane?.paneId, first.pane?.paneId);
		assert.notEqual(second.agentName, first.agentName);
	} finally {
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an agent that settled without writing the contract is contract_failed, never complete", { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-idle-"));
	const restore = useEnv({ FAKE_HERDR_LOG: join(dir, "herdr.log"), FAKE_HERDR_WORKSPACE: "wF", FAKE_HERDR_CWD: dir, FAKE_HERDR_AGENT_STATE: "idle" });
	try {
		const supervisor = new Supervisor(settingsFor(dir, { paneMode: "on" }));
		const meta = await supervisor.dispatch(planFor(dir, settingsFor(dir, { paneMode: "on" })), "brief");
		assert.equal(await settle(supervisor, meta.id), "contract_failed");
		const report = await supervisor.refresh(meta.id);
		assert.equal(report.outcome.kind, "contract_failed");
		if (report.outcome.kind === "contract_failed") {
			assert.match(report.outcome.error, /without writing the contract/);
		}
		assert.equal(supervisor.get(meta.id)?.agentStatus, "idle");
	} finally {
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a blocked agent stays running and records that it waits on a human", { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-blocked-"));
	const restore = useEnv({ FAKE_HERDR_LOG: join(dir, "herdr.log"), FAKE_HERDR_WORKSPACE: "wF", FAKE_HERDR_CWD: dir, FAKE_HERDR_AGENT_STATE: "blocked" });
	try {
		const supervisor = new Supervisor(settingsFor(dir, { paneMode: "on" }));
		const plan = planFor(dir, settingsFor(dir, { paneMode: "on" }));
		const meta = await supervisor.dispatch(plan, "brief");
		const report = await supervisor.refresh(meta.id);
		assert.equal(report.outcome.kind, "running");
		assert.equal(supervisor.get(meta.id)?.agentStatus, "blocked");
		assert.equal(existsSync(plan.paths.resultPath), false);
	} finally {
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an agent herdr no longer knows is failed, not running forever", { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-gone-"));
	const restore = useEnv({ FAKE_HERDR_LOG: join(dir, "herdr.log"), FAKE_HERDR_WORKSPACE: "wF", FAKE_HERDR_CWD: dir, FAKE_HERDR_AGENT_GONE: "1" });
	try {
		const supervisor = new Supervisor(settingsFor(dir, { paneMode: "on" }));
		const meta = await supervisor.dispatch(planFor(dir, settingsFor(dir, { paneMode: "on" })), "brief");
		assert.equal(await settle(supervisor, meta.id), "failed");
		const report = await supervisor.refresh(meta.id);
		if (report.outcome.kind === "failed") {
			assert.match(report.outcome.error, /gone and wrote no contract/);
		}
	} finally {
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("interactive failure degrades to a detached spawn with a note, never a refusal", { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-pf-"));
	const restore = useEnv({ FAKE_HERDR_FAIL: "1", FAKE_HERDR_LOG: undefined });
	try {
		const supervisor = new Supervisor(settingsFor(dir, { paneMode: "on" }));
		const meta = await supervisor.dispatch(planFor(dir, settingsFor(dir, { paneMode: "on" })), "brief");
		assert.equal(meta.runner, "spawn");
		assert.match(meta.paneFallback!, /failed/);
	} finally {
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a contract file with prose around the JSON still fails the contract", { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-prose-"));
	const restore = useEnv({ FAKE_HERDR_LOG: join(dir, "herdr.log"), FAKE_HERDR_WORKSPACE: "wF", FAKE_HERDR_CWD: dir });
	try {
		const supervisor = new Supervisor(settingsFor(dir, { paneMode: "on" }));
		const plan = planFor(dir, settingsFor(dir, { paneMode: "on" }));
		const meta = await supervisor.dispatch(plan, plan.prompt);
		// The executor wrote prose and the JSON: the contract must not pass.
		writeFileSync(plan.paths.resultPath, "Here is the result:\n{\"ticket\":\"42\"}");
		const report = await supervisor.refresh(meta.id);
		assert.equal(report.outcome.kind, "contract_failed");
	} finally {
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});
