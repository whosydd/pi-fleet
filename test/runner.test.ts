import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { DispatchInput } from "../extensions/lib/runner.ts";
import { Runner } from "../extensions/lib/runner.ts";
import { claimTicket } from "../extensions/lib/tickets.ts";
import { readSettings, type FleetSettings } from "../extensions/lib/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeHerdr = join(here, "helpers", "fake-herdr.mjs");
chmodSync(fakeHerdr, 0o755);

const TICKET = `# 03: Token refresh

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] One refresh per expiry.
`;

/** A worktree is only judged by `.git` existing; no git binary is needed here. */
function fakeWorktree(dir: string): string {
	const worktree = join(dir, "worktree");
	mkdirSync(worktree, { recursive: true });
	writeFileSync(join(worktree, ".git"), "gitdir: /nowhere\n", "utf8");
	return worktree;
}

interface Harness {
	dir: string;
	settings: FleetSettings;
	worktree: string;
	ticketPath: string;
	log: string;
	logCalls: () => string[][];
	restore: () => void;
}

/**
 * Build a run environment around a fake Herdr.
 *
 * The environment is restored key by key rather than by reassigning
 * `process.env`: a reassignment detaches the object, and later writes then never
 * reach a spawned child, which silently breaks every test after the first.
 */
function harness(env: Record<string, string>, overrides: Partial<FleetSettings> = {}): Harness {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-runner-"));
	const log = join(dir, "herdr.log");
	const worktree = fakeWorktree(dir);
	const ticketPath = join(dir, "03-token-refresh.md");
	writeFileSync(ticketPath, TICKET, "utf8");

	const saved = new Map<string, string | undefined>();
	const set = (key: string, value: string | undefined) => {
		if (!saved.has(key)) saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	// `...env` last: a test that overrides a default has to win over it.
	for (const [key, value] of Object.entries({ FAKE_HERDR_LOG: log, FAKE_HERDR_WORKSPACE: "wF", FAKE_HERDR_CWD: worktree, ...env })) set(key, value);
	set("HERDR_ENV", "1");
	set("HERDR_WORKSPACE_ID", undefined);

	const settings: FleetSettings = { ...readSettings({}, dir), runsDir: join(dir, "runs"), herdrBin: fakeHerdr, ...overrides };
	return {
		dir,
		settings,
		worktree,
		ticketPath,
		log,
		logCalls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : []),
		restore: () => {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
}

function cleanup(h: Harness): void {
	h.restore();
	rmSync(h.dir, { recursive: true, force: true });
}

function dispatchInput(h: Harness, overrides: Partial<DispatchInput> = {}): DispatchInput {
	return {
		ticketId: "03",
		ticketTitle: "Token refresh",
		ticketPath: h.ticketPath,
		ticketText: TICKET,
		worktree: h.worktree,
		role: "implement" as const,
		executor: "codex" as const,
		fixRound: 0,
		...overrides,
	};
}

test("dispatch builds the run directory, opens a pane, and starts the executor", async () => {
	const h = harness({});
	try {
		const runner = new Runner(h.settings);
		const claim = claimTicket(h.ticketPath);
		assert.equal(claim.ok, true);

		const outcome = await runner.dispatch(dispatchInput(h));
		assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);
		if (!outcome.ok) return;
		const meta = outcome.meta;

		// The executor sees exactly two things: the task and the brief.
		assert.equal(existsSync(meta.taskPath), true);
		assert.equal(existsSync(meta.briefPath), true);
		assert.equal(existsSync(meta.schemaPath), true);
		assert.match(readFileSync(meta.briefPath, "utf8"), /# 03: Token refresh/);
		assert.match(readFileSync(meta.taskPath, "utf8"), /Read the brief at:/);
		assert.equal(existsSync(meta.metaPath), true);

		// The pane is recorded, or a later harvest has nothing to ask about.
		assert.equal(meta.pane?.tabId, "wF:t1");
		assert.equal(meta.pane?.paneId, "wF:p1");
		assert.equal(meta.pane?.agentName, "implement-03");
		assert.equal(meta.role, "implement");
		assert.equal(meta.fixRound, 0);

		const calls = h.logCalls();
		assert.deepEqual(calls.map((call) => call.slice(0, 2).join(" ")), ["workspace list", "pane list", "tab rename", "agent start", "agent prompt"]);
		// The tab herdr opened is renamed to the ticket, not left as `1`.
		assert.deepEqual(calls.find((call) => call[0] === "tab" && call[1] === "rename")?.slice(0, 4), ["tab", "rename", "wF:t1", "03 Token refresh"]);
		assert.match(calls.find((call) => call[0] === "agent" && call[1] === "prompt")?.join(" ") ?? "", /\/runs\/job_03_/);
	} finally {
		cleanup(h);
	}
});

test("dispatch refuses outside Herdr, and says how to fix it", async () => {
	const h = harness({});
	try {
		process.env.HERDR_ENV = "0";
		const outcome = await new Runner(h.settings).dispatch(dispatchInput(h));
		assert.equal(outcome.ok, false);
		assert.match(outcome.ok ? "" : outcome.error, /not running inside Herdr/);
		// Nothing was started, so nothing was written either.
		assert.equal(existsSync(h.log), false);
	} finally {
		cleanup(h);
	}
});

test("dispatch refuses when Herdr gives no workspace and reopening the worktree fails", async () => {
	const h = harness({ FAKE_HERDR_CWD: "/somewhere/else", FAKE_HERDR_OPEN_FAIL: "1" });
	try {
		const outcome = await new Runner(h.settings).dispatch(dispatchInput(h));
		assert.equal(outcome.ok, false);
		assert.match(outcome.ok ? "" : outcome.error, /no Herdr workspace owns/);
		assert.match(outcome.ok ? "" : outcome.error, /herdr worktree create/);
		assert.deepEqual(h.logCalls().map((call) => call.slice(0, 2).join(" ")), ["workspace list", "worktree open"]);
	} finally {
		cleanup(h);
	}
});

test("a worktree whose workspace Herdr closed is reopened, and the pane lands there", async () => {
	// Cleanup closes the ticket's last fleet tab, and Herdr closes the empty
	// workspace with it. The next dispatch must reopen the worktree's workspace
	// rather than run the executor inside the orchestrator's own workspace.
	const h = harness({ FAKE_HERDR_CWD: "/somewhere/else", FAKE_HERDR_OPEN_WORKSPACE: "wN" });
	try {
		const runner = new Runner(h.settings);
		claimTicket(h.ticketPath);
		const outcome = await runner.dispatch(dispatchInput(h));
		assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);
		if (!outcome.ok) return;
		assert.equal(outcome.meta.pane?.workspaceId, "wN");
		const calls = h.logCalls();
		assert.deepEqual(calls.slice(0, 4).map((call) => call.slice(0, 2).join(" ")), ["workspace list", "worktree open", "pane list", "tab create"]);
		assert.equal(calls[3]![calls[3]!.indexOf("--workspace") + 1], "wN");
	} finally {
		cleanup(h);
	}
});

test("a workspace without a free first pane gets a new tab", async () => {
	const h = harness({ FAKE_HERDR_NO_ROOT_PANE: "1" });
	try {
		claimTicket(h.ticketPath);
		const outcome = await new Runner(h.settings).dispatch(dispatchInput(h));
		assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);
		if (!outcome.ok) return;
		assert.equal(h.logCalls().filter((call) => call[0] === "tab" && call[1] === "create").length, 1);
		assert.equal(outcome.meta.pane?.paneId, "wF:p1");
	} finally {
		cleanup(h);
	}
});

