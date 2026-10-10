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

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseClaudeStdout, validateContract } from "./contract.ts";
import { schemaFor } from "./profiles.ts";
import type { FleetSettings, JobMeta } from "./types.ts";

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
	dispatch(
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
		},
		brief: string,
		gate?: JobMeta["gate"],
	): JobMeta {
		// File prep can fail on a read-only state dir; surface a named error
		// instead of a raw fs exception through the tool boundary.
		try {
			for (const dir of [this.settings.stateDir, dirname(plan.paths.metaPath)]) {
				mkdirSync(dir, { recursive: true });
			}
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
			...(gate ? { gate } : {}),
		};

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
				this.persist(meta);
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

		this.#jobs.set(meta.id, meta);
		this.persist(meta);
		if (meta.state === "running") {
			this.#timers.set(
				meta.id,
				setTimeout(() => this.timeout(meta.id), plan.timeoutMs).unref(),
			);
		}
		return meta;
	}

	/** Kill a running job; SIGTERM first, SIGKILL after a short grace period. */
	stop(id: string, graceMs = 5000): boolean {
		const meta = this.#jobs.get(id);
		const child = this.#children.get(id);
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
			const exitFile = `${dirname(meta.paths.metaPath)}/exit_code`;
			if (existsSync(meta.paths.resultPath)) {
				meta.state = "complete";
				meta.exitCode = 0;
			} else if (existsSync(exitFile)) {
				const code = Number(readFileSync(exitFile, "utf8").trim());
				meta.exitCode = Number.isFinite(code) ? code : null;
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
			const error =
				meta.contractError ??
				(meta.state === "timeout"
					? `timed out after ${meta.timeoutMs}ms`
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
			const stdoutText = existsSync(meta.paths.stdoutPath) ? readFileSync(meta.paths.stdoutPath, "utf8") : "";
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
