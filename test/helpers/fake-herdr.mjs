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
if (process.env.FAKE_HERDR_AGENT_GONE === "1" && group === "agent" && verb === "get") {
	process.stderr.write(`${JSON.stringify({ error: { code: "agent_not_found", message: "no such agent" } })}\n`);
	process.exit(1);
}

if (group === "workspace" && verb === "list") {
	emit({ workspaces: [{ workspace_id: workspace, cwd, label: "fake" }] });
} else if (group === "tab" && verb === "create") {
	emit({ tab: { tab_id: `${workspace}:t1` }, root_pane: { pane_id: `${workspace}:p1` } });
} else if (group === "pane" && verb === "split") {
	emit({ pane: { pane_id: `${workspace}:p2` } });
} else if (group === "agent" && verb === "get") {
	emit({ agent: { name: argv[2], agent_status: process.env.FAKE_HERDR_AGENT_STATE ?? "working", pane_id: `${workspace}:p1`, tab_id: `${workspace}:t1` } });
} else if (group === "agent" && verb === "start") {
	emit({ agent: { name: argv[2], agent_status: "idle" } });
} else if (group === "agent" && verb === "prompt") {
	emit({ submitted: true });
} else if (group === "tab" && verb === "close") {
	emit({ closed: true });
} else if (group === "notification") {
	emit({ shown: true });
} else {
	emit({});
}
