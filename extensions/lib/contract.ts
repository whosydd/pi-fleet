/**
 * Result contract: validate what the executor wrote. Pure: every function
 * takes already-read text or already-parsed JSON and returns plain values.
 */

import type { TaskKind } from "./types.ts";

export interface ContractCheck {
	ok: boolean;
	error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkObject(value: unknown, label: string): Record<string, unknown> | string {
	if (!isRecord(value)) return `${label}: expected an object, got ${value === null ? "null" : typeof value}`;
	return value;
}

function checkString(value: unknown, label: string): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return `${label}: expected a non-empty string`;
	return undefined;
}

function checkNumber(value: unknown, label: string): string | undefined {
	if (typeof value !== "number" || Number.isNaN(value)) return `${label}: expected a number`;
	return undefined;
}

function checkBoolean(value: unknown, label: string): string | undefined {
	if (typeof value !== "boolean") return `${label}: expected a boolean`;
	return undefined;
}

function checkArray(value: unknown, label: string): unknown[] | string {
	if (!Array.isArray(value)) return `${label}: expected an array`;
	return value;
}

function firstError(...errors: (string | undefined)[]): string | undefined {
	return errors.find((error) => error !== undefined);
}

function checkFindings(findings: unknown, label: string, fields: { key: string; kind: "string" | "number" }[]): string | undefined {
	const arr = checkArray(findings, label);
	if (typeof arr === "string") return arr;
	for (const [index, item] of arr.entries()) {
		const record = checkObject(item, `${label}[${index}]`);
		if (typeof record === "string") return record;
		for (const field of fields) {
			const error = field.kind === "string" ? checkString(record[field.key], `${label}[${index}].${field.key}`) : checkNumber(record[field.key], `${label}[${index}].${field.key}`);
			if (error) return error;
		}
	}
	return undefined;
}

/**
 * Whether a contract's ticket names the ticket the job was dispatched for.
 *
 * A tracker id and a slug built from it are the same ticket: a job dispatched
 * for `23-gitignore` may report `#23`, and a job dispatched for `42` may report
 * `42-title-of-the-ticket`. The comparison is therefore normalized (no `#`, no
 * surrounding space, lowercase) and allows a prefix on either side when the
 * remainder starts at a hyphen. Anything else is a different ticket and the
 * contract must say so — the orchestrator reads this field to decide whether the
 * ticket is done, and an executor that copied the wrong number would otherwise
 * close the wrong one.
 */