test("a fix round continues in the executor that built the ticket", async () => {
	const h = harness({});
	try {
		const runner = new Runner(h.settings);
		claimTicket(h.ticketPath);
		const built = await runner.dispatch(dispatchInput(h));
		assert.equal(built.ok, true, built.ok ? "" : built.error);
		if (!built.ok) return;

		claimTicket(h.ticketPath);
		const fixed = await runner.dispatch(dispatchInput(h, { fixRound: 1, findings: ["standards: the reason is not where a reader looks"] }));
		assert.equal(fixed.ok, true, fixed.ok ? "" : fixed.error);
		if (!fixed.ok) return;

		// Same pane, same agent: a fix round re-prompts the codex that built the
		// ticket instead of starting a second one that must explore again.
		assert.equal(fixed.meta.pane?.paneId, built.meta.pane?.paneId);
		assert.equal(fixed.meta.pane?.agentName, built.meta.pane?.agentName);
		const calls = h.logCalls();
		assert.equal(calls.filter((call) => call[0] === "agent" && call[1] === "start").length, 1, "one codex, re-prompted");
		assert.equal(calls.filter((call) => call[0] === "pane" && call[1] === "split").length, 0);
		// No tab was created: the first job took the pane herdr left in the workspace.
		assert.equal(calls.filter((call) => call[0] === "tab" && call[1] === "create").length, 0);
	} finally {
		cleanup(h);
	}
});

