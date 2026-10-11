/**
 * The result contract: its shape, and the validation of what the executor wrote.
 *
 * Pure. Every function takes already-read text or already-parsed JSON and
 * returns plain values, so every rule and every error message is testable
 * without a session and without a model call.
 *
 * Two shapes are fixed here — one per role — and the same schemas are written
 * into the run directory for the executor to read. The executor's exit code is
 * not evidence: a zero exit with a broken contract is `contract_failed`, and
 * only this module decides that.
 */

import type { FleetRole } from "./types.ts";

export interface ContractCheck {
	ok: boolean;
	error?: string;
}

/**
 * Plain JSON Schema for the implement role; no `format` keywords anywhere,
 * because claude treats them as annotations.
 */
export const IMPLEMENT_SCHEMA = {
	type: "object",
	properties: {
		ticket: { type: "string" },
		status: { type: "string", enum: ["implemented", "blocked", "failed"] },
		branch: { type: "string" },
		commits: {
			type: "array",
			items: {
				type: "object",
				properties: { sha: { type: "string" }, subject: { type: "string" } },
				required: ["sha", "subject"],
				additionalProperties: false,
			},
		},
		tests: {
			type: "object",
			properties: {
				command: { type: "string" },
				passed: { type: "number" },
				failed: { type: "number" },
			},
			required: ["command", "passed", "failed"],
			additionalProperties: false,
		},
		blocked_reason: { type: "string" },
		notes: { type: "string" },
	},
	required: ["ticket", "status", "branch", "commits", "tests"],
	additionalProperties: false,
} as const;

/**
 * The review role's two axes, never merged: `standards` is how this repository
 * writes code, `spec` is whether the code does what the ticket asked.
 */
export const REVIEW_SCHEMA = {
	type: "object",
	properties: {
		base: { type: "string" },
		standards: {
			type: "object",
			properties: {
				worst_issue: { type: "string" },
				findings: {
					type: "array",
					items: {
						type: "object",
						properties: {
							rule: { type: "string" },
							file: { type: "string" },
							line: { type: "number" },
							quote: { type: "string" },
						},
						required: ["rule", "file", "line", "quote"],
						additionalProperties: false,
					},
				},
			},
			required: ["worst_issue", "findings"],
			additionalProperties: false,
		},
		spec: {
			type: "object",
			properties: {
				spec_found: { type: "boolean" },
				worst_issue: { type: "string" },
				findings: {
					type: "array",
					items: {
						type: "object",
						properties: {
							quote: { type: "string" },
							file: { type: "string" },
							line: { type: "number" },
						},
						required: ["quote", "file", "line"],
						additionalProperties: false,
					},
				},
			},
			required: ["spec_found", "worst_issue", "findings"],
			additionalProperties: false,
		},
	},
	required: ["base", "standards", "spec"],
	additionalProperties: false,
} as const;

export function schemaFor(role: FleetRole): object {
	return role === "implement" ? IMPLEMENT_SCHEMA : REVIEW_SCHEMA;
}

// ---------------------------------------------------------------------------
// Validation

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
 * for `23-gitignore` may report `#23`. The comparison is normalized (no `#`, no
 * surrounding space, lowercase) and allows a prefix on either side when the
 * remainder starts at a hyphen. Anything else is a different ticket, and the
 * orchestrator reads this field to decide whether the ticket is done.
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
 * Structural validation of the two contract shapes. Hand-rolled rather than
 * driven by a JSON Schema engine: the shapes are fixed by this package, and the
 * error must name the field rather than the validator.
 *
 * `expectedTicket` closes the loop between the dispatch and the report. Without
 * it, a contract answering a different ticket validates clean and the
 * orchestrator closes the wrong one.
 */
export function validateContract(role: FleetRole, value: unknown, expectedTicket?: string): ContractCheck {
	const root = checkObject(value, "result");
	if (typeof root === "string") return { ok: false, error: root };

	if (role === "implement") {
		const error = firstError(checkString(root.ticket, "result.ticket"), checkString(root.status, "result.status"), checkString(root.branch, "result.branch"));
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
		// blocked or failed.
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
		const testsError = firstError(checkString(tests.command, "result.tests.command"), checkNumber(tests.passed, "result.tests.passed"), checkNumber(tests.failed, "result.tests.failed"));
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

// ---------------------------------------------------------------------------
// Executor output

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
 * A quota or authentication failure puts the cause in the stdout envelope while
 * stderr stays empty, so a report that points at stderr.log points at nothing.
 * Returns undefined when the stdout is not a claude envelope or carries no
 * error signal. The envelope's cost fields are deliberately not read: executor
 * spend is the executor's own account.
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

/**
 * Read a contract out of one-shot claude stdout, when a delivery wrote no
 * result file.
 *
 * A detached `claude -p --output-format json` run carries the contract in its
 * stdout envelope rather than on disk. Reading the file first would settle every
 * such run as contract_failed before its output was ever looked at.
 */
export function parseClaudeStdout(text: string): { structured?: unknown; error?: string } {
	let parsed: ClaudeJson;
	try {
		parsed = JSON.parse(text) as ClaudeJson;
	} catch (error) {
		return { error: `claude stdout was not JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (parsed.structured_output === undefined) {
		return { error: claudeFailureNote(text) ?? "claude stdout had no structured_output field (is --json-schema supported by this version?)" };
	}
	return { structured: parsed.structured_output };
}