export function ticketsMatch(reported: string, expected: string): boolean {
	const normalize = (value: string) => value.trim().replace(/^#+/, "").toLowerCase();
	const a = normalize(reported);
	const b = normalize(expected);
	if (!a || !b) return false;
	if (a === b) return true;
	return a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
}

/**
 * Structural validation of the two known contract shapes. Hand-rolled rather
 * than a JSON Schema engine: the shapes are fixed by this extension, and the
 * error must name the field, not the validator.
 *
 * `expectedTicket` closes the loop between the dispatch and the report: without
 * it, a contract that answers a different ticket validates clean.
 */
export function validateContract(taskKind: TaskKind, value: unknown, expectedTicket?: string): ContractCheck {
	const root = checkObject(value, "result");
	if (typeof root === "string") return { ok: false, error: root };

	if (taskKind === "implement") {
		const error = firstError(
			checkString(root.ticket, "result.ticket"),
			checkString(root.status, "result.status"),
			checkString(root.branch, "result.branch"),
		);
		if (error) return { ok: false, error };
		if (expectedTicket !== undefined && !ticketsMatch(String(root.ticket), expectedTicket)) {
			return { ok: false, error: `result.ticket: "${String(root.ticket)}" is not the ticket this job was dispatched for ("${expectedTicket}")` };
		}
		if (!["implemented", "blocked", "failed"].includes(root.status as string)) {
			return { ok: false, error: `result.status: must be implemented|blocked|failed, got "${String(root.status)}"` };
		}
		const commits = checkArray(root.commits, "result.commits");
		if (typeof commits === "string") return { ok: false, error: commits };
		// An implement job that claims "implemented" with zero commits is not
		// implemented: the contract must name the work, or the status must say
		// blocked/failed.
		if (root.status === "implemented" && commits.length === 0) {
			return { ok: false, error: "result.commits: status implemented requires at least one commit; report status blocked or failed if nothing landed" };
		}
		for (const [index, commit] of commits.entries()) {
			const record = checkObject(commit, `result.commits[${index}]`);
			if (typeof record === "string") return { ok: false, error: record };
			const commitError = firstError(checkString(record.sha, `result.commits[${index}].sha`), checkString(record.subject, `result.commits[${index}].subject`));
			if (commitError) return { ok: false, error: commitError };
		}
		const tests = checkObject(root.tests, "result.tests");
		if (typeof tests === "string") return { ok: false, error: tests };
		const testsError = firstError(
			checkString(tests.command, "result.tests.command"),
			checkNumber(tests.passed, "result.tests.passed"),
			checkNumber(tests.failed, "result.tests.failed"),
		);
		if (testsError) return { ok: false, error: testsError };
		return { ok: true };
	}

	const baseError = checkString(root.base, "result.base");
	if (baseError) return { ok: false, error: baseError };
	const standards = checkObject(root.standards, "result.standards");
	if (typeof standards === "string") return { ok: false, error: standards };
	const standardsError = firstError(
		checkString(standards.worst_issue, "result.standards.worst_issue"),
		checkFindings(standards.findings, "result.standards.findings", [
			{ key: "rule", kind: "string" },
			{ key: "file", kind: "string" },
			{ key: "line", kind: "number" },
			{ key: "quote", kind: "string" },
		]),
	);
	if (standardsError) return { ok: false, error: standardsError };
	const spec = checkObject(root.spec, "result.spec");
	if (typeof spec === "string") return { ok: false, error: spec };
	const specError = firstError(
		checkBoolean(spec.spec_found, "result.spec.spec_found"),
		checkString(spec.worst_issue, "result.spec.worst_issue"),
		checkFindings(spec.findings, "result.spec.findings", [
			{ key: "quote", kind: "string" },
			{ key: "file", kind: "string" },
			{ key: "line", kind: "number" },
		]),
	);
	if (specError) return { ok: false, error: specError };
	return { ok: true };
}

interface ClaudeJson {
	structured_output?: unknown;
	is_error?: boolean;
	result?: string;
	api_error_status?: number | string | null;
	terminal_reason?: string;
}

/**
 * The reason claude gives for a run that produced no contract.
 *
 * A quota or authentication failure exits 1 with an empty stderr.log and puts
 * the cause in the stdout envelope. Without this the harvest points the reader
 * at a file that holds nothing. Returns undefined when the stdout is not a
 * claude envelope or carries no error signal.
 */
export function claudeFailureNote(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	let parsed: ClaudeJson;
	try {
		parsed = JSON.parse(trimmed) as ClaudeJson;
	} catch {
		return undefined;
	}
	const failed = parsed.is_error === true || parsed.api_error_status != null || parsed.terminal_reason === "api_error";
	if (!failed) return undefined;
	const detail = typeof parsed.result === "string" && parsed.result.trim() !== "" ? parsed.result.trim() : `terminal_reason=${parsed.terminal_reason ?? "unknown"}`;
	return parsed.api_error_status == null ? detail : `${detail} (api_error_status=${parsed.api_error_status})`;
}

/** Pull the contract out of `claude -p --output-format json` stdout. */
export function parseClaudeStdout(text: string): { structured?: unknown; error?: string } {
	let parsed: ClaudeJson;
	try {
		parsed = JSON.parse(text) as ClaudeJson;
	} catch (error) {
		return { error: `claude stdout was not JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (parsed.structured_output === undefined) {
		// Prefer the executor's own reason: "no structured_output" is a symptom
		// when the run died on quota, auth, or a refused tool permission.
		return { error: claudeFailureNote(text) ?? "claude stdout had no structured_output field (is --json-schema supported by this version?)" };
	}
	return { structured: parsed.structured_output };
}
