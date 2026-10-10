/**
 * Executor profiles: turn a dispatch into one argv line and the prompt the
 * executor actually reads.
 *
 * Pure: no fs, no process spawning, no pi imports. `plan.ts` composes these
 * with validation; `supervise.ts` executes what they produce.
 */

import type { ExecutorKind, TaskKind } from "./types.ts";
export interface DispatchInput {
	ticket: string;
	worktree: string;
	executor: ExecutorKind;
	taskKind: TaskKind;
	brief: string;
	base?: string;
	skillPointer?: string;
	model?: string;
	fixRound: number;
}

/** Plain JSON Schema for the result contract; no `format` keywords anywhere: claude treats them as annotations. */
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

export function schemaFor(taskKind: TaskKind): object {
	return taskKind === "implement" ? IMPLEMENT_SCHEMA : REVIEW_SCHEMA;
}

const COMMON_RULES = [
	"You are a fleet executor. Read the brief file and follow it.",
	"Commit your work to the current branch. Never run git stash, git commit --amend, or any force push.",
	"Do not close or edit the tracker ticket: the orchestrator closes tickets.",
	"Do not spawn subagents.",
];

const KIND_RULES: Record<TaskKind, string[]> = {
	// The anti-recursion line is the known code-review failure mode: a review
	// that finds the skill again and fans out. It goes in every review brief.
	review: [
		"Review only committed work (git diff against the fixed point); never staged or working-tree changes.",
		"Do not invoke /code-review or spawn additional agents: perform this review directly.",
	],
	implement: [],
};

/** The final message must be the contract, nothing else — both executors agree on this. */
const OUTPUT_RULE =
	"When done, your final message must be only the JSON object matching the Result contract below. No prose around it.";

export function buildPrompt(input: DispatchInput, briefPath: string): string {
	const lines = [
		...COMMON_RULES,
		...KIND_RULES[input.taskKind],
		`Read the brief at ${briefPath} and follow it.`,
	];
	if (input.skillPointer) {
		lines.push(`Load and follow the skill instructions at: ${input.skillPointer}`);
	}
	if (input.base) {
		lines.push(`Review fixed point: ${input.base}`);
	}
	if (input.fixRound > 0) {
		lines.push(`This is fix round ${input.fixRound}: address only the findings named in the brief, and change nothing else.`);
	}
	lines.push("", OUTPUT_RULE, "Result contract:", JSON.stringify(schemaFor(input.taskKind), null, 2));
	return lines.join("\n");
}

export interface ProfileArgs {
	argv: string[];
	schemaArg: { flag: string; value: string };
}

/**
 * codex exec: `-o` writes the final message (the contract) to a file; `--json`
 * streams events with usage to stdout for the supervisor to read. claude -p:
 * `--json-schema` makes stdout JSON carry `structured_output`; the supervisor
 * extracts the contract from stdout itself.
 */
export function buildArgv(
	input: DispatchInput,
	paths: { promptPath: string; schemaPath: string; resultPath: string },
	bins: { codexBin: string; claudeBin: string },
): string[] {
	if (input.executor === "codex") {
		const argv = [
			bins.codexBin,
			"exec",
			"-C",
			input.worktree,
			"--sandbox",
			"workspace-write",
			"--output-schema",
			paths.schemaPath,
			"-o",
			paths.resultPath,
		];
		if (input.model) argv.push("-m", input.model);
		argv.push("--", buildPrompt(input, paths.promptPath));
		return argv;
	}
	const schemaJson = JSON.stringify(schemaFor(input.taskKind));
	const argv = [
		bins.claudeBin,
		"-p",
		buildPrompt(input, paths.promptPath),
		"--output-format",
		"json",
		"--json-schema",
		schemaJson,
	];
	if (input.model) argv.push("--model", input.model);
	// Tool and permission policy is the executor's own business (its settings,
	// its permission modes): pi dispatches the task and judges the contract,
	// it does not pick the executor's tools.
	return argv;
}
