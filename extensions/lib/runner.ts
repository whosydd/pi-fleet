/**
 * The one module that spawns. Everything it spawns is the Herdr CLI.
 *
 * Three consequences of that choice are visible in the code below.
 *
 * First, no process tracking. Herdr owns the executor's TUI, so a job's
 * liveness is a question for `herdr agent get` rather than a pid table, an exit
 * handler, or a rehydration timer.
 *
 * Second, no timeout bookkeeping. The pane is visible, so a stuck agent is
 * something a human interrupts with Esc; a wall-clock ceiling enforced by pi
 * would be a second, invisible opinion about a process pi does not own.
 *
 * Third, no delivery besides panes. The fallback to a detached one-shot spawn is
 * gone: a commit from a worktree needs the git metadata outside it, which the
 * executor's sandbox cannot write, so an unattended one-shot run could not
 * deliver a ticket anyway. A dispatch without Herdr is an error, not a silent
 * downgrade.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildBrief, buildTask } from "./brief.ts";
import { parseClaudeStdout, schemaFor, validateContract } from "./contract.ts";
import {
	agentGetArgv,
	agentName,
	agentPromptArgv,
	agentStartArgv,
	agentWaitArgv,
	occupancyOf,
	paneSplitArgv,
	parseAgentGet,
	parsePaneSplit,
	parseTabCreate,
	parseWorkspaceList,
	parseWorktreeOpen,
	planPaneAction,
	tabCloseArgv,
	tabCreateArgv,
	tabLabel,
	workspaceForWorktree,
	workspaceListArgv,
	worktreeOpenArgv,
	zoneOf,
	AGENT_START_CALL_MS,
	CALL_MS,
	PROMPT_CALL_MS,
	type AgentRead,
} from "./herdr.ts";
import { listJobs, listStale, newJobId, readContract, readMeta, runPaths, writeMeta, type MetaRead, type StaleRun } from "./jobs.ts";
import { JOB_SCHEMA_VERSION, type ExecutorKind, type FleetRole, type FleetSettings, type JobMeta, type PaneTargets } from "./types.ts";

const execFileAsync = promisify(execFile);

/** The outcome of reading one job: exactly one of these is true of it. */
export type HarvestReport =
	| { kind: "running"; meta: JobMeta; status?: string }
	| { kind: "complete"; meta: JobMeta; contract: unknown }
	| { kind: "contract_failed"; meta: JobMeta; error: string }
	| { kind: "failed"; meta: JobMeta; error: string }
	/** Not a job this release may judge: no such run directory, or an unreadable one. */
	| { kind: "unknown"; id: string; error: string };

export interface DispatchInput {
	/** The ticket's own id, e.g. "03". */
	ticketId: string;
	/** The ticket's title, for the Herdr agent name and the tab label. */
	ticketTitle: string;
	ticketPath: string;
	ticketText: string;
	worktree: string;
	role: FleetRole;
	executor: ExecutorKind;
	base?: string;
	model?: string;
	fixRound: number;
	findings?: string[];
}

export type DispatchOutcome = { ok: true; meta: JobMeta } | { ok: false; error: string };

function nonce(): string {
	return Math.random().toString(36).slice(2, 6);
}

export class Runner {
	readonly settings: FleetSettings;

	constructor(settings: FleetSettings) {
		this.settings = settings;
	}

	/** Every job the disk knows about, oldest first. */
	all(): JobMeta[] {
		return listJobs(this.settings);
	}

	/** Run directories an earlier release wrote, which this one cannot read. */
	stale(): StaleRun[] {
		return listStale(this.settings);
	}

	/** One job, or nothing when the id names no readable record. */
	get(id: string): JobMeta | undefined {
		const read = readMeta(this.settings, id);
		return read.kind === "job" ? read.meta : undefined;
	}

	/**
	 * Resolve an id before acting on it.
	 *
	 * Harvest and cleanup both write to a run directory, so both must be able to
	 * tell "no such job" from "a record this release cannot read". Treating the
	 * second as the first is how a stale record gets a fresh verdict written onto
	 * it.
	 */
	resolve(id: string): MetaRead {
		return readMeta(this.settings, id);
	}

