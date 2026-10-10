/**
 * Dispatch preflight that needs the real disk.
 *
 * `plan.ts` judges the parameters and stays pure; `index.ts` keeps the checks
 * that only reject (worktree exists, is a git checkout). This module holds the
 * one check that *fixes* something before a process exists: the worktree's own
 * `.gitignore` must already cover the fleet state dir.
 *
 * Why it matters: the run dir is written under a path the executor also
 * resolves from its own cwd (`.fleet/runs/<job>/…`, and `-o result.json` is
 * passed the same way), so an uncovered state dir shows up in the executor's
 * git status as untracked work — noise that invites an executor to commit
 * fleet artifacts with the ticket.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gitignoreLine } from "./plan.ts";

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