test("a fix round starts a fresh executor when the reuse target's agent is gone", async () => {
	// The human closed the codex TUI between rounds. Herdr no longer knows the
	// name, but the pane is still there, and the fix round belongs in it.
	const h = harness({ FAKE_HERDR_AGENT_GONE: "1" });
	try {
		const runner = new Runner(h.settings);
		claimTicket(h.ticketPath);
		const built = await runner.dispatch(dispatchInput(h));
		assert.equal(built.ok, true, built.ok ? "" : built.error);
		if (!built.ok) return;

		claimTicket(h.ticketPath);
		const fixed = await runner.dispatch(dispatchInput(h, { fixRound: 1, findings: ["standards: x"] }));
		assert.equal(fixed.ok, true, fixed.ok ? "" : fixed.error);
		if (!fixed.ok) return;
		assert.equal(fixed.meta.pane?.paneId, built.meta.pane?.paneId);
		assert.equal(h.logCalls().filter((call) => call[0] === "agent" && call[1] === "start").length, 2, "a fresh codex in the same pane");
		assert.equal(h.logCalls().filter((call) => call[0] === "pane" && call[1] === "split").length, 0);
	} finally {
		cleanup(h);
	}
});

test("a review reuses the pane the first review used, and never a second tab", async () => {
	const h = harness({});
	try {
		const runner = new Runner(h.settings);
		claimTicket(h.ticketPath);
		const built = await runner.dispatch(dispatchInput(h));
		assert.equal(built.ok, true, built.ok ? "" : built.error);

		claimTicket(h.ticketPath);
		const firstReview = await runner.dispatch(dispatchInput(h, { role: "review", executor: "claude", base: "fleet/03" }));
		assert.equal(firstReview.ok, true, firstReview.ok ? "" : firstReview.error);
		if (!firstReview.ok) return;

		claimTicket(h.ticketPath);
		const secondReview = await runner.dispatch(dispatchInput(h, { role: "review", executor: "claude", base: "fleet/03", fixRound: 1 }));
		assert.equal(secondReview.ok, true, secondReview.ok ? "" : secondReview.error);
		if (!secondReview.ok) return;

		// One tab for the ticket, and it is the one herdr opened with the worktree.
		assert.equal(firstReview.meta.pane?.tabId, "wF:t1");
		assert.equal(secondReview.meta.pane?.tabId, "wF:t1");
		assert.equal(h.logCalls().filter((call) => call[0] === "tab" && call[1] === "create").length, 0);
		// The re-review is a re-prompt of the standing reviewer, not a second agent.
		const starts = h.logCalls().filter((call) => call[0] === "agent" && call[1] === "start");
		assert.equal(starts.length, 2, "one codex for the build, one claude for the review");
		assert.equal(secondReview.meta.pane?.agentName, firstReview.meta.pane?.agentName);
	} finally {
		cleanup(h);
	}
});

test("waitAgent reports Herdr's state signal, and gives undefined when the name is gone", async () => {
	const h = harness({ FAKE_HERDR_AGENT_STATE: "idle" });
	try {
		const read = await new Runner(h.settings).waitAgent("fleet-03-ab", 1000);
		assert.equal(read?.status, "idle");
		assert.deepEqual(h.logCalls().at(-1)?.slice(0, 2), ["agent", "wait"]);
	} finally {
		cleanup(h);
	}

	const gone = harness({ FAKE_HERDR_AGENT_GONE: "1" });
	try {
		// A vanished name is not an error to retry forever: the harvest that follows
		// settles the job as failed.
		assert.equal(await new Runner(gone.settings).waitAgent("fleet-03-ab", 1000), undefined);
	} finally {
		cleanup(gone);
	}
});

test("harvest runs while the agent works, and settles only on the contract", async () => {
	const h = harness({ FAKE_HERDR_AGENT_STATE: "working" });
	try {
		const runner = new Runner(h.settings);
		claimTicket(h.ticketPath);
		const built = await runner.dispatch(dispatchInput(h));
		assert.equal(built.ok, true, built.ok ? "" : built.error);
		if (!built.ok) return;

		const running = await runner.harvest(built.meta.id);
		assert.equal(running.kind, "running");
		assert.equal(running.kind === "running" ? running.status : "", "working");
		assert.equal(runner.get(built.meta.id)?.contractOk, undefined);

		writeFileSync(built.meta.resultPath, JSON.stringify({ ticket: "03", status: "implemented", branch: "fleet/03", tests: { command: "npm test", passed: 1, failed: 0 } }), "utf8");
		const done = await runner.harvest(built.meta.id);
		assert.equal(done.kind, "complete");
		assert.equal(runner.get(built.meta.id)?.contractOk, true);
	} finally {
		cleanup(h);
	}
});