	/**
	 * Write a job's meta back to disk.
	 *
	 * Public because a harvest records its own bookkeeping (the idle clock, the
	 * once-per-job report flag) through it. The disk is the only place job state
	 * lives: nothing about a job is held in this session's memory.
	 */
	persist(meta: JobMeta): void {
		writeMeta(this.settings, meta);
	}

	/**
	 * Build a run directory and put an executor to work in a Herdr pane.
	 *
	 * The caller has already claimed the ticket. On any failure here the caller
	 * releases it: a claimed ticket with no job would be invisible to the next
	 * frontier scan and unbuildable by hand.
	 */
	async dispatch(input: DispatchInput): Promise<DispatchOutcome> {
		if (process.env.HERDR_ENV !== "1") {
			return { ok: false, error: "this session is not running inside Herdr (HERDR_ENV=1), and a fleet job runs only as a Herdr pane. Start pi in a Herdr pane, then dispatch." };
		}
		const workspaceId = await this.#workspaceFor(input.worktree);
		if (!workspaceId) {
			return { ok: false, error: `no Herdr workspace owns ${input.worktree}, and reopening it failed. Create the worktree with \`herdr worktree create\`, then dispatch.` };
		}

		const now = Date.now();
		const id = newJobId(input.ticketId, now, nonce());
		const paths = runPaths(this.settings, id);
const task = buildTask({ ticket: input.ticketId, role: input.role, briefPath: paths.briefPath, resultPath: paths.resultPath, base: input.base, fixRound: input.fixRound });
		const brief = buildBrief({ ticket: input.ticketId, role: input.role, ticketText: input.ticketText, base: input.base, fixRound: input.fixRound, findings: input.findings });

		try {
			mkdirSync(paths.runDir, { recursive: true });
			writeFileSync(paths.schemaPath, `${JSON.stringify(schemaFor(input.role), null, 2)}\n`, "utf8");
			writeFileSync(paths.briefPath, brief, "utf8");
			writeFileSync(paths.taskPath, task, "utf8");
		} catch (error) {
			return { ok: false, error: `cannot prepare the run directory at ${paths.runDir}: ${error instanceof Error ? error.message : String(error)}` };
		}

		const meta: JobMeta = {
			schemaVersion: JOB_SCHEMA_VERSION,
			id,
			ticket: input.ticketId,
			ticketTitle: input.ticketTitle,
			ticketPath: input.ticketPath,
			role: input.role,
			executor: input.executor,
			worktree: input.worktree,
			base: input.base,
			fixRound: input.fixRound,
			model: input.model,
			...paths,
			startedAt: now,
		};

		const placed = await this.#place(meta, workspaceId);
		if (!placed.ok) return { ok: false, error: placed.error };
		meta.pane = placed.pane;
		const sent = await this.#call(agentPromptArgv(placed.agentName, task), PROMPT_CALL_MS);
		if (!sent.ok) {
			// The agent is up but never got the task. Close what this job opened, so no
			// half-started executor sits idle in the human's tab.
			if (placed.createdTab) await this.#call(tabCloseArgv(placed.pane.tabId), CALL_MS);
			return { ok: false, error: sent.error };
		}

		writeMeta(this.settings, meta);
		return { ok: true, meta };
	}

	/**
	 * Find a pane for this job in the ticket's tab, and start or reuse the agent
	 * in it.
	 *
	 * Placement is a pure decision (`planPaneAction`); this method only carries it
	 * out. The one wrinkle is a reused review pane: it already holds the reviewer
	 * from an earlier round, and that standing agent is re-prompted rather than
	 * replaced, so a re-review reads where the first one did.
	 */
	async #place(meta: JobMeta, workspaceId: string): Promise<{ ok: true; pane: PaneTargets; agentName: string; createdTab: boolean } | { ok: false; error: string }> {
		const label = tabLabel(meta.ticket, meta.ticketTitle ?? "");
		const jobs = this.all();
		const openTabId = jobs
			.filter((job) => job.ticket === meta.ticket && job.pane?.workspaceId === workspaceId && job.paneClosedAt === undefined)
			.at(-1)?.pane?.tabId;
		const action = planPaneAction(zoneOf(meta.role), openTabId ? occupancyOf(jobs, openTabId) : { exec: [], review: [] });

