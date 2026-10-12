/**
 * The run directory: the only durable record this package keeps.
 *
 * Filesystem only, no spawning. `runner.ts` calls these around the Herdr work.
 *
 * The disk is the source of truth. A job survives the session that dispatched
 * it, a later session rebuilds its view from these files, and a harvest of an
 * inherited job settles from what the executor left behind rather than from
 * anything held in memory.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JOB_SCHEMA_VERSION, type FleetSettings, type JobMeta } from "./types.ts";

export interface RunPaths {
	runDir: string;
	briefPath: string;
	taskPath: string;
	schemaPath: string;
	resultPath: string;
	metaPath: string;
}

/** Job ids are file names, so anything a path would choke on is stripped. */
export function ticketSlug(ticket: string): string {
	return (
		ticket
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "ticket"
	);
}

/** `job_<ticket>_<timestamp>_<nonce>`; the nonce keeps two same-millisecond jobs apart. */
export function newJobId(ticket: string, now: number, nonce: string): string {
	return `job_${ticketSlug(ticket)}_${now}_${nonce}`;
}

export function runPaths(settings: FleetSettings, id: string): RunPaths {
	const runDir = join(settings.runsDir, id);
	return {
		runDir,
		briefPath: join(runDir, "brief.md"),
		taskPath: join(runDir, "task.txt"),
		schemaPath: join(runDir, "schema.json"),
		resultPath: join(runDir, "result.json"),
		metaPath: join(runDir, "meta.json"),
	};
}

/**
 * Read one job, and refuse to read anything that is not this release's record.
 *
 * The three outcomes are kept apart on purpose. Collapsing them would make a
 * directory this package cannot read look like a job that failed, and a caller
 * would then write a verdict onto somebody else's record.
 */
export type MetaRead = { kind: "job"; meta: JobMeta } | { kind: "stale"; id: string; reason: string } | { kind: "absent"; id: string };

export interface StaleRun {
	id: string;
	reason: string;
}

function validate(value: unknown): JobMeta | string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "meta.json is not an object";
	const meta = value as Record<string, unknown>;
	if (meta.schemaVersion !== JOB_SCHEMA_VERSION) {
		return `meta.json records schema version ${meta.schemaVersion ?? "none"}, and this release reads ${JOB_SCHEMA_VERSION}: it was written by another release of pi-fleet`;
	}
	for (const field of ["id", "ticket", "ticketPath", "role", "executor", "runDir", "resultPath", "metaPath"]) {
		if (typeof meta[field] !== "string" || meta[field] === "") return `meta.json has no usable "${field}"`;
	}
	if (meta.role !== "implement" && meta.role !== "review") return `meta.json has role "${String(meta.role)}"`;
	return meta as unknown as JobMeta;
}

/** One job from disk, or the reason it could not be read. */
export function readMeta(settings: FleetSettings, id: string): MetaRead {
	const path = runPaths(settings, id).metaPath;
	if (!existsSync(path)) return { kind: "absent", id };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { kind: "stale", id, reason: `meta.json is not JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	const checked = validate(parsed);
	return typeof checked === "string" ? { kind: "stale", id, reason: checked } : { kind: "job", meta: checked };
}

/** True when the path names a directory. A stat that fails for any reason is no. */
function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function listRuns(settings: FleetSettings): MetaRead[] {
	if (!existsSync(settings.runsDir)) return [];
	// A run directory is a directory: `statSync` follows a symlink, so a run
	// directory reached through one is still listed. A stat that fails for any
	// reason cannot call the entry a directory, so the scan skips a plain file,
	// a broken link, and a link that resolves to itself. The directories around
	// them are still reported as jobs or as leftover dispatches.
	return readdirSync(settings.runsDir)
		.filter((id) => isDirectory(join(settings.runsDir, id)))
		.map((id) => readMeta(settings, id));
}

/** Every readable job, oldest first. An unreadable run directory is not a job. */
export function listJobs(settings: FleetSettings): JobMeta[] {
	return listRuns(settings)
		.filter((read): read is { kind: "job"; meta: JobMeta } => read.kind === "job")
		.map((read) => read.meta)
		.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Run directories this release cannot read, with the reason.
 *
 * Reported rather than hidden: they are the leftovers of an earlier release or
 * of a dispatch that died between `mkdir` and its meta write, and a silent skip
 * would leave FleetStatus showing nothing while the disk holds directories the
 * user may want to know about.
 *
 * A directory with no meta at all is a leftover too. It is not a job — harvest
 * and cleanup still refuse it — but a failed dispatch's own cleanup removes one,
 * so anything left is a visible fault worth a reason.
 */
export function listStale(settings: FleetSettings): StaleRun[] {
	return listRuns(settings).flatMap((read) => {
		if (read.kind === "stale") return [{ id: read.id, reason: read.reason }];
		if (read.kind === "absent") return [{ id: read.id, reason: "meta.json is absent, so the dispatch did not finish" }];
		return [];
	});
}

export function writeMeta(settings: FleetSettings, meta: JobMeta): void {
	const path = runPaths(settings, meta.id).metaPath;
	try {
		mkdirSync(path.replace(/\/meta\.json$/, ""), { recursive: true });
		writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
	} catch (error) {
		// A run directory removed mid-flight loses its own state anyway. Only a
		// missing parent is tolerated: the write happens from a tool result and
		// from cleanup paths, where a thrown error would surface as a failed tool
		// for a job that actually worked. Anything else is a real fault.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** The contract file the job wrote, or undefined when there is not one to read. */
export function readContract(meta: JobMeta): unknown {
	try {
		return JSON.parse(readFileSync(meta.resultPath, "utf8"));
	} catch {
		return undefined;
	}
}
