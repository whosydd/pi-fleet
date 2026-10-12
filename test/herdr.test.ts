import assert from "node:assert/strict";
import test from "node:test";
import {
	agentName,
	agentWaitArgv,
	isAgentWaiting,
	occupancyOf,
	parseAgentGet,
	parsePaneSplit,
	parseTabCreate,
	parseWorkspaceList,
	parseWorktreeOpen,
	planPaneAction,
	workspaceForWorktree,
	worktreeOpenArgv,
	zoneOf,
	tabLabel,
} from "../extensions/lib/herdr.ts";
import type { JobMeta } from "../extensions/lib/types.ts";

test("workspace lookup matches a worktree by real path, including macOS /private", () => {
	const entries = [
		{ workspace_id: "w1", cwd: "/somewhere/else" },
		{ workspace_id: "w2", worktree: { checkout_path: "/private/tmp/repo/.worktrees/p3" } },
	];
	assert.equal(workspaceForWorktree(entries, "/tmp/repo/.worktrees/p3"), "w2");
	assert.equal(workspaceForWorktree(entries, "/tmp/repo/.worktrees/p4"), undefined);
	// An entry with no id cannot be selected, however well its path matches.
	assert.equal(workspaceForWorktree([{ cwd: "/tmp/x" }], "/tmp/x"), undefined);
});

test("agent wait asks Herdr for a state change, not for a verdict", () => {
	assert.deepEqual(agentWaitArgv("fleet-03-ab", 300_000), ["agent", "wait", "fleet-03-ab", "--timeout", "300000"]);
});

test("agent names say the role and the ticket, and stay inside Herdr's alphabet", () => {
	assert.equal(agentName("implement", "02", "The manifest explains its repeated exclusions once"), "implement-02-manifest-explains");
	assert.equal(agentName("review", "02", "The manifest explains its repeated exclusions once"), "review-02-manifest-explains");
	// A title with no usable word still yields a legal name.
	assert.equal(agentName("implement", "02", ""), "implement-02");
	for (const [role, id, title] of [
		["implement", "01", "The headless load smoke test must judge what it loads"],
		["review", "07", "a"],
		["implement", "123", "Ünïcödé ✓ title"],
		["review", "0", ""],
	] as const) {
		const name = agentName(role, id, title);
		assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/, `${role}/${id} -> ${name}`);
		assert.ok(name.length <= 32, `${name} is ${name.length} characters`);
	}
	// A long title stops at a word boundary instead of mid-word, and stays inside
	// Herdr's 32-character rule.
	assert.equal(agentName("implement", "01", "The headless load smoke test must judge what it loads"), "implement-01-headless-load-smoke");
});

test("the tab label leads with the ticket id, so a truncated title still names the ticket", () => {
	assert.equal(tabLabel("02", "The manifest explains its repeated exclusions once"), "02 The manifest explains its repeated exclusions once");
	assert.equal(tabLabel("07", "   "), "ticket 07");
});

test("the response parsers reject shapes they do not recognise instead of guessing", () => {
	assert.deepEqual(parseTabCreate('{"result":{"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p1"}}}'), { tabId: "w1:t1", paneId: "w1:p1" });
	assert.equal(parseTabCreate('{"result":{"tab":{"tab_id":"w1:t1"}}}'), undefined);
	assert.equal(parseTabCreate("not json"), undefined);
	assert.equal(parsePaneSplit('{"result":{"pane":{"pane_id":"w1:p2"}}}'), "w1:p2");
	assert.equal(parsePaneSplit('{"result":{}}'), undefined);
	assert.equal(parseWorkspaceList('{"result":{"workspaces":[]}}')?.length, 0);
	assert.equal(parseWorkspaceList('{"result":{}}'), undefined);
});

