/**
 * Dispatch preflight that needs the real disk.
 *
 * `plan.ts` judges the parameters and stays pure; `index.ts` keeps the checks
 * that only reject (worktree exists, is a git checkout). This module holds the
 * one check that *fixes* something before a process exists: the worktree's own
 * `.gitignore` must already cover the fleet state dir.
 *
 * Why it matters: a state dir that lives inside the worktree — because
 * `PI_FLEET_STATE_DIR` points there, or because the orchestrator runs from that
 * worktree — puts every run dir under the executor's own git status. Untracked
 * fleet artifacts there invite an executor to commit them alongside the
 * ticket's work, which is what a live codex run did before this check existed.
 * When the state dir resolves outside the worktree, this module changes nothing.
 */

import { appendFileSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gitignoreLine, linkIsIgnored } from "./plan.ts";

export interface GitignoreFix {
	/** The line appended to the worktree `.gitignore`, when it needed one. */
	appended?: string;
	/** Why the file could not be fixed. A preflight fix never blocks a dispatch. */
	error?: string;
}

/**
 * Make the worktree ignore its fleet state dir, creating `.gitignore` when the
 * checkout has none. Idempotent: a second call finds the entry and writes
 * nothing.
 *
 * The state dir is matched by basename, so the entry works wherever the run
 * dirs land. A `PI_FLEET_STATE_DIR` that resolves outside the worktree is not
 * the executor's problem — its git status cannot show those files, so an entry
 * would only dirty the checkout for nothing.
 */
export function ensureStateDirIgnored(worktree: string, stateDir: string): GitignoreFix {
	const root = resolve(worktree);
	const dir = resolve(root, stateDir);
	if (!dir.startsWith(`${root}/`)) return {};
	const name = basename(dir);
	// basename("/") is empty: a degenerate state dir has no name to ignore.
	if (!name) return {};

	const path = join(root, ".gitignore");
	try {
		const content = existsSync(path) ? readFileSync(path, "utf8") : "";
		const line = gitignoreLine(content, name);
		if (!line) return {};
		const separator = content === "" || content.endsWith("\n") ? "" : "\n";
		appendFileSync(path, `${separator}${line}\n`, "utf8");
		return { appended: line };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** What the executor will find when it tries to run the project's checks. */
export type DepsState =
	/** No package.json: this project's checks are not Node's business. */
	| "not-node"
	| { state: "ready" }
	| { state: "missing"; hint: string }
	| { state: "untracked-link"; hint: string };

/**
 * Inspect a worktree's Node dependencies before dispatching into it.
 *
 * A worktree carries no `node_modules`, so an executor told to run
 * `npm run check` fails on the environment and can burn a round discovering it.
 * This reports the situation as a note; it never blocks a dispatch and never
 * edits the project's `.gitignore`. Symlinking the parent checkout's
 * `node_modules` is the usual fix, and it is the orchestrator's call — a
 * dependency directory is the project's policy, unlike the fleet state dir, which
 * this module does write.
 */
export function inspectNodeDeps(worktree: string): DepsState {
	if (!existsSync(join(worktree, "package.json"))) return "not-node";
	const modules = join(worktree, "node_modules");
	if (!existsSync(modules)) {
		return { state: "missing", hint: "no node_modules here: install them or symlink the main checkout's before the executor runs the project's checks" };
	}
	let isLink = false;
	try {
		isLink = lstatSync(modules).isSymbolicLink();
	} catch {
		isLink = false;
	}
	if (!isLink) return { state: "ready" };
	// A link is not covered by a `node_modules/` pattern, so it shows up as
	// untracked work the executor may commit with the ticket.
	let content = "";
	try {
		content = readFileSync(join(worktree, ".gitignore"), "utf8");
	} catch {
		content = "";
	}
	if (linkIsIgnored(content, "node_modules")) return { state: "ready" };
	return { state: "untracked-link", hint: "node_modules is a symlink and `node_modules/` in .gitignore does not cover a link: git status will show it as untracked, so expect it in the harvest diff or ignore the bare name" };
}
