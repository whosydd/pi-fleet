#!/usr/bin/env node
// Stands in for the `herdr` CLI at the argv pi-fleet actually uses:
//   herdr workspace list
//   herdr tab create --workspace W --label L --cwd C --no-focus
//   herdr tab close <tab_id>
//   herdr pane split <pane_id> --direction D --cwd C --no-focus
//   herdr pane close <pane_id>
//   herdr agent start <name> --kind K --pane ID
//   herdr agent prompt <name> <text>
//   herdr agent get <name>
//   herdr agent wait <name> ...
//   herdr notification show <title> --body TEXT --sound done
// Every call is appended as a JSON line to $FAKE_HERDR_LOG so tests can assert
// the sequence. The reported agent state comes from $FAKE_HERDR_AGENT_STATE
// (default: working), and $FAKE_HERDR_AGENT_GONE=1 makes `agent get` answer the
// way herdr does for an unknown name. $FAKE_HERDR_FAIL=1 fails every call, which
// is how tests exercise the degraded-to-spawn path.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const log = process.env.FAKE_HERDR_LOG;
const args = process.argv.slice(2);
const workspace = process.env.FAKE_HERDR_WORKSPACE ?? "wF";
const state = process.env.FAKE_HERDR_AGENT_STATE ?? "working";

function record(extra = {}) {
	if (log) appendFileSync(log, JSON.stringify({ args, ...extra }) + "\n");
}

function emit(value) {
	process.stdout.write(JSON.stringify(value) + "\n");
}

function fail(message, code = "cli_error") {
	process.stderr.write(JSON.stringify({ error: { code, message } }) + "\n");
	process.exit(1);
}

if (process.env.FAKE_HERDR_FAIL === "1") {
	record({ failed: true });
	fail("fake herdr: no herdr server here");
}

const [group, verb, ...rest] = args;

/** The live agent names this fake "started", so `agent get` can report unknown. */
function liveAgents() {
	const file = `${log}.agents`;
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

function saveLiveAgents(map) {
	if (log) writeFileSync(`${log}.agents`, JSON.stringify(map));
}

if (group === "workspace" && verb === "list") {
	record();
	emit({
		id: "cli:workspace:list",
		result: { workspaces: [{ workspace_id: workspace, label: "fake", worktree: { checkout_path: process.env.FAKE_HERDR_CWD ?? "/does/not/exist" } }] },
		type: "workspace_list",
	});
	process.exit(0);
}

if (group === "tab" && verb === "create") {
	record({ workspace: rest[0] });
	const tag = `${workspace}:t${process.pid}`;
	emit({
		id: "cli:tab:create",
		result: { tab: { tab_id: tag, workspace_id: workspace, label: "fleet" }, root_pane: { pane_id: `${workspace}:p${process.pid}`, tab_id: tag } },
		type: "tab_created",
	});
	process.exit(0);
}

if (group === "tab" && verb === "close") {
	record({ tabId: rest[0] });
	emit({ id: "cli:tab:close", result: { type: "ok" } });
	process.exit(0);
}

if (group === "pane" && verb === "split") {
	record({ paneId: rest[0], direction: rest[2] });
	emit({ id: "cli:pane:split", result: { pane: { pane_id: `${workspace}:ps${process.pid}`, tab_id: rest[0].split(":")[0] + ":t1" } }, type: "pane_split" });
	process.exit(0);
}

if (group === "pane" && verb === "close") {
	record({ paneId: rest[0] });
	emit({ id: "cli:pane:close", result: { type: "ok" } });
	process.exit(0);
}

if (group === "agent" && verb === "start") {
	const [name, ...tail] = rest;
	record({ name, kind: tail[tail.indexOf("--kind") + 1] ?? null, pane: tail[tail.indexOf("--pane") + 1] ?? null });
	const live = liveAgents();
	live[name] = state;
	saveLiveAgents(live);
	emit({
		id: "cli:agent:start",
		result: { agent: { agent: tail[tail.indexOf("--kind") + 1] ?? "codex", agent_status: state, name, interactive_ready: true, pane_id: tail[tail.indexOf("--pane") + 1] ?? null, tab_id: `${workspace}:t1`, workspace_id: workspace } },
		type: "agent_started",
	});
	process.exit(0);
}

if (group === "agent" && verb === "get") {
	const [name] = rest;
	record({ name });
	if (process.env.FAKE_HERDR_AGENT_GONE === "1" || !(name in liveAgents())) {
		fail(`agent ${name} not found`, "agent_not_found");
	}
	const current = liveAgents()[name];
	emit({ id: "cli:agent:get", result: { agent: { agent: "codex", agent_status: current, name, interactive_ready: true, pane_id: `${workspace}:p1`, tab_id: `${workspace}:t1`, workspace_id: workspace } }, type: "agent_info" });
	process.exit(0);
}

if (group === "agent" && verb === "prompt") {
	const [name, text] = rest;
	record({ name, task: text });
	// The fake executor never runs here, so a test drives the contract file by
	// hand; the prompt is only recorded.
	const live = liveAgents();
	if (name in live) saveLiveAgents(live);
	emit({ id: "cli:agent:prompt", result: { type: "agent_prompted", agent: { name, agent_status: live[name] ?? state } } });
	process.exit(0);
}

if (group === "agent" && verb === "wait") {
	record({ name: rest[0] });
	emit({ id: "cli:agent:wait", result: { type: "agent_waited", agent: { name: rest[0], agent_status: liveAgents()[rest[0]] ?? state } } });
	process.exit(0);
}

if (group === "notification" && verb === "show") {
	const [title, ...flags] = rest;
	record({ title });
	const bodyIndex = flags.indexOf("--body");
	emit({ id: "cli:notification:show", result: { type: "notification_show", shown: true, reason: "shown", title, body: bodyIndex >= 0 ? flags[bodyIndex + 1] : null } });
	process.exit(0);
}

record({ unknown: true });
fail(`fake herdr: unsupported call: ${args.join(" ")}`, "unsupported");
