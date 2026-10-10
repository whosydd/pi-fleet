/**
 * Interactive pane mode: the executor runs as a Herdr-managed agent (codex or
 * claude TUI) that a human can watch and talk to.
 *
 * Pure: every function takes already-read values and returns plain strings and
 * objects. No fs, no spawning, no pi imports. `supervise.ts` owns the Herdr
 * invocations, `index.ts` owns the tool wiring.
 *
 * Two facts shape this module.
 *
 * First, herdr reports `idle` and `done` as "ready for input", not "the task
 * finished", and `unknown` proves nothing. So no lifecycle state ever decides
 * success. The contract file decides it, exactly as in detached mode.
 *
 * Second, a pane transcript is unreliable to parse: soft wraps, the TUI's own
 * chrome, and scrollback limits. Live reads returned the prompt box instead of
 * the answer. So the executor writes the contract to a file, and the human reads
 * the pane by eye.
 */

import type { ExecutorKind, JobMeta, PaneTargets, TaskKind } from "./types.ts";

export type PaneMode = "auto" | "on" | "off";

/** herdr's agent lifecycle states, as reported by `agent get`. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** Shapes seen in `herdr workspace list` and `herdr worktree *` JSON. */
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

/**
 * One Herdr workspace entry per worktree path. Matching is by real path:
 * Herdr reports `/private/tmp/...` where the caller passes `/tmp/...`, and
 * macOS resolves one to the other. Entries without a usable id drop out.
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

/**
 * Should this dispatch run interactively? The explicit parameter wins; the
 * setting decides the rest, and `auto` means: only when this pi itself runs
 * inside a Herdr pane (HERDR_ENV=1).
 */
export function resolvePaneMode(explicit: boolean | undefined, setting: PaneMode, herdrEnv: string | undefined): boolean {
	if (explicit !== undefined) return explicit;
	if (setting === "on") return true;
	if (setting === "off") return false;
	return herdrEnv === "1";
}

/**
 * A herdr agent name for one job: `fleet-<ticket>-<nonce>` kept inside herdr's
 * `[a-z][a-z0-9_-]{0,31}` rule. The nonce keeps two dispatches of one ticket
 * (a review while a fix round runs) from colliding on one live name.
 */
export function agentName(ticket: string, nonce: string): string {
	const slug = ticket
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[-_]+/, "")
		.replace(/[-_]+$/, "");
	const body = slug === "" ? "job" : slug;
	const raw = `fleet-${body}-${nonce}`.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
	return /^[a-z]/.test(raw) ? raw : `f${raw}`.slice(0, 32);
}

/** `herdr agent start` argv. Model overrides go after `--`, which the executor parses itself. */
export function agentStartArgv(name: string, kind: ExecutorKind, paneId: string, model?: string, startTimeoutMs = 90_000): string[] {
	const argv = ["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", String(startTimeoutMs)];
	if (model) argv.push("--", kind === "codex" ? "-m" : "--model", model);
	return argv;
}

/** `herdr pane split` argv, for a further job in a tab that already hosts one. */
export function paneSplitArgv(paneId: string, direction: "right" | "down", cwd: string): string[] {
	return ["pane", "split", paneId, "--direction", direction, "--cwd", cwd, "--no-focus"];
}

/** `herdr agent prompt` argv. The task text is one argument; no shell sees it. */
export function agentPromptArgv(name: string, task: string): string[] {
	return ["agent", "prompt", name, task];
}

/** `herdr agent get` argv. */
export function agentGetArgv(name: string): string[] {
	return ["agent", "get", name];
}

/** `herdr agent wait` argv: block until the agent reaches a settled state. */
export function agentWaitArgv(name: string, timeoutMs: number): string[] {
	return ["agent", "wait", name, "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", String(timeoutMs)];
}

/** Split direction for the nth job in one tab: first sibling right, next below. */
export function paneDirection(jobsAlreadyInTab: number): "right" | "down" {
	return jobsAlreadyInTab === 0 ? "right" : "down";
}

/** Which side of a ticket's tab a job runs on: executors left, reviewers right. */
export type PaneZone = "exec" | "review";

/** The zone a task kind belongs to. A fix round is execution work, not a review. */
export function zoneOf(taskKind: TaskKind): PaneZone {
	return taskKind === "review" ? "review" : "exec";
}

/** Where the next job in a ticket's tab goes. */
export type PaneAction =
	| { kind: "newTab" }
	| { kind: "split"; anchor: string; direction: "right" | "down" }
	| { kind: "reuse"; paneId: string };

/** The panes a ticket's tab already holds, by zone, newest last. */
export type TabOccupancy = { exec: string[]; review: string[] };

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
 * A reviewer with no executor to sit beside opens its own tab: a review of
 * work nobody is watching does not deserve a borrowed column.
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

/** When a tab holds this many fleet jobs, open a new tab instead of splitting again. */
export const TAB_FANOUT_LIMIT = 3;

/** A settled state proves only that the agent is ready for input. It never proves the task finished. `blocked` means it waits on a human. */
export function isAgentWaiting(status: string): boolean {
	return status === "blocked";
}

/** Parse a run's exit code text. `signal` (killed without a code) and junk yield undefined. */
export function readExitCodeText(text: string): number | undefined {
	const trimmed = text.trim();
	if (trimmed === "signal") return undefined;
	if (!/^-?\d+$/.test(trimmed)) return undefined;
	return Number(trimmed);
}

/** The `herdr workspace list` entries, or undefined when the output is not that shape. */
export function parseWorkspaceList(stdout: string): WorkspaceEntry[] | undefined {
	const data = parseJson(stdout);
	const workspaces = (data as { result?: { workspaces?: unknown } } | undefined)?.result?.workspaces;
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
	const name = typeof agent.name === "string" ? agent.name : "";
	const ids = (key: string) => (typeof agent[key] === "string" ? (agent[key] as string) : undefined);
	return { status, name, paneId: ids("pane_id"), tabId: ids("tab_id"), workspaceId: ids("workspace_id") };
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Which fleet tabs may close? A tab closes only when every job that used it has
 * settled (nothing running), and only tabs this extension created count. The
 * worktree and its workspace never close here: the human inspects file changes
 * after the run, and closing those is a separate deliberate act.
 */
export function closableTabs(jobs: Pick<JobMeta, "state" | "pane">[]): { tabs: string[]; blocked: string[] } {
	const byTab = new Map<string, { settled: number; running: number }>();
	for (const job of jobs) {
		const tabId = job.pane?.tabId;
		if (!tabId) continue;
		const record = byTab.get(tabId) ?? { settled: 0, running: 0 };
		if (job.state === "running") record.running += 1;
		else record.settled += 1;
		byTab.set(tabId, record);
	}
	const tabs: string[] = [];
	const blocked: string[] = [];
	for (const [tabId, record] of byTab) {
		if (record.running > 0) blocked.push(tabId);
		else tabs.push(tabId);
	}
	return { tabs, blocked };
}
