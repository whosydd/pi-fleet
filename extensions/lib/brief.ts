/**
 * The task text an executor receives, and the brief file it reads.
 *
 * Pure: strings in, string out. `runner.ts` writes what these return.
 *
 * This module is where the boundary between pi and an executor is spelled out.
 * An executor sees only two things: this task text, and the brief file it points
 * at. It never sees the parent conversation, so every rule it must obey has to be
 * here.
 *
 * This text carries the review method itself rather than naming an upstream file.
 * The executors run under Codex and Claude, and both already install the upstream
 * skills on their own machines; this package ships none of them. Handing over an
 * absolute path to a second copy was worse than useless — the upstream review
 * skill is model-invocable, so naming a path while the task also reads like a
 * review made the executor load two copies at once, and the two installs are not
 * the same revision. So the rules that must hold live here as text:
 *
 *   - the two axes, because a review that merges them reranks findings across
 *     axes and defeats the point of having two;
 *   - the anti-recursion guard, because the upstream review skill runs its axes
 *     in sub-agents and does not forbid them from spawning more. Field reports
 *     reached fifty-plus agents, and upstream has not shipped the fix;
 *   - the output shape, because the contract is this package's and the upstream
 *     skill produces prose.
 *
 * The upstream `implement` skill is not named at all. Its six instructions are
 * covered here more reliably (the brief carries the ticket, the contract makes
 * the executor report real test numbers, the task says what to leave behind)
 * except for one — its closing step invoking the upstream review skill — which
 * is exactly the step that would put the review back inside the run that wrote
 * the code.
 *
 * Two rules below are this package's own:
 *
 *   - an implement job never commits. Its changes stay in the worktree, and the
 *     orchestrator commits after the review passes. So the contract carries no
 *     commits, and a review reads the working tree rather than a range of
 *     commits;
 *   - the review runs directly, on both axes, with no sub-agents. That is the
 *     anti-recursion guard: the upstream review skill runs its axes in
 *     sub-agents and does not forbid them from spawning more. Field reports
 *     reached fifty-plus agents, and upstream has not shipped the fix.
 */

import { schemaFor } from "./contract.ts";
import type { FleetRole } from "./types.ts";

export interface TaskInput {
	ticket: string;
	role: FleetRole;
	/** Absolute path of the brief file inside the run directory. */
	briefPath: string;
	/** Absolute path of the contract file the executor must write. */
	resultPath: string;
	/** The fixed point a review diffs against. Absent for an implement job. */
	base?: string;
	fixRound: number;
}

/**
 * The upstream skills a role may use, when the executor's own install provides
 * them.
 *
 * These are named, never pointed at: a path would make the executor read a copy
 * that is not the one its harness indexed, and the task text below is complete
 * without either.
 */
export const ROLE_SKILLS: Record<FleetRole, string[]> = {
	implement: ["tdd"],
	review: ["code-review"],
};

/** Rules that hold for both roles. */
const COMMON_RULES = [
	"You are a fleet executor. One ticket, one job. Read the brief file and do exactly what it asks.",
	"Do not commit. Leave your changes in the worktree: the orchestrator reviews them first, and commits after the review passes.",
	"Never run git stash, git commit --amend, or any force push. The stash is shared by every worktree of this repository.",
	"Do not close, tick, or edit the tracker ticket: the orchestrator owns ticket state.",
	"Your message in this terminal is read by a human. The orchestrator reads only the contract file, so nothing you say in prose reaches it.",
];

/** The review method, in full. See the module header for why it lives here. */
const REVIEW_METHOD = [
	"Method. Review the committed diff against the fixed point below, on two axes, and keep them apart:",
	"  Standards: does the diff follow how this repository writes code? Find the files that document that — CODING_STANDARDS.md, CONTRIBUTING.md, AGENTS.md, docs/. Report each finding as rule, file, line, quote.",
	"  Spec: does the diff do what the ticket asked? Report each finding as the ticket sentence it fails or satisfies, plus file and line.",
	"Do not merge or rerank the axes, and do not pick one finding as the worst overall. Each axis reports its own worst issue.",
	"Report only what you can cite. A finding without a file and a line is not a finding.",
];

/** Rules that hold for one role. */
const ROLE_RULES: Record<FleetRole, string[]> = {
	implement: [
		"Build the ticket, and nothing beyond it. If the brief names what is out of scope, stay inside that boundary.",
		"Run the checks the brief names, and report the numbers you actually observed. A count you did not measure is worse than no count: the orchestrator reads the contract to decide whether the work landed.",
		"If the environment stops you from running the checks, report status blocked with the reason. Do not report implemented on untested work.",
		"The orchestrator dispatches an independent review of your work after this job, using a different harness. Do not run a code review yourself.",
	],
	review: [
		"Review the working tree, not a commit: the implement job leaves its changes uncommitted. The orchestrator stages them, so `git diff <base>` shows the whole change, new files included.",
		...REVIEW_METHOD,
		"Do not fix anything, do not commit, do not push.",
		"Do not invoke your harness's review command or spawn additional agents: perform this review directly, both axes yourself.",
	],
};

/**
 * The instruction to write the contract.
 *
 * A TUI answer cannot be harvested: a pane transcript is wrapped, scrolled, and
 * full of the TUI's own chrome. So the contract is a file the executor writes
 * with its own file tools, and the file holds nothing else.
 */
const CONTRACT_RULE =
	"When done, use your file tools to write the contract as ONE JSON object into the file named below. Nothing else may be in that file: no prose, no code fence, no trailing note. It must match this schema, and it must carry the ticket id exactly as this job names it.";

/**
 * The task text. It points at the brief rather than carrying it, so the brief
 * stays the one place the ticket content lives.
 */
export function buildTask(input: TaskInput): string {
	const skills = ROLE_SKILLS[input.role];
	const lines = [
		...COMMON_RULES,
		...ROLE_RULES[input.role],
		"",
		`Read the brief at: ${input.briefPath}`,
		`If your harness provides the ${skills.map((name) => `\`${name}\``).join(" or ")} skill, use it for the method; the rules above hold either way.`,
	];
	if (input.base) lines.push(`Review fixed point (the diff is git diff ${input.base}, over the uncommitted working tree): ${input.base}`);
	if (input.fixRound > 0) {
		lines.push(`This is fix round ${input.fixRound}: address only the findings named in the brief, and change nothing else.`);
	}
	lines.push("", `${CONTRACT_RULE} ${input.resultPath}`, "Result contract:", JSON.stringify(schemaFor(input.role), null, 2));
	return lines.join("\n");
}

/**
 * The brief file: the ticket's own text under a short header.
 *
 * The ticket text is copied rather than referenced. The executor runs in a
 * worktree cut from a commit, and a ticket file that is uncommitted, or that
 * lives outside the worktree, would otherwise be invisible to it. Copying also
 * means the executor never needs write access to the tracker.
 */
export function buildBrief(input: { ticket: string; role: FleetRole; ticketText: string; base?: string; fixRound: number; findings?: string[] }): string {
	const header = [`# Ticket ${input.ticket} — ${input.role} job`, ""];
	if (input.base) header.push(`Review fixed point: ${input.base}`, "");
	if (input.fixRound > 0) header.push(`Fix round: ${input.fixRound}`, "");
	if (input.findings && input.findings.length > 0) {
		header.push("## Findings this round must resolve", ...input.findings.map((finding) => `- ${finding}`), "");
	}
	header.push("## The ticket", "", input.ticketText.trim(), "");
	return header.join("\n");
}
