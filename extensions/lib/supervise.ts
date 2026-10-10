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
import { paneRunCommand, parseTabCreate, parseWorkspaceList, readExitCodeText, readPidFromText, runScript, workspaceForWorktree, type WorkspaceEntry } from "./panes.ts";
import { schemaFor } from "./profiles.ts";
import type { FleetSettings, JobMeta } from "./types.ts";

const execFileAsync = promisify(execFile);

export type HarvestOutcome =
	| { kind: "running" }
	| { kind: "complete"; meta: JobMeta }
	| { kind: "contract_failed"; meta: JobMeta; error: string }
	| { kind: "failed"; meta: JobMeta; error: string };

export interface HarvestReport {
	outcome: HarvestOutcome;
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
			// run.sh records the exact command either way: a pane executes it, and a
			// detached spawn leaves it behind as the reproducible form of the argv.
			// A pane pings the human itself, so the ping survives a dead session.
			const notify = plan.pane && this.settings.notify ? { herdrBin: this.settings.herdrBin, title: `fleet: ${plan.ticket} finished` } : undefined;
			writeFileSync(plan.paths.scriptPath, runScript({ worktree: plan.worktree, command: plan.command, runDir: dirname(plan.paths.metaPath), ...(notify ? { notify } : {}) }), "utf8");
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
			runner: plan.pane ? "pane" : "spawn",
			...(gate ? { gate } : {}),
		};

		if (plan.pane) {
			const started = await this.#startInPane(plan, meta);
			if (started.ok) {
				this.#register(meta);
				return meta;
			}
			// Observability degrades to a note, never a blocked dispatch: the pane
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
	 * Start the job in a Herdr pane: one tab per job inside the workspace that
	 * owns the worktree, running run.sh. The pane's shell stays alive after the
	 * executor exits, so the human can still read the output and the diff.
	 */
	async #startInPane(plan: Parameters<Supervisor["dispatch"]>[0], meta: JobMeta): Promise<{ ok: true } | { ok: false; error: string }> {
		const workspaceId = await this.#workspaceFor(plan.worktree);
		if (!workspaceId) {
			return { ok: false, error: `no Herdr workspace owns ${plan.worktree}, and this session carries no HERDR_WORKSPACE_ID to fall back on` };
		}
		const label = `fleet: ${plan.ticket}`;
		const created = await this.#herdr(["tab", "create", "--workspace", workspaceId, "--label", label, "--cwd", plan.worktree, "--no-focus"]);
		if (!created.ok) return { ok: false, error: created.error };
		const tab = parseTabCreate(created.stdout);
		if (!tab) return { ok: false, error: "herdr tab create returned no tab or pane id" };
		const run = await this.#herdr(["pane", "run", tab.paneId, paneRunCommand(plan.paths.scriptPath)]);
		if (!run.ok) return { ok: false, error: run.error };
		meta.pane = { workspaceId, tabId: tab.tabId, paneId: tab.paneId, label };
		return { ok: true };
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

	/** One herdr CLI call. Any failure comes back as a message, never a throw. */
	async #herdr(args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
		try {
			const { stdout } = await execFileAsync(this.settings.herdrBin, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
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
	refresh(id: string): HarvestReport {
		const meta = this.#jobs.get(id);
		if (!meta) {
			return {
				outcome: { kind: "failed", meta: { id, state: "failed", startedAt: 0, timeoutMs: 0 } as JobMeta, error: `unknown job "${id}"` },
			};
		}
		if (meta.state === "running") {
			const child = this.#children.get(id);
			const expired = Date.now() - meta.startedAt > meta.timeoutMs;
			if (meta.runner === "pane") {
				// The process pi spawned was the herdr CLI, which exits as soon as it
				// has written the command into the pane. Its child handle and its pid
				// say nothing about the executor, so the pane's own evidence decides:
				// run.sh writes pid, then the exit code when the executor is done.
				const code = existsSync(meta.paths.exitCodePath) ? readExitCodeText(readFileSync(meta.paths.exitCodePath, "utf8")) : undefined;
				if (code !== undefined) {
					meta.exitCode = code;
					meta.state = code === 0 ? "complete" : "failed";
					if (code !== 0) meta.contractError = `executor exited with code ${code} in pane ${meta.pane?.tabId ?? "?"}; the tab stays open so you can read what it printed`;
					meta.finishedAt ??= Date.now();
					this.persist(meta);
					return this.settle(meta);
				}
				if (meta.pid === undefined && existsSync(meta.paths.pidPath)) {
					meta.pid = readPidFromText(readFileSync(meta.paths.pidPath, "utf8"));
				}
				if (expired) {
					// Past the ceiling the job settles as timeout without a kill: the
					// recorded pid may already name a recycled process. Closing the tab
					// (FleetCleanup) is what actually stops a pane executor.
					meta.state = "timeout";
					meta.contractError = `timed out after ${meta.timeoutMs}ms without an exit code; the executor may still be running in pane ${meta.pane?.tabId ?? "?"} — press Ctrl-C there or close the tab with FleetCleanup`;
					meta.finishedAt ??= Date.now();
					this.persist(meta);
					return this.settle(meta);
				}
				// No pid file yet: run.sh has not started, or started a moment ago.
				if (meta.pid === undefined || pidAlive(meta.pid)) return { outcome: { kind: "running" } };
				meta.state = "failed";
				meta.contractError = `the pane process ended without writing an exit code (the tab was closed, the shell died, or the machine rebooted); see pane ${meta.pane?.tabId ?? "?"}`;
				meta.finishedAt ??= Date.now();
				this.persist(meta);
				return this.settle(meta);
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
			// claude puts its own reason in the stdout envelope and leaves
			// stderr.log empty, so a bare "see stderr.log" pointer sends the reader
			// to a file with nothing in it.
			const detail = meta.executor === "claude" ? claudeFailureNote(readIfExists(meta.paths.stdoutPath)) : undefined;
			const error =
				meta.contractError ??
				(meta.state === "timeout"
					? `timed out after ${meta.timeoutMs}ms`
					: detail
						? `executor exited with code ${meta.exitCode ?? "unknown"}: ${detail}`
						: `executor exited with code ${meta.exitCode ?? "unknown"}; see ${meta.paths.stderrPath}`);
			return {
				outcome: { kind: "failed", meta, error },
			};
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
		if (meta.executor === "claude") {
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