		let tabId: string;
		let paneId: string;
		let createdTab = false;
		let existingAgent: string | undefined;

		if (action.kind === "newTab" || !openTabId) {
			const created = await this.#call(tabCreateArgv(workspaceId, label, meta.worktree), CALL_MS);
			if (!created.ok) return { ok: false, error: created.error };
			const tab = parseTabCreate(created.stdout);
			if (!tab) return { ok: false, error: "herdr tab create returned no tab or pane id" };
			tabId = tab.tabId;
			paneId = tab.paneId;
			createdTab = true;
		} else if (action.kind === "reuse") {
			tabId = openTabId;
			paneId = action.paneId;
			existingAgent = jobs.find((job) => job.pane?.paneId === action.paneId && job.paneClosedAt === undefined && job.pane?.agentName)?.pane?.agentName;
		} else {
			const split = await this.#call(paneSplitArgv(action.anchor, action.direction, meta.worktree), CALL_MS);
			if (!split.ok) {
				// The tab may have been closed by hand. A fresh tab is always valid.
				const created = await this.#call(tabCreateArgv(workspaceId, label, meta.worktree), CALL_MS);
				if (!created.ok) return { ok: false, error: created.error };
				const tab = parseTabCreate(created.stdout);
				if (!tab) return { ok: false, error: "herdr tab create returned no tab or pane id" };
				tabId = tab.tabId;
				paneId = tab.paneId;
				createdTab = true;
			} else {
				paneId = parsePaneSplit(split.stdout) ?? "";
				if (!paneId) return { ok: false, error: "herdr pane split returned no pane id" };
				tabId = openTabId;
			}
		}

