/**
 * Process supervision for one-shot executor runs.
 *
 * The executor is a real OS process that outlives the pi session on purpose:
 * dispatch-and-forget is the documented semantic, and harvest happens on a
 * later turn (often a later session). The disk is the source of truth — every
 * job writes meta.json and logs under the run dir, and a fresh session
 * rehydrates from disk instead of assuming.
 *
 * Exit detection without holding the child: the in-memory ChildProcess handle
 * fires for the common case (same session), and `refresh` cross-checks pid
 * liveness for jobs inherited from a previous session.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { claudeFailureNote, parseClaudeStdout, validateContract } from "./contract.ts";
import {
	agentGetArgv,
	agentName,
	agentPromptArgv,
	agentStartArgv,
	agentWaitArgv,
	paneSplitArgv,
	parseAgentGet,
	parsePaneSplit,
	parseTabCreate,
	parseWorkspaceList,
	planPaneAction,
	readExitCodeText,
	workspaceForWorktree,
	zoneOf,
	type AgentRead,
	type TabOccupancy,
	type PaneZone,
	type WorkspaceEntry,
} from "./panes.ts";
import { buildAgentPrompt, schemaFor } from "./profiles.ts";
import type { FleetSettings, JobMeta } from "./types.ts";

const execFileAsync = promisify(execFile);

/** Headroom over the agent's own startup wait, so pi never kills herdr mid-wait. */
const START_GRACE_MS = 20_000;
/** Headroom for a prompt submit, which only writes into an existing pane. */
const PROMPT_GRACE_MS = 10_000;

export type HarvestOutcome =
	| { kind: "running" }
	| { kind: "complete"; meta: JobMeta }
	| { kind: "contract_failed"; meta: JobMeta; error: string }
	| { kind: "failed"; meta: JobMeta; error: string };

export interface HarvestReport {
	outcome: HarvestOutcome;
}