test("a zero exit with a broken contract is contract_failed, never complete", async () => {
	const h = harness({ FAKE_HERDR_AGENT_STATE: "idle" });
	try {
		const runner = new Runner(h.settings);
		claimTicket(h.ticketPath);
		const built = await runner.dispatch(dispatchInput(h));
		assert.equal(built.ok, true, built.ok ? "" : built.error);
		if (!built.ok) return;

		// Answering another ticket is one fault, whatever else the contract carries.
		writeFileSync(built.meta.resultPath, JSON.stringify({ ticket: "#99", status: "implemented", branch: "b", tests: { command: "x", passed: 1, failed: 0 } }), "utf8");
		const first = await runner.harvest(built.meta.id);
		assert.equal(first.kind, "contract_failed");
		assert.match(first.kind === "contract_failed" ? first.error : "", /is not the ticket this job was dispatched for/);
		assert.equal(runner.get(built.meta.id)?.contractOk, false);

		// A settled job keeps the verdict it settled with: re-harvesting does not go
		// looking for a second, different complaint.
		const second = await runner.harvest(built.meta.id);
		assert.equal(second.kind, "contract_failed");
		assert.equal(second.kind === "contract_failed" ? second.error : "", first.kind === "contract_failed" ? first.error : "different");
	} finally {
		cleanup(h);
	}
});

test("an idle agent without a contract fails only after the grace, and work resuming clears the clock", async () => {
	const h = harness({ FAKE_HERDR_AGENT_STATE: "idle" }, { idleGraceMs: 60_000 });
	try {
		const runner = new Runner(h.settings);
		claimTicket(h.ticketPath);
		const built = await runner.dispatch(dispatchInput(h));
		assert.equal(built.ok, true, built.ok ? "" : built.error);
		if (!built.ok) return;

		// `idle` means ready for input. A live run was idle mid-task and committed
		// minutes later, so the first idle harvest must not settle anything.
		const first = await runner.harvest(built.meta.id);
		assert.equal(first.kind, "running");
		assert.equal(first.kind === "running" ? first.status : "", "idle");
		assert.notEqual(runner.get(built.meta.id)?.idleSince, undefined, "the idle clock started");

		// The agent goes back to work: the clock clears, so a long job that paused
		// once does not drift toward failure.
		process.env.FAKE_HERDR_AGENT_STATE = "working";
		const working = await runner.harvest(built.meta.id);
		assert.equal(working.kind, "running");
		assert.equal(runner.get(built.meta.id)?.idleSince, undefined, "the idle clock cleared");
	} finally {
		cleanup(h);
	}
});

test("an idle agent past the grace settles as contract_failed, naming the pane", async () => {
	const h = harness({ FAKE_HERDR_AGENT_STATE: "idle" }, { idleGraceMs: 1 });
	try {
		const runner = new Runner(h.settings);
		claimTicket(h.ticketPath);
		const built = await runner.dispatch(dispatchInput(h));
		assert.equal(built.ok, true, built.ok ? "" : built.error);
		if (!built.ok) return;

		await runner.harvest(built.meta.id);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const settled = await runner.harvest(built.meta.id);
		assert.equal(settled.kind, "contract_failed");
		assert.match(settled.kind === "contract_failed" ? settled.error : "", /without writing the contract/);
		assert.match(settled.kind === "contract_failed" ? settled.error : "", /Read pane wF:p1/);
		assert.equal(runner.get(built.meta.id)?.contractOk, false);
	} finally {
		cleanup(h);
	}
});

test("an agent Herdr no longer knows is a failed job, not a silent one", async () => {
	const h = harness({});
	try {
		const runner = new Runner(h.settings);
		claimTicket(h.ticketPath);
		const built = await runner.dispatch(dispatchInput(h));
		assert.equal(built.ok, true, built.ok ? "" : built.error);
		if (!built.ok) return;

		process.env.FAKE_HERDR_AGENT_GONE = "1";
		const gone = await runner.harvest(built.meta.id);
		assert.equal(gone.kind, "failed");
		assert.match(gone.kind === "failed" ? gone.error : "", /is gone and wrote no contract/);
	} finally {
		cleanup(h);
	}
});

