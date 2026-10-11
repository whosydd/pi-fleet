/**
 * The one thing this package writes into a project before a job starts: the
 * project has to ignore the fleet's run directory.
 *
 * Why it matters: the run directory holds briefs, logs, and a contract, and it
 * sits inside the checkout the orchestrator runs from. Untracked, it appears in
 * `git status` — and a live codex run once committed fleet artifacts alongside
 * the ticket's work. The run directory is a fleet artifact, not the project's,
 * so the project must not see it.
 *
 * The pure half is separated because the rule that matters is not "append a
 * line" but "do not append it twice": a second dispatch into the same project
 * must leave a `.gitignore` it already fixed exactly as it found it.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * The line a `.gitignore` needs so the fleet's state is invisible to the
 * project's own `git status`.
 *
 * Returns undefined when the file already covers the entry, so a caller can tell
 * "nothing to do" from "wrote something" and report it to the user.
 *
 * Matching is exact on purpose. A pattern such as `.pi` would also cover the
 * project's committed `.pi/settings.json`, and a pattern such as `fleet` would
 * cover an unrelated directory of that name; the fleet adds the narrowest line
 * that works rather than the shortest.
 */
export function gitignoreLine(content: string, entry: string): string | undefined {
	const wanted = entry.trim().replace(/\/+$/, "");
	if (!wanted) return undefined;
	const covered = content.split(/\r?\n/).some((line) => {
		const text = line.trim();
		return text === wanted || text === `${wanted}/`;
	});
	return covered ? undefined : `${wanted}/`;
}

/**
 * Which path inside the project the fleet owns.
 *
 * The default layout puts runs under `.pi/fleet/runs`, and the fleet owns
 * `.pi/fleet` rather than only `runs`: a later release may keep other state
 * beside the runs, and a project should not have to learn a new line for it.
 * A configured runs directory elsewhere is ignored as the directory it is.
 */
export function ignoreTarget(cwd: string, runsDir: string): string | undefined {
	const rel = relative(cwd, runsDir);
	// An absolute runs dir outside the project is not this project's gitignore
	// business: its `git status` cannot show those files.
	if (rel === "" || rel === "." || rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith("/")) return undefined;
	const segments = rel.split(sep);
	if (segments.length >= 3 && segments[0] === ".pi" && segments[1] === "fleet") return [".pi", "fleet"].join("/");
	return segments.join("/");
}

export interface IgnoreFix {
	/** The line appended to the project's `.gitignore`, when it needed one. */
	appended?: string;
	/** Why the file could not be fixed. This never blocks a dispatch. */
	error?: string;
}

/**
 * Make the project ignore the fleet's run directory.
 *
 * Housekeeping, so any failure degrades to a note rather than stopping a job:
 * a run directory an executor might commit is bad, and a dispatch that never
 * started is worse.
 */
export function ensureRunsDirIgnored(cwd: string, runsDir: string, ignoreName = ".gitignore"): IgnoreFix {
	const entry = ignoreTarget(cwd, runsDir);
	if (!entry) return {};
	const path = join(cwd, ignoreName);
	try {
		const content = existsSync(path) ? readFileSync(path, "utf8") : "";
		const line = gitignoreLine(content, entry);
		if (!line) return {};
		const separator = content === "" || content.endsWith("\n") ? "" : "\n";
		appendFileSync(path, `${separator}${line}\n`, "utf8");
		return { appended: line };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
