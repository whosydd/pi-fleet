import assert from "node:assert/strict";
import test from "node:test";
import {
	agentName,
	isAgentWaiting,
	occupancyOf,
	parseAgentGet,
	parsePaneSplit,
	parseTabCreate,
	parseWorkspaceList,
	planPaneAction,
	workspaceForWorktree,
	zoneOf,
	TAB_FANOUT_LIMIT,
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

test("agent names stay inside Herdr's alphabet, whichever ticket they come from", () => {
	for (const ticket of ["03", "23-gitignore", "Feature: Big Change!", "0"]) {
		const name = agentName(ticket, "ab12");
		assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/, `${ticket} -> ${name}`);
		assert.ok(name.length <= 32, `${name} is ${name.length} characters`);
	}
	// A ticket whose slug empties out still yields a legal name.
	assert.match(agentName("!!!", "zz"), /^[a-z]/);
	// Two dispatches of one ticket must not collide on one live name.
	assert.notEqual(agentName("03", "aaaa"), agentName("03", "bbbb"));
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

test("pane placement: first executor takes the tab, the next stack downward", () => {
	assert.deepEqual(planPaneAction("exec", { exec: [], review: [] }), { kind: "newTab" });
	assert.deepEqual(planPaneAction("exec", { exec: ["w1:p1"], review: [] }), { kind: "split", anchor: "w1:p1", direction: "down" });
	assert.deepEqual(planPaneAction("exec", { exec: ["w1:p1", "w1:p2"], review: [] }), { kind: "split", anchor: "w1:p2", direction: "down" });
	// Past the fan-out limit the column stops growing.
	assert.deepEqual(planPaneAction("exec", { exec: Array.from({ length: TAB_FANOUT_LIMIT }, (_, index) => `w1:p${index + 1}`), review: [] }), { kind: "newTab" });
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
});
