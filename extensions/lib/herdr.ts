/**
 * The Herdr protocol, as pure functions: every argv this package sends and
 * every response shape it reads.
 *
 * Pure: no fs, no spawning, no pi imports. `runner.ts` executes what these
 * build, `index.ts` wires the tools. Every rule and every parser is testable
 * without a Herdr session.
 *
 * Three facts from the Herdr CLI shape this module.
 *
 * First, `idle` and `done` both mean "ready for input", never "the task
 * finished", and `unknown` proves nothing. So no lifecycle state ever decides
 * success: the contract file does, exactly as in any other delivery.
 *
 * Second, `agent start` returns only once Herdr has detected the executor and
 * considers it ready, so this package does not model startup itself.
 *
 * Third, a pane transcript is unreliable to parse: soft wraps, the TUI's own
 * chrome, and scrollback limits. Live reads returned the prompt box instead of
 * the answer. So the contract travels as a file, and the human reads the pane
 * by eye.
 */

import type { ExecutorKind, FleetRole, JobMeta } from "./types.ts";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/**
 * How long Herdr itself waits for an executor TUI to come up.
 *
 * The execFile timeout that wraps this call must be strictly larger, or pi kills
 * the CLI mid-wait and an agent that was coming up is reported as a startup
 * failure. That pairing is the bug this constant documents.
 */
export const AGENT_START_TIMEOUT_MS = 120_000;
/** Must exceed AGENT_START_TIMEOUT_MS: pi's patience wraps Herdr's. */
export const AGENT_START_CALL_MS = AGENT_START_TIMEOUT_MS + 30_000;
/** A prompt only writes into an existing pane, so it needs far less patience. */
export const PROMPT_CALL_MS = 30_000;
/** A read returns in milliseconds; anything slower is a broken server. */
export const CALL_MS = 15_000;

/** Shapes seen in `herdr workspace list`. */
export interface WorkspaceEntry {
	workspace_id?: string;
	cwd?: string;
	label?: string;
	worktree?: { checkout_path?: string; repo_root?: string } | null;
}

/** The `agent get` facts a harvest needs. */
export interface AgentRead {
	status: AgentStatus;
	name: string;
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
}

// ---------------------------------------------------------------------------
// argv

export function workspaceListArgv(): string[] {
	return ["workspace", "list"];
}

export function tabCreateArgv(workspaceId: string, label: string, cwd: string): string[] {
	return ["tab", "create", "--workspace", workspaceId, "--label", label, "--cwd", cwd, "--no-focus"];
}

export function tabCloseArgv(tabId: string): string[] {
	return ["tab", "close", tabId];
}

export function paneSplitArgv(paneId: string, direction: "right" | "down", cwd: string): string[] {
	return ["pane", "split", paneId, "--direction", direction, "--cwd", cwd, "--no-focus"];
}

/**
 * `herdr agent start` argv. A model override goes after `--`, which Herdr passes
 * to the agent unchanged; the flag spelling is the executor's own.
 */
export function agentStartArgv(name: string, kind: ExecutorKind, paneId: string, model?: string): string[] {
	const argv = ["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", String(AGENT_START_TIMEOUT_MS)];
	if (model) argv.push("--", kind === "codex" ? "-m" : "--model", model);
	return argv;
}

/** `herdr agent prompt` argv. The task text is one argument; no shell sees it. */
export function agentPromptArgv(name: string, task: string): string[] {
	return ["agent", "prompt", name, task];
}

export function agentGetArgv(name: string): string[] {
	return ["agent", "get", name];
}

/** `herdr notification show` argv, for a session with no interactive UI. */
export function notifyArgv(title: string, body: string): string[] {
	return ["notification", "show", title, "--body", body, "--sound", "done"];
}

// ---------------------------------------------------------------------------
// Parsing

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The `herdr workspace list` entries, or undefined when the output is not that shape. */
export function parseWorkspaceList(stdout: string): WorkspaceEntry[] | undefined {
	const workspaces = (parseJson(stdout) as { result?: { workspaces?: unknown } } | undefined)?.result?.workspaces;
	return Array.isArray(workspaces) ? (workspaces as WorkspaceEntry[]) : undefined;
}

/** The tab and pane ids a `herdr tab create` response reported, or undefined. */
export function parseTabCreate(stdout: string): { tabId: string; paneId: string } | undefined {
	const result = (parseJson(stdout) as { result?: { tab?: { tab_id?: string }; root_pane?: { pane_id?: string } } } | undefined)?.result;
	const tabId = result?.tab?.tab_id;
	const paneId = result?.root_pane?.pane_id;
	if (typeof tabId !== "string" || tabId === "" || typeof paneId !== "string" || paneId === "") return undefined;
	return { tabId, paneId };
}

/** The pane id a `herdr pane split` response reported, or undefined. */
export function parsePaneSplit(stdout: string): string | undefined {
	const paneId = (parseJson(stdout) as { result?: { pane?: { pane_id?: string } } } | undefined)?.result?.pane?.pane_id;
	return typeof paneId === "string" && paneId !== "" ? paneId : undefined;
}

