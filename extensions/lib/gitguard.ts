/**
 * Git guard: the three git commands that break fleet invariants, named before
 * they run.
 *
 * Pure: it takes a command string and returns a verdict. No fs, no spawning,
 * no pi imports, so every rule is testable without a session. `index.ts` owns
 * the wiring into pi's `tool_call` and `user_bash` handlers.
 *
 * Why these three and not a denylist of "dangerous" words: a fleet run puts one
 * repository's work across several worktrees and points reviews and fix rounds
 * at commit shas. These three commands quietly break one of those guarantees.
 */

export type HazardId = "git-stash" | "commit-amend" | "force-push";

export interface GitHazard {
	id: HazardId;
	/** The command segment that triggered the hazard, for the report. */
	segment: string;
	reason: string;
	alternative: string;
}

/** `git` global flags that consume the following token as their value. */
const GIT_FLAGS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--work-dir", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);

/** Tokens that can sit in front of a command without being the command. */
const COMMAND_WRAPPERS = new Set(["sudo", "command", "env", "nohup", "time", "nice"]);

const HAZARDS: Record<HazardId, { reason: string; alternative: string }> = {
	"git-stash": {
		reason: "git stash stores the work in refs/stash, and one repository shares refs/stash across every worktree. A stash created in this ticket's worktree can pop in another worktree and mix two tickets.",
		alternative: "Commit the work in progress on this ticket's branch, or leave it in the working tree and inspect it with git diff.",
	},
	"commit-amend": {
		reason: "git commit --amend rewrites a commit that a review base or a fix round already names by sha. The old commit stops resolving, so the work those jobs diff against disappears.",
		alternative: 'Create a new commit on top: git commit -m "…".',
	},
	"force-push": {
		reason: "git push --force replaces history that other clones already fetched. A review or a later fix round that points at the old commits then finds nothing.",
		alternative: "Push the new commit with git push. If the push is rejected, fetch and merge first.",
	},
};

/** Split an unquoted shell command into the segments `;`, `|`, `&&`, `||` and newlines join. */
export function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index]!;
		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			index += 1;
			current += command[index];
			continue;
		}
		const pair = command.slice(index, index + 2);
		if (pair === "&&" || pair === "||") {
			segments.push(current);
			current = "";
			index += 1;
			continue;
		}
		if (char === ";" || char === "|" || char === "\n") {
			segments.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	segments.push(current);
	return segments.map((segment) => segment.trim()).filter((segment) => segment !== "");
}

/** Shell-ish tokenizer: quoted runs stay one token, backslashes escape, `NAME=value` prefixes drop out. */
function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let has = false;
	const push = () => {
		if (has) tokens.push(current);
		current = "";
		has = false;
	};
	for (let index = 0; index < segment.length; index += 1) {
		const char = segment[index]!;
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			has = true;
			continue;
		}
		if (char === "\\" && index + 1 < segment.length) {
			index += 1;
			current += segment[index];
			has = true;
			continue;
		}
		if (/\s/.test(char)) {
			push();
			continue;
		}
		current += char;
		has = true;
	}
	push();
	while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
	return tokens;
}

interface GitCall {
	subcommand: string;
	rest: string[];
}

/** Find the git subcommand and its arguments in one segment. */
export function parseGitCall(segment: string): GitCall | undefined {
	const tokens = tokenize(segment);
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index]!;
		if (COMMAND_WRAPPERS.has(token)) {
			// `env` and `command` take their own options; skip any leading
			// dash flags they consume before the real program appears.
			index += 1;
			while (index < tokens.length && tokens[index]!.startsWith("-")) index += 1;
			continue;
		}
		if (token === "git" || token.endsWith("/git")) break;
		index += 1;
	}
	if (index >= tokens.length) return undefined;
	index += 1;
	while (index < tokens.length) {
		const token = tokens[index]!;
		if (token === "--") {
			index += 1;
			break;
		}
		if (token.startsWith("-") && token !== "-") {
			if (!token.includes("=") && GIT_FLAGS_WITH_VALUE.has(token)) index += 1;
			index += 1;
			continue;
		}
		return { subcommand: token, rest: tokens.slice(index + 1) };
	}
	return undefined;
}

function isForceFlag(token: string): boolean {
	return token === "--force" || token === "--force-with-lease" || /^-[A-Za-z]*f[A-Za-z]*$/.test(token);
}

/**
 * The first hazard in a command string, or undefined when the command is safe.
 * Detection is per git call, so a quoted word in a commit message never
 * matches a subcommand.
 */
export function findGitHazard(command: string): GitHazard | undefined {
	for (const segment of splitSegments(command)) {
		const call = parseGitCall(segment);
		if (!call) continue;
		let id: HazardId | undefined;
		if (call.subcommand === "stash") id = "git-stash";
		else if (call.subcommand === "commit" && call.rest.some((token) => token === "--amend")) id = "commit-amend";
		else if (call.subcommand === "push" && call.rest.some(isForceFlag)) id = "force-push";
		if (id) return { id, segment, ...HAZARDS[id] };
	}
	return undefined;
}