		const name = existingAgent ?? agentName(meta.role, meta.ticket, meta.ticketTitle ?? "");
		if (!existingAgent) {
			const started = await this.#call(agentStartArgv(name, meta.executor, paneId, meta.model), AGENT_START_CALL_MS);
			if (!started.ok) {
				// An idle shell with no executor in it is litter, but only when this job
				// opened the tab: closing a tab that hosted other jobs kills their panes.
				if (createdTab) await this.#call(tabCloseArgv(tabId), CALL_MS);
				return { ok: false, error: started.error };
			}
		}
		return { ok: true, pane: { workspaceId, tabId, paneId, agentName: name }, agentName: name, createdTab };
	}

	/**
	 * Read a job from what the executor and Herdr actually left behind.
	 *
	 * The contract file is the only success signal. `idle` and `done` mean the
	 * agent is ready for input, which a live run was seen to be in the middle of a
	 * task, so neither settles a job. Only idleness that persists without a
	 * contract does, and then as a failure.
	 */
	async harvest(id: string): Promise<HarvestReport> {
		const resolved = this.resolve(id);
		if (resolved.kind === "absent") {
			return { kind: "unknown", id, error: `no run directory named "${id}" under ${this.settings.runsDir}` };
		}
		if (resolved.kind === "stale") {
			return { kind: "unknown", id, error: `"${id}" is not a job this release can read: ${resolved.reason}. Remove it from ${this.settings.runsDir} and dispatch its ticket again.` };
		}
		const meta = resolved.meta;

		// A job already settled keeps the verdict it settled with. Re-harvesting must
		// not go looking for a file the executor never wrote and invent a second,
		// different complaint.
		if (meta.contractOk === false && meta.contractError !== undefined) {
			return { kind: "contract_failed", meta, error: meta.contractError };
		}
		if (meta.contractOk === true) {
			const contract = readContract(meta);
			return contract === undefined ? { kind: "failed", meta, error: `result.json became unreadable after ${id} passed its contract` } : { kind: "complete", meta, contract };
		}

		if (existsSync(meta.resultPath)) return this.#judge(meta);

		const read = meta.pane?.agentName ? await this.#agent(meta.pane.agentName) : undefined;
		if (!read) {
			meta.contractError = `the agent (${meta.pane?.agentName ?? "unknown"}) is gone and wrote no contract: it exited, the tab was closed, or Herdr is unreachable. Read pane ${meta.pane?.paneId ?? "?"} by eye if it is still open.`;
			this.#settle(meta, false);
			return { kind: "failed", meta, error: meta.contractError };
		}
		meta.agentStatus = read.status;

		if (read.status === "idle" || read.status === "done") {
			meta.idleSince ??= Date.now();
			if (Date.now() - meta.idleSince >= this.settings.idleGraceMs) {
				meta.contractError = `the agent has been ${read.status} for ${Math.round((Date.now() - meta.idleSince) / 1000)}s without writing the contract: it answered in prose, or the task never reached it. Read pane ${meta.pane?.paneId ?? "?"} and re-brief.`;
				this.#settle(meta, false);
				return { kind: "contract_failed", meta, error: meta.contractError };
			}
			writeMeta(this.settings, meta);
			return { kind: "running", meta, status: read.status };
		}
		// working, blocked, unknown: still going. A blocked agent waits on a human,
		// and the harvest text says so. Work resuming clears the idle clock, so a
		// long job that paused once does not drift toward failure.
		if (meta.idleSince !== undefined) meta.idleSince = undefined;
		writeMeta(this.settings, meta);
		return { kind: "running", meta, status: read.status };
	}

	/** Judge a contract that exists. One-shot claude keeps it in its stdout envelope. */
	#judge(meta: JobMeta): HarvestReport {
		let contract: unknown;
		if (meta.executor === "claude") {
			const parsed = parseClaudeStdout(readText(meta.runDir, "stdout.log"));
			contract = parsed.structured ?? readContract(meta);
			if (contract === undefined) {
				const error = parsed.error ?? "claude wrote no structured_output and no result file";
				this.#settle(meta, false, error);
				return { kind: "contract_failed", meta, error };
			}
		} else {
			contract = readContract(meta);
			if (contract === undefined) {
				const error = "result.json exists but is not readable JSON";
				this.#settle(meta, false, error);
				return { kind: "contract_failed", meta, error };
			}
		}
		const check = validateContract(meta.role, contract, meta.ticket);
		if (!check.ok) {
			const error = check.error ?? "contract invalid";
			this.#settle(meta, false, error);
			return { kind: "contract_failed", meta, error };
		}
		this.#settle(meta, true);
		return { kind: "complete", meta, contract };
	}

	/** Record a verdict on disk. The next session reads it; nothing is held in memory. */
	#settle(meta: JobMeta, ok: boolean, error?: string): void {
		meta.contractOk = ok;
		if (error !== undefined) meta.contractError = error;
		writeMeta(this.settings, meta);
	}

	/**
	 * Close one ticket's fleet tab, once its jobs have settled.
	 *
	 * Only tabs this package created are ever closed, and never while a job is
	 * unsettled: the pane is where the human reads the executor's output and
	 * checks the file changes. A tab Herdr no longer has needs no closing, so
	 * `tab_not_found` is a success.
	 */
	async closeTab(id: string): Promise<{ ok: boolean; error?: string; alreadyClosed?: boolean }> {
		const resolved = this.resolve(id);
		if (resolved.kind === "absent") return { ok: false, error: `no run directory named "${id}" under ${this.settings.runsDir}` };
		if (resolved.kind === "stale") return { ok: false, error: `"${id}" is not a job this release can read: ${resolved.reason}` };
		const meta = resolved.meta;
		if (!meta.pane) return { ok: false, error: `job ${id} did not run in a Herdr pane` };
		if (meta.contractOk === undefined) return { ok: false, error: `job ${id} is not settled; harvest it before closing its tab` };
		if (meta.paneClosedAt !== undefined) return { ok: true, alreadyClosed: true };

		const tabId = meta.pane.tabId;
		const closed = await this.#call(tabCloseArgv(tabId), CALL_MS);
		if (!closed.ok && !/tab_not_found/.test(closed.error)) return { ok: false, error: closed.error };

		// One tab holds every job of a ticket, so all of them lose it at once.
		const at = Date.now();
		for (const job of this.all()) {
			if (job.pane?.tabId !== tabId || job.paneClosedAt !== undefined) continue;
			job.paneClosedAt = at;
			writeMeta(this.settings, job);
		}
		return { ok: true };
	}

	/** Ping a human through Herdr. Failures are silent: a missing channel must not disturb a dispatch. */
	async notify(title: string, body: string): Promise<boolean> {
		return (await this.#call(["notification", "show", title, "--body", body, "--sound", "done"], CALL_MS)).ok;
	}

	/**
	 * Wait for one executor to change lifecycle state, and report what Herdr saw.
	 *
	 * A state signal is not a verdict: `idle` and `done` mean ready for input, so
	 * the caller harvests after every wake-up and the contract file still decides
	 * whether the work landed. Returns undefined when Herdr no longer knows the
	 * name, which the caller's harvest reports as a failure.
	 *
	 * pi's patience outlasts Herdr's own timeout on purpose: a shorter execFile
	 * deadline would kill a wait that was still valid.
	 */
	async waitAgent(name: string, timeoutMs: number): Promise<AgentRead | undefined> {
		const waited = await this.#call(agentWaitArgv(name, timeoutMs), timeoutMs + 30_000);
		return waited.ok ? parseAgentGet(waited.stdout) : undefined;
	}

	/** The agent's reported lifecycle state, or undefined when Herdr no longer knows the name. */
	async #agent(name: string): Promise<AgentRead | undefined> {
		const read = await this.#call(agentGetArgv(name), CALL_MS);
		return read.ok ? parseAgentGet(read.stdout) : undefined;
	}

	/**
	 * The workspace that hosts this worktree.
	 *
	 * A worktree's workspace is not permanent: Herdr closes it when its last tab
	 * closes, and cleanup closes exactly that tab at the end of a run. So a match
	 * miss is not an error yet — `worktree open` restores the workspace and is
	 * idempotent, and only its failure means this path cannot host a job.
	 *
	 * There is deliberately no fallback to this session's own workspace. That
	 * fallback would put the executor's pane in the orchestrator's column, which
	 * is not the delivery this package promises: a pane exists so a human reads
	 * the work beside the ticket, not inside their own session.
	 */
	async #workspaceFor(worktree: string): Promise<string | undefined> {
		const listed = await this.#call(workspaceListArgv(), CALL_MS);
		if (listed.ok) {
			const entries = parseWorkspaceList(listed.stdout);
			const match = entries ? workspaceForWorktree(entries, worktree) : undefined;
			if (match) return match;
		}
		const opened = await this.#call(worktreeOpenArgv(worktree), CALL_MS);
		return opened.ok ? parseWorktreeOpen(opened.stdout) : undefined;
	}

	/**
	 * One Herdr CLI call. Any failure comes back as a message, never a throw.
	 *
	 * Herdr reports its own failures as JSON and exits non-zero, so the child's
	 * output carries the reason ("tab_not_found", a usage error) that the
	 * exception message alone does not: without it a cleanup failure reads as
	 * "Command failed" with nothing to act on.
	 */
	async #call(args: string[], timeoutMs: number): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
		try {
			const { stdout } = await execFileAsync(this.settings.herdrBin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
			return { ok: true, stdout };
		} catch (error) {
			const failure = error as { message?: string; stdout?: string; stderr?: string };
			const detail = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim().replace(/\s+/g, " ");
			return { ok: false, error: `${this.settings.herdrBin} ${args.join(" ")} failed: ${failure.message ?? String(error)}${detail ? ` | ${detail.slice(0, 300)}` : ""}` };
		}
	}
}

function readText(dir: string, name: string): string {
	try {
		return readFileSync(join(dir, name), "utf8");
	} catch {
		return "";
	}
}
