#!/usr/bin/env node
/**
 * A stand-in for the Herdr CLI.
 *
 * It answers the calls this package makes with the response shapes the real CLI
 * documents, and appends every call to $FAKE_HERDR_LOG so a test can assert what
 * was asked. Agent lifecycle state comes from $FAKE_HERDR_AGENT_STATE, which is
 * the one thing a test needs to vary.
 */

import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const log = process.env.FAKE_HERDR_LOG;
if (log) appendFileSync(log, `${JSON.stringify(argv)}\n`, "utf8");

const workspace = process.env.FAKE_HERDR_WORKSPACE ?? "wF";
const cwd = process.env.FAKE_HERDR_CWD ?? process.cwd();
const emit = (result) => process.stdout.write(`${JSON.stringify({ result })}\n`);

const [group, verb] = argv;

/** A vanished agent: the real CLI answers a missing name with a non-zero exit. */
if (process.env.FAKE_HERDR_AGENT_GONE === "1" && group === "agent" && (verb === "get" || verb === "wait")) {
	process.stderr.write(`${JSON.stringify({ error: { code: "agent_not_found", message: "no such agent" } })}\n`);
	process.exit(1);
}

if (group === "workspace" && verb === "list") {
	emit({ workspaces: [{ workspace_id: workspace, cwd, label: "fake" }] });
} else if (group === "worktree" && verb === "open") {
	// A closed worktree workspace is restored here. FAKE_HERDR_OPEN_FAIL simulates a
	// path Herdr refuses to open, which is the only case dispatch still rejects.
	emit(process.env.FAKE_HERDR_OPEN_FAIL === "1" ? {} : { already_open: false, workspace: { workspace_id: process.env.FAKE_HERDR_OPEN_WORKSPACE ?? workspace } });
} else if (group === "pane" && verb === "list") {
	// The pane `herdr worktree create` leaves behind: one tab, a shell in it.
	// FAKE_HERDR_NO_ROOT_PANE simulates a workspace without it, which is what makes
	// the caller fall back to `tab create`.
	const panes = process.env.FAKE_HERDR_NO_ROOT_PANE === "1" ? [] : [{ pane_id: `${workspace}:p1`, tab_id: `${workspace}:t1`, workspace_id: workspace, agent: null }];
	emit({ panes });
} else if (group === "tab" && verb === "create") {
	emit({ tab: { tab_id: `${workspace}:t1` }, root_pane: { pane_id: `${workspace}:p1` } });
} else if (group === "pane" && verb === "split") {
	emit({ pane: { pane_id: `${workspace}:p2` } });
} else if (group === "agent" && verb === "get") {
	emit({ agent: { name: argv[2], agent_status: process.env.FAKE_HERDR_AGENT_STATE ?? "working", pane_id: `${workspace}:p1`, tab_id: `${workspace}:t1` } });
} else if (group === "agent" && verb === "wait") {
	// The real wait returns the moment the agent changes state. The stand-in
	// answers at once with the state the test asked for.
	emit({ agent: { name: argv[2], agent_status: process.env.FAKE_HERDR_AGENT_STATE ?? "working", pane_id: `${workspace}:p1`, tab_id: `${workspace}:t1` } });
} else if (group === "agent" && verb === "start") {
	emit({ agent: { name: argv[2], agent_status: "idle" } });
} else if (group === "agent" && verb === "prompt") {
	emit({ submitted: true });
} else if (group === "tab" && verb === "close") {
	emit({ closed: true });
} else if (group === "tab" && verb === "rename") {
	emit({ renamed: true });
} else if (group === "notification") {
	emit({ shown: true });
} else {
	emit({});
}