test("harvest of an unknown job says so instead of inventing a meta", async () => {
	const h = harness({});
	try {
		const report = await new Runner(h.settings).harvest("job_nope");
		assert.equal(report.kind, "unknown");
		assert.match(report.kind === "unknown" ? report.error : "", /no run directory named "job_nope"/);
	} finally {
		cleanup(h);
	}
});

test("a run directory from another release is not a job: it is named, and left alone", async () => {
	const h = harness({});
	try {
		// The shape the previous pi-fleet wrote: no schemaVersion, and `taskKind`
		// where this release reads `role`. Reading it as a job reported `undefined`
		// as a harness, a settled job as still running, and a pane Herdr closed days
		// ago as still open.
		const staleDir = join(h.settings.runsDir, "job_old_1");
		mkdirSync(staleDir, { recursive: true });
		const staleMeta = { id: "job_old_1", ticket: "07", executor: "codex", taskKind: "implement", state: "running", contractOk: true };
		const stalePath = join(staleDir, "meta.json");
		writeFileSync(stalePath, JSON.stringify(staleMeta, null, 2), "utf8");

		const runner = new Runner(h.settings);
		// Not a job, so it is not counted as one.
		assert.deepEqual(runner.all(), []);
		// But it is not hidden either: the user needs to know the disk holds it.
		const stale = runner.stale();
		assert.equal(stale.length, 1);
		assert.equal(stale[0]!.id, "job_old_1");
		assert.match(stale[0]!.reason, /schema version none, and this release reads 1/);

		// Harvest refuses rather than asking Herdr about an agent that is long gone.
		const harvested = await runner.harvest("job_old_1");
		assert.equal(harvested.kind, "unknown");
		assert.match(harvested.kind === "unknown" ? harvested.error : "", /not a job this release can read/);
		// Cleanup refuses rather than closing a tab that no longer exists.
		const closed = await runner.closeTab("job_old_1");
		assert.equal(closed.ok, false);
		assert.match(closed.error ?? "", /not a job this release can read/);

		// The point of the whole check: nothing wrote a verdict onto somebody else's
		// record. A fresh harvest of a stale job must not settle it.
		assert.deepEqual(JSON.parse(readFileSync(stalePath, "utf8")), staleMeta);
	} finally {
		cleanup(h);
	}
});

test("cleanup refuses an unsettled job and closes a settled one, once", async () => {
	const h = harness({ FAKE_HERDR_AGENT_STATE: "working" });
	try {
		const runner = new Runner(h.settings);
		claimTicket(h.ticketPath);
		const built = await runner.dispatch(dispatchInput(h));
		assert.equal(built.ok, true, built.ok ? "" : built.error);
		if (!built.ok) return;

		const refused = await runner.closeTab(built.meta.id);
		assert.equal(refused.ok, false);
		assert.match(refused.error ?? "", /not settled/);

		writeFileSync(built.meta.resultPath, JSON.stringify({ ticket: "03", status: "implemented", branch: "fleet/03", tests: { command: "x", passed: 1, failed: 0 } }), "utf8");
		await runner.harvest(built.meta.id);

		assert.equal((await runner.closeTab(built.meta.id)).ok, true);
		assert.notEqual(runner.get(built.meta.id)?.paneClosedAt, undefined);
		// Closing twice is not an error, and it does not close a tab twice either.
		const again = await runner.closeTab(built.meta.id);
		assert.equal(again.ok, true);
		assert.equal(again.alreadyClosed, true);
		assert.equal(h.logCalls().filter((call) => call[0] === "tab" && call[1] === "close").length, 1);

		// A job on disk with no pane cannot be closed, and says why.
		assert.match((await runner.closeTab("job_nope")).error ?? "", /no run directory named "job_nope"/);
	} finally {
		cleanup(h);
	}
});

test("a job survives the session: a fresh runner reads it from the run directory", async () => {
	const h = harness({});
	try {
		claimTicket(h.ticketPath);
		const built = await new Runner(h.settings).dispatch(dispatchInput(h));
		assert.equal(built.ok, true, built.ok ? "" : built.error);
		if (!built.ok) return;

		// A second Runner holds nothing in memory; every fact comes from disk.
		const later = new Runner(h.settings);
		const inherited = later.get(built.meta.id);
		assert.equal(inherited?.ticket, "03");
		assert.equal(inherited?.pane?.paneId, "wF:p1");
		assert.equal(later.all().length, 1);
		assert.deepEqual(readdirSync(join(h.settings.runsDir, built.meta.id)).sort(), ["brief.md", "meta.json", "schema.json", "task.txt"]);
	} finally {
		cleanup(h);
	}
});
