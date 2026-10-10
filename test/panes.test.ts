import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planDispatch, type FleetSettings } from "../extensions/lib/plan.ts";
import {
	closableTabs,
	parseTabCreate,
	parseWorkspaceList,
	paneRunCommand,
	readExitCodeText,
	readPidFromText,
	resolvePaneMode,
	runScript,
	shellQuote,
	workspaceForWorktree,
} from "../extensions/lib/panes.ts";
import { Supervisor } from "../extensions/lib/supervise.ts";

const FAKE_HERDR = new URL("./helpers/fake-herdr.mjs", import.meta.url).pathname;
const FAKE = new URL("./helpers/fake-codex.mjs", import.meta.url).pathname;

function settingsFor(dir: string, overrides: Partial<FleetSettings> = {}): FleetSettings {
	return {
		stateDir: join(dir, ".fleet"),
		maxConcurrent: 1,
		defaultTimeoutMs: 60_000,
		maxFixRound: 2,
		codexBin: "/bin/sh",
		claudeBin: "claude",
		gitGuard: true,
		// Tests never touch the real Herdr session: the herdr binary defaults to the
		// stand-in, and pane mode stays off unless a test asks for it by name.
		paneMode: "off",
		herdrBin: FAKE_HERDR,
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
	// Stand in for the real executor, honouring the same -o argument.
	result.plan.command = ["node", FAKE, "-o", result.plan.paths.resultPath];
	return result.plan;
}

function herdrCalls(log: string): { args: string[]; command?: string; workspace?: string; tabId?: string }[] {
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
		const outcome = supervisor.refresh(id).outcome;
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

test("paneRunCommand is one short shell-neutral call", () => {
	assert.equal(paneRunCommand("/state/runs/x/run.sh"), "bash '/state/runs/x/run.sh'");
	assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test("run.sh: bash shebang, quoted argv, split tees, exit_code written last", () => {
	const script = runScript({ worktree: "/wt/a", command: ["codex", "exec", "--msg", "say 'hi'"], runDir: "/state/runs/x" });
	assert.ok(script.startsWith("#!/usr/bin/env bash"));
	assert.ok(script.includes(`cd '/wt/a'`));
	assert.ok(script.includes(`echo $$ > '/state/runs/x/pid'`));
	// The whole argv is single-quoted, so an embedded quote survives.
	assert.ok(script.includes(shellQuote("say 'hi'")));
	// stdout and stderr tee separately: claude's stdout.log must stay pure JSON.
	assert.ok(script.includes("> >(tee '/state/runs/x/stdout.log')"));
	assert.ok(script.includes("2> >(tee '/state/runs/x/stderr.log' >&2)"));
	// stdin closed: a pane TTY must never look like executor input.
	assert.ok(script.includes("</dev/null"));
	const lines = script.trimEnd().split("\n");
	assert.equal(lines[lines.length - 1]!.startsWith(`echo "$ec" > '/state/runs/x/exit_code'`), true);
});

test("run.sh executes for real: split logs, pid, and exit code land on disk", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-runsh-"));
	try {
		const runDir = join(dir, "state", "runs", "j1");
		mkdirSync(runDir, { recursive: true });
		const scriptPath = join(runDir, "run.sh");
		writeFileSync(scriptPath, runScript({ worktree: dir, command: ["/bin/sh", "-c", "echo out-line; echo err-line >&2; exit 3"], runDir }));
		chmodSync(scriptPath, 0o755);
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		await promisify(execFile)("bash", [scriptPath]);
		assert.equal(readFileSync(join(runDir, "stdout.log"), "utf8").trim(), "out-line");
		assert.equal(readFileSync(join(runDir, "stderr.log"), "utf8").trim(), "err-line");
		assert.equal(readExitCodeText(readFileSync(join(runDir, "exit_code"), "utf8")), 3);
		assert.equal(typeof readPidFromText(readFileSync(join(runDir, "pid"), "utf8")), "number");
		// A killed run leaves `signal`, which is not a code: undefined, so the
		// harvest reports "ended without an exit code" instead of a false zero.
		assert.equal(readExitCodeText("signal\n"), undefined);
		assert.equal(readExitCodeText(""), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pane dispatch end-to-end: herdr tab created, script ran, harvest read exit_code", { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-pane-"));
	const log = join(dir, "herdr.log");
	const restore = useEnv({ FAKE_HERDR_LOG: log, FAKE_HERDR_WORKSPACE: "wF", FAKE_HERDR_CWD: dir });
	try {
		const settings = settingsFor(dir, { herdrBin: FAKE_HERDR, paneMode: "on" });
		const supervisor = new Supervisor(settings);
		const plan = planFor(dir, settings);
		const meta = await supervisor.dispatch(plan, plan.prompt);

		// The dispatch recorded the pane targets it created.
		assert.equal(meta.runner, "pane");
		assert.equal(meta.pane?.workspaceId, "wF");
		assert.equal(meta.pane?.label, "fleet: 42");
		assert.ok(meta.pane?.tabId.startsWith("wF:"));
		assert.equal(meta.paneFallback, undefined);

		// Herdr saw exactly the three calls, in order, with the pane handed one
		// short bash command.
		const calls = herdrCalls(log);
		assert.deepEqual(calls.map((call) => `${call.args[0]} ${call.args[1]}`), ["workspace list", "tab create", "pane run"]);
		assert.match(calls[2]!.command!, /^bash '.*run\.sh'$/);

		// The fake pane really started bash: settle on its own evidence.
		const deadline = Date.now() + 15_000;
		while (!existsSync(plan.paths.exitCodePath) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const report = supervisor.refresh(meta.id);
		assert.equal(report.outcome.kind, "complete");
		if (report.outcome.kind === "complete") {
			assert.equal(report.outcome.meta.exitCode, 0);
			assert.equal(report.outcome.meta.contractOk, true);
		}

		// Cleanup: a settled job's tab closes once and reports already closed twice.
		const closed = await supervisor.closeTab(meta.id);
		assert.equal(closed.ok, true);
		assert.equal((await supervisor.closeTab(meta.id)).alreadyClosed, true);
		assert.equal(supervisor.listOpenTabs().length, 0);
		assert.deepEqual(herdrCalls(log).at(-1)!.args, ["tab", "close", meta.pane!.tabId]);
	} finally {
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pane channel failure degrades to a detached spawn with a note, never a refusal", { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-pf-"));
	const restore = useEnv({ FAKE_HERDR_FAIL: "1", FAKE_HERDR_LOG: undefined });
	try {
		const settings = settingsFor(dir, { herdrBin: FAKE_HERDR, paneMode: "on" });
		const supervisor = new Supervisor(settings);
		const plan = planFor(dir, settings);
		const meta = await supervisor.dispatch(plan, plan.prompt);
		assert.equal(meta.runner, "spawn");
		assert.match(meta.paneFallback!, /failed/);
		assert.equal(await settle(supervisor, meta.id), "complete");
	} finally {
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no herdr workspace owns the worktree: pane path declines, job still lands as spawn", { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-nows-"));
	const log = join(dir, "herdr.log");
	const restore = useEnv({ FAKE_HERDR_LOG: log, FAKE_HERDR_WORKSPACE: "w9", FAKE_HERDR_CWD: "/somewhere/else", HERDR_WORKSPACE_ID: undefined });
	try {
		const settings = settingsFor(dir, { herdrBin: FAKE_HERDR, paneMode: "on" });
		const supervisor = new Supervisor(settings);
		const plan = planFor(dir, settings);
		const meta = await supervisor.dispatch(plan, plan.prompt);
		assert.equal(meta.runner, "spawn");
		assert.match(meta.paneFallback!, /no Herdr workspace owns/);
		// Declining means never creating a tab.
		assert.equal(herdrCalls(log).some((call) => call.args[0] === "tab" && call.args[1] === "create"), false);
		assert.equal(await settle(supervisor, meta.id), "complete");
	} finally {
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("closeTab declines a job that did not run in a pane", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-refuse-"));
	try {
		const supervisor = new Supervisor(settingsFor(dir));
		const plan = planFor(dir, settingsFor(dir));
		const meta = await supervisor.dispatch(plan, plan.prompt);
		const refused = await supervisor.closeTab(meta.id);
		assert.equal(refused.ok, false);
		assert.match(refused.error!, /did not run in a Herdr pane/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("closeTab declines a running pane job", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-running-"));
	try {
		const supervisor = new Supervisor(settingsFor(dir));
		const plan = planFor(dir, settingsFor(dir));
		const meta = await supervisor.dispatch(plan, plan.prompt);
		// Mark it as a live pane job by hand: dispatch would need a real pane.
		meta.runner = "pane";
		meta.pane = { workspaceId: "w", tabId: "w:t9", paneId: "w:p9", label: "fleet: 42" };
		meta.state = "running";
		const refused = await supervisor.closeTab(meta.id);
		assert.equal(refused.ok, false);
		assert.match(refused.error!, /still running/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("closableTabs: a tab closes only when every job on it settled", () => {
	const pane = { workspaceId: "w", tabId: "w:t1", paneId: "w:p1", label: "fleet: 42" };
	const { tabs, blocked } = closableTabs([
		{ state: "complete", pane },
		{ state: "failed", pane },
		{ state: "running", pane: { ...pane, tabId: "w:t2" } },
		{ state: "running", pane: undefined },
	]);
	assert.deepEqual(tabs, ["w:t1"]);
	assert.deepEqual(blocked, ["w:t2"]);
});

test("herdr JSON parsers take the real shapes and fail closed on junk", () => {
	const tab = parseTabCreate(`{"result":{"tab":{"tab_id":"w1K:t17"},"root_pane":{"pane_id":"w1K:p3K"}}}`);
	assert.deepEqual(tab, { tabId: "w1K:t17", paneId: "w1K:p3K" });
	assert.equal(parseTabCreate("fish: not json"), undefined);
	assert.equal(parseTabCreate(JSON.stringify({ result: {} })), undefined);
	const list = parseWorkspaceList(`{"result":{"workspaces":[{"workspace_id":"w24","worktree":{"checkout_path":"/private/tmp/repo"}}]}}`);
	assert.ok(Array.isArray(list));
	// Herdr reports /private/tmp; the caller says /tmp. Either side matches.
	assert.equal(workspaceForWorktree(list!, "/tmp/repo"), "w24");
	assert.equal(workspaceForWorktree(list!, "/var/other"), undefined);
	assert.equal(parseWorkspaceList("nope"), undefined);
});
