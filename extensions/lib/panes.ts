/**
 * Pane mode: run the executor inside a Herdr pane so a human can watch it.
 *
 * Pure: every function takes already-read values and returns plain strings and
 * objects. No fs, no spawning, no pi imports. `supervise.ts` owns the Herdr
 * invocations, `index.ts` owns the tool wiring.
 *
 * The pane's login shell is whatever the user runs (fish on this machine), so
 * the only command text ever sent to a pane is one short, shell-neutral call:
 * `bash <run.sh>`. Everything else — the executor argv, output shaping, exit
 * code, stdin — lives in the script file, which has its own bash shebang.
 */

import type { JobMeta } from "./types.ts";

export type PaneMode = "auto" | "on" | "off";

export interface PaneTargets {
	workspaceId: string;
	tabId: string;
	paneId: string;
	label: string;
}

/** Shapes seen in `herdr workspace list` and `herdr worktree *` JSON. */
export interface WorkspaceEntry {
	workspace_id?: string;
	cwd?: string;
	label?: string;
	worktree?: { checkout_path?: string; repo_root?: string } | null;
}

/**
 * One Herdr workspace entry per worktree path. Matching is by real path:
 * Herdr reports `/private/tmp/...` where the caller passes `/tmp/...`, and
 * macOS resolves one to the other. Entries without a usable id drop out.
 */
export function workspaceForWorktree(entries: WorkspaceEntry[], worktree: string): string | undefined {
	let wanted: string;
	try {
		// realpath is fs, but a pure string pass keeps this testable: callers
		// pass already-normalised paths and the wiring normalises once.
		wanted = normalisePath(worktree);
	} catch {
		return undefined;
	}
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
 * Should this dispatch run in a pane? The explicit parameter wins; the
 * setting decides the rest, and `auto` means: only when this pi itself runs
 * inside a Herdr pane (HERDR_ENV=1).
 */
export function resolvePaneMode(explicit: boolean | undefined, setting: PaneMode, herdrEnv: string | undefined): boolean {
	if (explicit !== undefined) return explicit;
	if (setting === "on") return true;
	if (setting === "off") return false;
	return herdrEnv === "1";
}

/** POSIX single-quote escaping: close, escaped quote, reopen. Every shell agrees. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** A quoted path under the run dir. */
function file(runDir: string, name: string): string {
	return shellQuote(`${runDir}/${name}`);
}

/** The exact command text sent to a pane. One short call; nothing else. */
export function paneRunCommand(runScriptPath: string): string {
	return `bash ${shellQuote(runScriptPath)}`;
}

export interface RunScriptInput {
	worktree: string;
	command: string[];
	runDir: string;
	/** When set, the pane announces the finished run through Herdr. */
	notify?: NotifyRequest;
}

/**
 * A completion ping. The wording states the exit code and names the harvest as
 * the thing that judges success: a finished executor is not a passed contract.
 */
export interface NotifyRequest {
	herdrBin: string;
	title: string;
}

/** The `exit_code` line, the notification line, and the script's own status. */
function closingLines(input: RunScriptInput): string[] {
	const lines = [`echo "$ec" > ${file(input.runDir, "exit_code")}`];
	if (input.notify) {
		// The ping states the exit code and points at the harvest: a finished
		// executor is not a passed contract. `|| true` keeps a notification
		// failure from changing the run's own status.
		const body = `"finished with exit code $ec \u2014 harvest to judge the contract"`;
		lines.push(`${shellQuote(input.notify.herdrBin)} notification show ${shellQuote(input.notify.title)} --body ${body} --sound done >/dev/null 2>&1 || true`);
	}
	lines.push(`exit "$ec"`);
	return lines;
}

/**
 * The script a pane runs. bash regardless of the pane's login shell, so the
 * exit code and output shaping are ours, not fish's.
 *
 * stdin is /dev/null: codex exec reads stdin when it is a pipe, and a live
 * pane TTY must never look like input. stdout and stderr each tee to a file
 * and the pane, so the human watches live output and the harvest still reads
 * exact bytes (claude's stdout.log must stay pure JSON, so the streams never
 * merge). exit_code is written after the command ends; the pid file records
 * the script's own bash pid for cross-session liveness checks.
 */
export function runScript(input: RunScriptInput): string {
	const [bin, ...args] = input.command;
	const quoted = [bin, ...args].map(shellQuote).join(" ");
	return [
		"#!/usr/bin/env bash",
		"set -u",
		`cd ${shellQuote(input.worktree)} || { echo 127 > ${file(input.runDir, "exit_code")}; exit 127; }`,
		`echo $$ > ${file(input.runDir, "pid")}`,
		`${quoted} </dev/null > >(tee ${file(input.runDir, "stdout.log")}) 2> >(tee ${file(input.runDir, "stderr.log")} >&2)`,
		"ec=$?",
		...closingLines(input),
		"",
	].join("\n");
}

/** Parse the script's pid file text. Empty, partial, or junk yields undefined. */
export function readPidFromText(text: string): number | undefined {
	const trimmed = text.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	return Number(trimmed);
}

/** Parse the run's exit code file. `signal` (killed without a code) and junk yield undefined. */
export function readExitCodeText(text: string): number | undefined {
	const trimmed = text.trim();
	if (trimmed === "signal") return undefined;
	if (!/^-?\d+$/.test(trimmed)) return undefined;
	return Number(trimmed);
}

/** The `herdr workspace list` entries, or undefined when the output is not that shape. */
export function parseWorkspaceList(stdout: string): WorkspaceEntry[] | undefined {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	const workspaces = (data as { result?: { workspaces?: unknown } }).result?.workspaces;
	return Array.isArray(workspaces) ? (workspaces as WorkspaceEntry[]) : undefined;
}

/** The tab and pane ids a `herdr tab create` response reported, or undefined. */
export function parseTabCreate(stdout: string): { tabId: string; paneId: string } | undefined {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	const result = (data as { result?: { tab?: { tab_id?: string }; root_pane?: { pane_id?: string } } }).result;
	const tabId = result?.tab?.tab_id;
	const paneId = result?.root_pane?.pane_id;
	if (typeof tabId !== "string" || tabId === "" || typeof paneId !== "string" || paneId === "") return undefined;
	return { tabId, paneId };
}

/**
 * Which fleet tabs may close? A tab closes only when every job that used it
 * has settled (nothing running), and only tabs this extension created count.
 * The worktree and its workspace never close here: the human inspects file
 * changes after the run, and closing those is a separate deliberate act.
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