/** The nonce a job id ends with, reused as the agent-name suffix. */function nonceOf(id: string): string {
	const tail = id.split("_").at(-1) ?? "";
	return tail.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

function readIfExists(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export class Supervisor {
	readonly settings: FleetSettings;
	#jobs = new Map<string, JobMeta>();
	#children = new Map<string, ChildProcess>();
	#timers = new Map<string, NodeJS.Timeout>();

	constructor(settings: FleetSettings) {
		this.settings = settings;
	}

	all(): JobMeta[] {
		return [...this.#jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
	}

	get(id: string): JobMeta | undefined {
		return this.#jobs.get(id);
	}

	runningCount(): number {
		return [...this.#jobs.values()].filter((job) => job.state === "running").length;
	}

	/**
	 * Spawn the executor detached from the tool result. Writes brief.md,
	 * schema.json, and meta.json first so a crashed pi still leaves a
	 * reconstructable run dir behind.
	 */
	async dispatch(
		plan: {
			id: string;
			ticket: string;
			worktree: string;
			executor: JobMeta["executor"];
			taskKind: JobMeta["taskKind"];
			model?: string;
			fixRound: number;
			base?: string;
			skillPointer?: string;
			timeoutMs: number;
			command: string[];
			prompt: string;
			/** The one-shot prompt text; the interactive form builds its own from the brief. */
			brief?: string;
			paths: JobMeta["paths"];
			now: number;
			pane: boolean;
		},
		brief: string,
		gate?: JobMeta["gate"],
		onSettled?: (meta: JobMeta) => void,
	): Promise<JobMeta> {
		// File prep can fail on a read-only state dir; surface a named error
		// instead of a raw fs exception through the tool boundary.
		try {
			for (const dir of [this.settings.stateDir, dirname(plan.paths.metaPath)]) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(plan.paths.promptPath, brief, "utf8");
			writeFileSync(plan.paths.schemaPath, JSON.stringify(schemaFor(plan.taskKind), null, 2), "utf8");
			// File prep: the brief and the schema are what both forms read. The
			// interactive form also sees them through its prompt.
			writeFileSync(plan.paths.promptPath, brief, "utf8");
			writeFileSync(plan.paths.schemaPath, JSON.stringify(schemaFor(plan.taskKind), null, 2), "utf8");
		} catch (error) {
			throw new Error(
				`cannot prepare the run dir under ${this.settings.stateDir}: ${error instanceof Error ? error.message : String(error)}. Check PI_FLEET_STATE_DIR is writable.`,
			);
		}

		const meta: JobMeta = {
			id: plan.id,
			ticket: plan.ticket,
			worktree: plan.worktree,
			executor: plan.executor,
			taskKind: plan.taskKind,
			model: plan.model,
			fixRound: plan.fixRound,
			base: plan.base,
			skillPointer: plan.skillPointer,
			command: plan.command,
			paths: plan.paths,
			startedAt: plan.now,
			timeoutMs: plan.timeoutMs,
			state: "running",
			briefChars: brief.length,
			runner: plan.pane ? "agent" : "spawn",
			...(gate ? { gate } : {}),
		};

		if (plan.pane) {
			const started = await this.#startInteractive(plan, meta);
			if (started.ok) {
				this.#register(meta);
				if (onSettled) this.#watchAgent(meta, onSettled);
				return meta;
			}
			// Interactivity degrades to a note, never a blocked dispatch: the pane
			// channel failed, so run the job the way it ran before Herdr existed.
			meta.paneFallback = started.error;
			meta.runner = "spawn";
		}

		this.#startSpawned(plan, meta, onSettled);
		this.#register(meta);
		return meta;
	}

	#register(meta: JobMeta): void {
		this.#jobs.set(meta.id, meta);
		this.persist(meta);
		if (meta.state === "running") {
			this.#timers.set(
				meta.id,
				setTimeout(() => this.timeout(meta.id), meta.timeoutMs).unref(),
			);
		}
	}

	/**
	 * Start the job as an interactive Herdr agent: the executor's own TUI in a pane,
	 * the brief delivered as a prompt, and a human who can watch and type.
	 *
	 * Topology: one tab per ticket, one pane per job. The first job takes a fresh
	 * tab's shell, later jobs split that tab, and past `TAB_FANOUT_LIMIT` jobs a new
	 * tab opens so a busy ticket never piles ten panes into one screen.
	 */
	async #startInteractive(plan: Parameters<Supervisor["dispatch"]>[0], meta: JobMeta): Promise<{ ok: true } | { ok: false; error: string }> {
		const workspaceId = await this.#workspaceFor(plan.worktree);
		if (!workspaceId) {
			return { ok: false, error: `no Herdr workspace owns ${plan.worktree}, and this session carries no HERDR_WORKSPACE_ID to fall back on` };
		}
		const label = `fleet: ${plan.ticket}`;
		const where = await this.#jobPane(plan.worktree, workspaceId, label, zoneOf(plan.taskKind));
		if (!where.ok) return { ok: false, error: where.error };
		// A reused pane already holds an agent: the ticket's reviewer, kept alive
		// across fix rounds so the re-review reads in the same place. It gets the new
		// task by prompt, not a second agent in the same pane.
		const name = where.existingAgent ?? agentName(plan.ticket, nonceOf(plan.id));
		if (!where.existingAgent) {
			const started = await this.#herdr(agentStartArgv(name, plan.executor, where.paneId, plan.model), START_GRACE_MS + this.settings.agentStartMs);
			if (!started.ok) {
				// No agent came up. If this job opened the tab, close it: an idle shell
				// with no executor in it is litter. A tab that already hosted other jobs
				// is left alone, because closing it would kill their panes too.
				if (where.createdTab) void this.#herdr(["tab", "close", where.tabId]);
				return { ok: false, error: started.error };
			}
		}
		const task = buildAgentPrompt(
			{ ticket: plan.ticket, worktree: plan.worktree, executor: plan.executor, taskKind: plan.taskKind, brief: plan.brief ?? plan.prompt, base: plan.base, skillPointer: plan.skillPointer, model: plan.model, fixRound: plan.fixRound },
			plan.paths.promptPath,
			plan.paths.resultPath,
		);
		const sent = await this.#herdr(agentPromptArgv(name, task), PROMPT_GRACE_MS + this.settings.agentStartMs);
		if (!sent.ok) {
			// The agent is up but never got the task. Close what we opened so no
			// half-started executor sits idle in the user's tab.
			if (where.createdTab) void this.#herdr(["tab", "close", where.tabId]);
			return { ok: false, error: sent.error };
		}
		meta.pane = { workspaceId, tabId: where.tabId, paneId: where.paneId, label };
		meta.agentName = name;
		return { ok: true };
	}

	/** The pane this job should run in: reuse the ticket tab, or open a new one. */
	async #jobPane(worktree: string, workspaceId: string, label: string, zone: PaneZone): Promise<{ ok: true; tabId: string; paneId: string; createdTab: boolean; existingAgent?: string } | { ok: false; error: string }> {
		const open = [...this.#jobs.values()].filter((job) => job.pane?.workspaceId === workspaceId && job.pane.label === label && job.paneClosedAt === undefined);
		const tabId = open.at(-1)?.pane?.tabId;
		const inTab = tabId ? open.filter((job) => job.pane?.tabId === tabId) : [];
		const occupancy: TabOccupancy = {
			exec: inTab.filter((job) => zoneOf(job.taskKind) === "exec").map((job) => job.pane!.paneId),
			review: inTab.filter((job) => zoneOf(job.taskKind) === "review").map((job) => job.pane!.paneId),
		};
		const action = planPaneAction(zone, occupancy);
		if (action.kind === "reuse") {
			// The ticket's review pane persists across fix rounds, so the re-review
			// reads in the same place the first review did.
			const holder = inTab.find((job) => job.pane!.paneId === action.paneId && job.agentName);
			return { ok: true, tabId: tabId!, paneId: action.paneId, createdTab: false, existingAgent: holder?.agentName };
		}
		if (action.kind === "newTab") {
			const fresh = await this.#newTab(worktree, workspaceId, label);
			return fresh.ok ? { ...fresh, createdTab: true } : fresh;
		}
		const split = await this.#herdr(paneSplitArgv(action.anchor, action.direction, worktree));
		if (!split.ok) {
			// The tab may be gone (closed by hand). A fresh tab is always valid.
			const fresh = await this.#newTab(worktree, workspaceId, label);
			return fresh.ok ? { ...fresh, createdTab: true } : fresh;
		}
		const paneId = parsePaneSplit(split.stdout);
		if (!paneId) return { ok: false, error: "herdr pane split returned no pane id" };
		return { ok: true, tabId: tabId!, paneId, createdTab: false };
	}

	async #newTab(worktree: string, workspaceId: string, label: string): Promise<{ ok: true; tabId: string; paneId: string } | { ok: false; error: string }> {
		const created = await this.#herdr(["tab", "create", "--workspace", workspaceId, "--label", label, "--cwd", worktree, "--no-focus"]);
		if (!created.ok) return { ok: false, error: created.error };
		const tab = parseTabCreate(created.stdout);
		if (!tab) return { ok: false, error: "herdr tab create returned no tab or pane id" };
		return { ok: true, tabId: tab.tabId, paneId: tab.paneId };
	}

	/**
	 * Watch the agent in the background and ping when it settles. This watcher is
	 * advisory: if pi is gone it dies with the session, and the harvest still
	 * settles the job from the contract file.
	 */
	#watchAgent(meta: JobMeta, onSettled?: (meta: JobMeta) => void): void {
		if (!meta.agentName) return;
		try {
			const waiter = spawn(this.settings.herdrBin, agentWaitArgv(meta.agentName, meta.timeoutMs), { detached: true, stdio: "ignore" });
			waiter.unref();
			waiter.once("exit", () => onSettled?.(meta));
			waiter.once("error", () => undefined);
		} catch {
			// No watcher, no ping. Never a failed dispatch.
		}
	}

	/** The workspace whose worktree is this path, else this session's own. */
	async #workspaceFor(worktree: string): Promise<string | undefined> {
		const listed = await this.#herdr(["workspace", "list"]);
		if (listed.ok) {
			const entries = parseWorkspaceList(listed.stdout);
			const match = entries ? workspaceForWorktree(entries, worktree) : undefined;
			if (match) return match;
		}
		const inherited = process.env.HERDR_WORKSPACE_ID?.trim();
		return inherited === "" ? undefined : inherited;
	}

	/** The agent's reported lifecycle state, or undefined when herdr no longer knows the name. */
	async #agentStatus(name: string): Promise<AgentRead | undefined> {
		const read = await this.#herdr(agentGetArgv(name));
		if (!read.ok) return undefined;
		return parseAgentGet(read.stdout);
	}

	/**
	 * One herdr CLI call. Any failure comes back as a message, never a throw.
	 *
	 * `timeoutMs` is per call because the calls are not alike: a list returns in
	 * milliseconds, while `agent start` waits for the executor's TUI to come up and
	 * must outlive that wait. Killing the CLI mid-wait is what previously read as
	 * `agent_not_ready`.
	 */
	async #herdr(args: string[], timeoutMs = 15_000): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
		try {
			const { stdout } = await execFileAsync(this.settings.herdrBin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
			return { ok: true, stdout };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: `${this.settings.herdrBin} ${args.join(" ")} failed: ${message}` };
		}
	}

	/**
	 * Start the job as pi's own detached child: the executor survives pi, the
	 * disk records the evidence, and no pane is involved.
	 */
	#startSpawned(plan: Parameters<Supervisor["dispatch"]>[0], meta: JobMeta, onSettled?: (meta: JobMeta) => void): void {
		const stdout = openSync(plan.paths.stdoutPath, "w");
		const stderr = openSync(plan.paths.stderrPath, "w");
		try {
			const [bin, ...args] = plan.command;
			const child = spawn(bin, args, {
				cwd: plan.worktree,
				// Own process group: the executor survives a crashed or closed pi,
				// which is the documented semantic (dispatch-and-forget; harvest on
				// a later turn, often a later session).
				detached: true,
				stdio: ["ignore", stdout, stderr],
			});
			child.unref();
			closeSync(stdout);
			closeSync(stderr);
			meta.pid = child.pid;
			this.#children.set(plan.id, child);
			child.once("exit", (code) => {
				this.#children.delete(plan.id);
				meta.exitCode = code;
				// Harvest-time contract validation decides `complete` vs
				// `contract_failed`; a bare exit event only marks the process done.
				if (meta.state === "running") meta.state = code === 0 ? "complete" : "failed";
				meta.finishedAt = Date.now();
				// Same evidence a pane script writes: a later session settles from
				// disk instead of guessing whether a dead pid meant success.
				this.#writeExitCode(meta, code);
				this.persist(meta);
				onSettled?.(meta);
			});
			child.once("error", (error) => {
				this.#children.delete(plan.id);
				meta.state = "failed";
				meta.contractError = `spawn failed: ${error.message}`;
				meta.finishedAt = Date.now();
				this.persist(meta);
			});
		} catch (error) {
			closeSync(stdout);
			closeSync(stderr);
			meta.state = "failed";
			meta.contractError = `spawn failed: ${error instanceof Error ? error.message : String(error)}`;
			meta.finishedAt = Date.now();
		}
	}

	#writeExitCode(meta: JobMeta, code: number | null): void {
		try {
			writeFileSync(meta.paths.exitCodePath, `${code ?? "signal"}\n`, "utf8");
		} catch {
			// The dir vanished with the run; the in-memory state still reports itself.
		}
	}

	/** Kill a running job; SIGTERM first, SIGKILL after a short grace period. */
	stop(id: string, graceMs = 5000): boolean {
		const meta = this.#jobs.get(id);
		const child = this.#children.get(id);
		// A pane job has no child of ours to signal: stop it by Ctrl-C in the pane
		// or by closing the tab (closeTab), which takes the shell and its child.
		if (!meta || !child) return false;
		const timer = this.#timers.get(id);
		if (timer) clearTimeout(timer);
		this.#timers.delete(id);
		child.kill("SIGTERM");
		setTimeout(() => {
			if (this.#children.has(id)) child.kill("SIGKILL");
		}, graceMs).unref();
		return true;
	}

	timeout(id: string): void {
		const meta = this.#jobs.get(id);
		if (!meta || meta.state !== "running") return;
		this.stop(id);
		meta.state = "timeout";
		meta.finishedAt = Date.now();
		this.persist(meta);
	}

	/**
	 * Ping a human through Herdr. Failures are silent by design: a notification
	 * channel that is missing or out of reach must never disturb a dispatch or a
	 * harvest, and no caller waits on the result.
	 */
	async notify(title: string, body: string): Promise<boolean> {
		const sent = await this.#herdr(["notification", "show", title, "--body", body, "--sound", "done"]);
		return sent.ok;
	}

	/** Tabs this session still owes the user: fleet panes nobody cleaned yet. */
	listOpenTabs(): string[] {
		const tabs = new Set<string>();
		for (const meta of this.#jobs.values()) {
			if (meta.pane && meta.paneClosedAt === undefined) tabs.add(meta.pane.tabId);
		}
		return [...tabs];
	}

	/**
	 * Close one job's fleet tab after it settled. Only tabs this extension
	 * created are ever closed, and never while the job still runs: the pane is
	 * where the human reads the executor's output and checks file changes.
	 */
	async closeTab(id: string): Promise<{ ok: boolean; error?: string; alreadyClosed?: boolean }> {
		const meta = this.#jobs.get(id);
		if (!meta) return { ok: false, error: `unknown job "${id}"` };
		if (!meta.pane) return { ok: false, error: "job did not run in a Herdr pane" };
		if (meta.state === "running") return { ok: false, error: `job ${id} is still running in pane ${meta.pane.tabId}; harvest it first` };
		if (meta.paneClosedAt !== undefined) return { ok: true, alreadyClosed: true };
		const closed = await this.#herdr(["tab", "close", meta.pane.tabId]);
		if (!closed.ok) return { ok: false, error: closed.error };
		meta.paneClosedAt = Date.now();
		this.persist(meta);
		return { ok: true };
	}

	/**
	 * Re-read a job from what the process and executor actually left on disk.
	 * Resolves inherited jobs (pid dead, state still "running") and validates
	 * the contract for finished ones.
	 */
	async refresh(id: string): Promise<HarvestReport> {
		const meta = this.#jobs.get(id);
		if (!meta) {
			return {
				outcome: { kind: "failed", meta: { id, state: "failed", startedAt: 0, timeoutMs: 0 } as JobMeta, error: `unknown job "${id}"` },
			};
		}
		if (meta.state === "running") {
			const child = this.#children.get(id);
			const expired = Date.now() - meta.startedAt > meta.timeoutMs;
			if (meta.runner === "agent" && meta.agentName) {
				// An interactive run is proven by its contract file, never by the pane:
				// the transcript is wrapped and full of TUI chrome, and herdr's idle and
				// done only mean "ready for input". A settled agent without a contract is
				// a contract_failed, never a quiet completion.
				if (existsSync(meta.paths.resultPath)) {
					// The contract file is the evidence: mark the process done and let
					// settle() judge it. Leaving the state at running would make settle
					// report the job as still going.
					meta.state = "complete";
					meta.finishedAt ??= Date.now();
					this.persist(meta);
					return this.settle(meta);
				}
				const read = await this.#agentStatus(meta.agentName);
				if (read) {
					meta.agentStatus = read.status;
					this.persist(meta);
				}
				if (expired) {
					// Past the ceiling the job settles as timeout without a kill: pi has
					// no handle on the agent. Interrupt it in the pane (Esc) or close the
					// tab with FleetCleanup.
					meta.state = "timeout";
					meta.contractError = `timed out after ${meta.timeoutMs}ms; the agent may still be working in pane ${meta.pane?.paneId ?? "?"} — interrupt it there (Esc) or close the tab with FleetCleanup`;
					meta.finishedAt ??= Date.now();
					this.persist(meta);
					return this.settle(meta);
				}
				if (!read) {
					meta.state = "failed";
					meta.contractError = `the agent (${meta.agentName}) is gone and wrote no contract: it exited, the tab was closed, or herdr is unreachable. Read the pane by eye if it is still open.`;
					meta.finishedAt ??= Date.now();
					this.persist(meta);
					return { outcome: { kind: "failed", meta, error: meta.contractError } };
				}
				if (read.status === "idle" || read.status === "done") {
					meta.state = "contract_failed";
					meta.contractError = `the agent settled as ${read.status} without writing the contract: it answered in prose, or the brief never reached it. Read pane ${meta.pane?.paneId ?? "?"} and re-brief.`;
					meta.finishedAt ??= Date.now();
					this.persist(meta);
					return { outcome: { kind: "contract_failed", meta, error: meta.contractError } };
				}
				// working | unknown | blocked: still going. A blocked agent is waiting
				// on a human, and the harvest text says so.
				return { outcome: { kind: "running" } };
			}
			if (expired && child === undefined) {
				// Inherited from a dead session and past its wall-clock ceiling: no
				// timer survives the session, so the ceiling is enforced here. The
				// pid is not killed: after this long it may name a recycled process,
				// and a blind kill must not hit an innocent one. Stop it by hand
				// (the pid is in meta.json) or let it finish and harvest again.
				meta.state = "timeout";
				meta.contractError = `timed out after ${meta.timeoutMs}ms without a harvestable result; the process (pid ${meta.pid ?? "unknown"}) may still be running — stop it by hand if it is stuck`;
				meta.finishedAt ??= Date.now();
				this.persist(meta);
				return this.settle(meta);
			}
			const alive = !expired && (child !== undefined || (meta.pid !== undefined && pidAlive(meta.pid)));
			if (alive) return { outcome: { kind: "running" } };
			// Inherited from a dead session: settle it from disk evidence.
			const exitFile = meta.paths.exitCodePath;
			if (existsSync(meta.paths.resultPath)) {
				meta.state = "complete";
				meta.exitCode = 0;
			} else if (existsSync(exitFile)) {
				const code = readExitCodeText(readFileSync(exitFile, "utf8"));
				meta.exitCode = code ?? null;
				meta.state = code === 0 ? "complete" : "failed";
			} else {
				meta.state = "failed";
				meta.contractError = "process died without a result file (the session that spawned it is gone; see stderr.log)";
			}
			meta.finishedAt ??= Date.now();
			this.persist(meta);
		}
		return this.settle(meta);
	}

	private settle(meta: JobMeta): HarvestReport {
		if (meta.state === "running") return { outcome: { kind: "running" } };
		if (meta.state === "timeout" || meta.state === "failed") {
			// Refresh already named the cause for interactive jobs and for spawn
			// failures it could read off disk; fill the rest in here.
			const error = meta.contractError ?? (meta.state === "timeout" ? `timed out after ${meta.timeoutMs}ms` : this.#exitFailureText(meta));
			return { outcome: { kind: "failed", meta, error } };
		}

		// A job already settled as contract_failed keeps the reason it settled with.
		// Re-harvesting must not go looking for a file it never wrote and invent a
		// second, different complaint.
		if (meta.state === "contract_failed" && meta.contractError !== undefined && !existsSync(meta.paths.resultPath)) {
			meta.contractOk = false;
			return { outcome: { kind: "contract_failed", meta, error: meta.contractError } };
		}

		// complete or contract_failed: judge the contract now.
		let contract: unknown;
		try {
			contract = readJson(meta.paths.resultPath);
		} catch (error) {
			meta.state = "contract_failed";
			meta.contractError = `result.json unreadable: ${error instanceof Error ? error.message : String(error)}`;
			meta.contractOk = false;
			this.persist(meta);
			return { outcome: { kind: "contract_failed", meta, error: meta.contractError } };
		}

		// claude writes the contract into stdout; pull it out and back-fill the
		// result file so both executors leave the same artifact shape behind.
		if (meta.executor === "claude" && meta.runner !== "agent") {
			const stdoutText = readIfExists(meta.paths.stdoutPath);
			const parsed = parseClaudeStdout(stdoutText);
			if (parsed.structured === undefined) {
				meta.state = "contract_failed";
				meta.contractError = parsed.error ?? "claude stdout had no structured_output";
				meta.contractOk = false;
				this.persist(meta);
				return { outcome: { kind: "contract_failed", meta, error: meta.contractError } };
			}
			contract = parsed.structured;
			writeFileSync(meta.paths.resultPath, JSON.stringify(parsed.structured, null, 2), "utf8");
		}

		const check = validateContract(meta.taskKind, contract);
		meta.contractOk = check.ok;
		if (!check.ok) {
			meta.state = "contract_failed";
			meta.contractError = check.error;
			this.persist(meta);
			return { outcome: { kind: "contract_failed", meta, error: check.error ?? "contract invalid" } };
		}
		meta.state = "complete";
		this.persist(meta);
		return { outcome: { kind: "complete", meta } };
	}

	/** Rehydrate jobs from a previous session's run dirs. */
	loadFromDisk(): number {
		const runsDir = join(this.settings.stateDir, "runs");
		if (!existsSync(runsDir)) return 0;
		let loaded = 0;
		let names: string[];
		try {
			names = readdirSync(runsDir);
		} catch {
			return 0;
		}
		for (const id of names) {
			if (this.#jobs.has(id)) continue;
			const metaPath = join(runsDir, id, "meta.json");
			if (!existsSync(metaPath)) continue;
			try {
				const meta = readJson(metaPath) as JobMeta;
				this.#jobs.set(meta.id, meta);
				loaded += 1;
			} catch {
				continue;
			}
		}
		return loaded;
	}

	/**
	 * Why a detached executor failed. claude puts its own reason in the stdout
	 * envelope and leaves stderr.log empty, so read the envelope before pointing
	 * the reader at a file with nothing in it.
	 */
	#exitFailureText(meta: JobMeta): string {
		const code = `executor exited with code ${meta.exitCode ?? "unknown"}`;
		if (meta.executor === "claude") {
			const detail = claudeFailureNote(readIfExists(meta.paths.stdoutPath));
			if (detail !== undefined) return `${code}: ${detail}`;
		}
		return `${code}; see ${meta.paths.stderrPath}`;
	}

	persist(meta: JobMeta): void {
		try {
			writeFileSync(meta.paths.metaPath, JSON.stringify(meta, null, 2), "utf8");
		} catch (error) {
			// A run dir that vanished mid-flight (a cleaned worktree, a removed state
			// dir) loses its own state anyway. Only ENOENT is tolerated: the write must
			// not throw out of an exit handler, where nothing catches it and the session
			// dies with it. Anything else is a real fault and must surface.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	persistAll(): void {
		for (const meta of this.#jobs.values()) this.persist(meta);
	}

	clearTimers(): void {
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
	}
}