/** The agent facts an `herdr agent get` response reported, or undefined. */
export function parseAgentGet(stdout: string): AgentRead | undefined {
	const agent = (parseJson(stdout) as { result?: { agent?: Record<string, unknown> } } | undefined)?.result?.agent;
	if (!agent) return undefined;
	const status = agent.agent_status;
	if (status !== "idle" && status !== "working" && status !== "blocked" && status !== "done" && status !== "unknown") return undefined;
	const id = (key: string) => (typeof agent[key] === "string" ? (agent[key] as string) : undefined);
	return { status, name: typeof agent.name === "string" ? agent.name : "", paneId: id("pane_id"), tabId: id("tab_id"), workspaceId: id("workspace_id") };
}

// ---------------------------------------------------------------------------
// Naming and lookup

/**
 * A Herdr agent name for one job: `fleet-<ticket>-<nonce>`, kept inside Herdr's
 * `[a-z][a-z0-9_-]{0,31}` rule. The nonce keeps two dispatches of one ticket
 * (a review while a fix round runs) from colliding on one live name.
 */
export function agentName(ticket: string, nonce: string): string {
	const slug = ticket
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[-_]+/, "")
		.replace(/[-_]+$/, "");
	const raw = `fleet-${slug === "" ? "job" : slug}-${nonce}`.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
	return /^[a-z]/.test(raw) ? raw : `f${raw}`.slice(0, 32);
}

/**
 * The Herdr workspace whose worktree is this path.
 *
 * Matching is by real path: Herdr reports `/private/tmp/...` where the caller
 * passes `/tmp/...`, and macOS resolves one to the other. Entries without a
 * usable id drop out.
 */
export function workspaceForWorktree(entries: WorkspaceEntry[], worktree: string): string | undefined {
	const wanted = normalisePath(worktree);
	for (const entry of entries) {
		const id = entry.workspace_id;
		if (!id) continue;
		const candidates = [entry.worktree?.checkout_path, entry.worktree?.repo_root, entry.cwd];
		if (candidates.some((path) => path !== undefined && normalisePath(path) === wanted)) return id;
	}
	return undefined;
}

/** Resolve macOS `/private` symlinks without touching the filesystem. */
function normalisePath(path: string): string {
	return path.startsWith("/private/") ? path.slice("/private".length) : path;
}

// ---------------------------------------------------------------------------
// Pane placement

/** Which side of a ticket's tab a job runs on: executors left, reviewers right. */
export type PaneZone = "exec" | "review";

/** The zone a role belongs to. A fix round is execution work, not a review. */
export function zoneOf(role: FleetRole): PaneZone {
	return role === "review" ? "review" : "exec";
}

/** Where the next job in a ticket's tab goes. */
export type PaneAction = { kind: "newTab" } | { kind: "split"; anchor: string; direction: "right" | "down" } | { kind: "reuse"; paneId: string };

/** The panes a ticket's tab already holds, one list per zone, newest last. */
export interface TabOccupancy {
	exec: string[];
	review: string[];
}

/** When a tab holds this many executors, open a new tab instead of splitting again. */
export const TAB_FANOUT_LIMIT = 3;

/**
 * Place one job in a ticket's tab.
 *
 * The tab's first pane hosts the first executor, so the left column is
 * executors and each later one stacks downward beside the same worktree. A
 * reviewer splits right off the first executor and then stays put: fix rounds
 * reuse that pane, so a human reads the review and the re-review in one place
 * instead of chasing new tabs. Past `TAB_FANOUT_LIMIT` executors the column
 * stops growing and a new tab opens.
 *
 * A reviewer with no executor to sit beside opens its own tab: a review of work
 * nobody is watching does not deserve a borrowed column.
 */
export function planPaneAction(zone: PaneZone, tab: TabOccupancy): PaneAction {
	if (zone === "review") {
		const last = tab.review.at(-1);
		if (last) return { kind: "reuse", paneId: last };
		const anchor = tab.exec[0];
		if (!anchor) return { kind: "newTab" };
		return { kind: "split", anchor, direction: "right" };
	}
	if (tab.exec.length === 0 || tab.exec.length >= TAB_FANOUT_LIMIT) return { kind: "newTab" };
	return { kind: "split", anchor: tab.exec.at(-1) ?? "", direction: "down" };
}

/**
 * The occupancy of the tab a new job would join, read off the jobs already
 * placed in it.
 *
 * Reads the registry rather than Herdr: the answer must be the tab this package
 * built, and jobs the human placed by hand are none of its business.
 */
export function occupancyOf(jobs: JobMeta[], tabId: string): TabOccupancy {
	const inTab = jobs.filter((job) => job.pane?.tabId === tabId && job.paneClosedAt === undefined);
	return {
		exec: inTab.filter((job) => zoneOf(job.role) === "exec").map((job) => job.pane!.paneId),
		review: inTab.filter((job) => zoneOf(job.role) === "review").map((job) => job.pane!.paneId),
	};
}

/** `blocked` means the agent waits on a human at an approval or question. */
export function isAgentWaiting(status: string): boolean {
	return status === "blocked";
}