test("worktree open restores a workspace, and an unrecognised answer restores nothing", () => {
	assert.deepEqual(worktreeOpenArgv("/tmp/repo/.worktrees/p3"), ["worktree", "open", "--path", "/tmp/repo/.worktrees/p3", "--no-focus"]);
	assert.equal(parseWorktreeOpen('{"result":{"workspace":{"workspace_id":"w25"}}}'), "w25");
	// A worktree that was already open still names its workspace.
	assert.equal(parseWorktreeOpen('{"result":{"already_open":true,"workspace":{"workspace_id":"w25"}}}'), "w25");
	assert.equal(parseWorktreeOpen('{"result":{"workspace":{}}}'), undefined);
	assert.equal(parseWorktreeOpen('{"result":{}}'), undefined);
	assert.equal(parseWorktreeOpen("not json"), undefined);
});

test("agent get carries the lifecycle state, and an unknown state is not a state", () => {
	assert.deepEqual(parseAgentGet('{"result":{"agent":{"name":"a","agent_status":"blocked","pane_id":"w1:p1"}}}'), { status: "blocked", name: "a", paneId: "w1:p1", tabId: undefined, workspaceId: undefined });
	assert.equal(parseAgentGet('{"result":{"agent":{"name":"a","agent_status":"vibing"}}}'), undefined);
	assert.equal(parseAgentGet('{"result":{}}'), undefined);
	// Only `blocked` means a human is needed. `idle` does not: it means ready for input.
	assert.equal(isAgentWaiting("blocked"), true);
	assert.equal(isAgentWaiting("idle"), false);
	assert.equal(isAgentWaiting("done"), false);
});

test("a fix round is execution work, not a review", () => {
	assert.equal(zoneOf("implement"), "exec");
	assert.equal(zoneOf("review"), "review");
});

test("one executor pane per ticket: the first job takes the tab, a fix round reuses it", () => {
	assert.deepEqual(planPaneAction("exec", { exec: [], review: [] }), { kind: "newTab" });
	assert.deepEqual(planPaneAction("exec", { exec: ["w1:p1"], review: [] }), { kind: "reuse", paneId: "w1:p1" });
	// The pane to continue in is the first executor, whatever else a tab accumulated.
	assert.deepEqual(planPaneAction("exec", { exec: ["w1:p1", "w1:p2"], review: [] }), { kind: "reuse", paneId: "w1:p1" });
});

test("pane placement: a reviewer sits right of the first executor, and then stays put", () => {
	assert.deepEqual(planPaneAction("review", { exec: ["w1:p1", "w1:p2"], review: [] }), { kind: "split", anchor: "w1:p1", direction: "right" });
	// The second review reuses the pane the first one used: a human reads the review
	// and the re-review in one place instead of chasing new tabs.
	assert.deepEqual(planPaneAction("review", { exec: ["w1:p1"], review: ["w1:p9"] }), { kind: "reuse", paneId: "w1:p9" });
	// A review of work nobody watches does not borrow a column.
	assert.deepEqual(planPaneAction("review", { exec: [], review: [] }), { kind: "newTab" });
});

function job(overrides: Partial<JobMeta>): JobMeta {
	return { role: "implement", pane: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", agentName: "a" }, ...overrides } as JobMeta;
}

test("occupancy counts only the open panes this package placed in that tab", () => {
	const jobs = [
		job({ pane: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", agentName: "a" } }),
		job({ role: "review", pane: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p9", agentName: "b" } }),
		job({ pane: { workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p3", agentName: "c" } }),
		// A closed pane is not occupancy: its tab is gone.
		job({ pane: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p4", agentName: "d" }, paneClosedAt: 1 }),
	];
	assert.deepEqual(occupancyOf(jobs, "w1:t1"), { exec: ["w1:p1"], review: ["w1:p9"] });
	assert.deepEqual(occupancyOf(jobs, "w1:t2"), { exec: ["w1:p3"], review: [] });
	assert.deepEqual(occupancyOf(jobs, "w1:t9"), { exec: [], review: [] });
	// A fix round reuses the executor's pane, so several jobs of one ticket name
	// one pane, and the placement decision wants the pane once.
	const reused = [...jobs, job({ pane: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", agentName: "a" } })];
	assert.deepEqual(occupancyOf(reused, "w1:t1"), { exec: ["w1:p1"], review: ["w1:p9"] });
});
