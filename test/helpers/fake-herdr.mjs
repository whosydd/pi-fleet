#!/usr/bin/env node
// Stands in for the `herdr` CLI at the argv pi-fleet actually uses:
//   herdr workspace list
//   herdr tab create --workspace W --label L --cwd C --no-focus
//   herdr pane run <pane_id> <command>
//   herdr tab close <tab_id>
//   herdr notification show <title> --body TEXT --sound done
// Every call is appended as a JSON line to $FAKE_HERDR_LOG so tests can assert
// the sequence. `pane run` starts the command detached and returns, exactly
// like a real pane handoff: the script's own pid and exit_code files are the
// evidence, not this process. $FAKE_HERDR_FAIL=1 makes every call fail, which
// is how tests exercise the degraded-to-spawn path.
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const log = process.env.FAKE_HERDR_LOG;
const args = process.argv.slice(2);

function record(extra = {}) {
	if (log) appendFileSync(log, JSON.stringify({ args, ...extra }) + "\n");
}

if (process.env.FAKE_HERDR_FAIL === "1") {
	record({ failed: true });
	process.stderr.write("fake herdr: no herdr server here\n");
	process.exit(1);
}

const [group, verb, ...rest] = args;
const workspace = process.env.FAKE_HERDR_WORKSPACE ?? "wF";

if (group === "workspace" && verb === "list") {
	record();
	const checkout = process.env.FAKE_HERDR_CWD ?? "/does/not/exist";
	process.stdout.write(
		JSON.stringify({
			id: "cli:workspace:list",
			result: { workspaces: [{ workspace_id: workspace, label: "fake", worktree: { checkout_path: checkout } }] },
			type: "workspace_list",
		}) + "\n",
	);
	process.exit(0);
}

if (group === "tab" && verb === "create") {
	record({ workspace: rest[0] });
	const tag = `${workspace}:t${process.pid}`;
	process.stdout.write(
		JSON.stringify({
			id: "cli:tab:create",
			result: { tab: { tab_id: tag, workspace_id: workspace, label: "fleet" }, root_pane: { pane_id: `${workspace}:p${process.pid}`, tab_id: tag } },
			type: "tab_created",
		}) + "\n",
	);
	process.exit(0);
}

if (group === "pane" && verb === "run") {
	const [paneId, command] = rest;
	record({ paneId, command });
	const child = spawn("bash", ["-c", command], { detached: true, stdio: "ignore" });
	child.unref();
	process.stdout.write(JSON.stringify({ id: "cli:pane:run", result: { type: "ok" } }) + "\n");
	process.exit(0);
}

if (group === "notification" && verb === "show") {
	const [title, ...flags] = rest;
	record({ title });
	const bodyIndex = flags.indexOf("--body");
	process.stdout.write(
		JSON.stringify({
			id: "cli:notification:show",
			result: { type: "notification_show", shown: true, reason: "shown", title, body: bodyIndex >= 0 ? flags[bodyIndex + 1] : null },
		}) + "\n",
	);
	process.exit(0);
}

if (group === "tab" && verb === "close") {
	record({ tabId: rest[0] });
	process.stdout.write(JSON.stringify({ id: "cli:tab:close", result: { type: "ok" } }) + "\n");
	process.exit(0);
}

record({ unknown: true });
process.stderr.write(`fake herdr: unsupported call: ${args.join(" ")}\n`);
process.exit(1);
