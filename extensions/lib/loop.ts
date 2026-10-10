import type { JobMeta, TriageRecord } from "./types.ts";

/**
 * The ticket's review loop, as a pure decision.
 *
 * The chain is event-driven and never routes through the model: an
 * implementation job that passes its contract earns a review; a review with
 * blockers earns one fix round; a review without blockers closes the loop. The
 * cap is code, not judgement, so a reviewer and an implementer that disagree
 * cannot spend rounds forever.
 *
 * Nothing here touches disk, processes, or pi. It answers one question: what
 * should happen next, given what the last job settled as.
 */

export type LoopStep =
	/** Dispatch a review of this ticket's work, on the other harness. */
	| { kind: "review" }
	/** Dispatch a fix round carrying these findings back to the implementer. */
	| { kind: "fix"; findings: string[] }
	/** The loop closed clean: nothing further to dispatch. */
	| { kind: "done" }
	/** A failure the loop cannot act on. Report it, do not retry. */
	| { kind: "halt"; reason: string };

/** Findings worth a fix round: blockers only, style and ignore never spend a round. */
export function blockerFindings(triage: TriageRecord[]): string[] {
	return triage.filter((record) => record.choice === "blocker").map((record) => `#${record.index} (${record.axis}): ${record.label}`);
}

/**
 * What the fleet should dispatch next for a settled job, or nothing.
 *
 * `maxFixRound` is the cap on repair rounds. An unset triage channel is
 * degradable: without verdicts the loop cannot name blockers, so it halts with
 * a note rather than inventing a round.
 */
export function nextStep(meta: JobMeta, maxFixRound: number, triageAvailable: boolean): LoopStep {
	if (meta.state !== "complete" || meta.contractOk !== true) {
		return { kind: "halt", reason: meta.contractError ?? `${meta.state}: the contract is the only success signal` };
	}
	if (meta.taskKind === "review") {
		if (!triageAvailable) return { kind: "halt", reason: "triage unavailable: no findings were classified, so no blocker is known" };
		const findings = blockerFindings(meta.triage ?? []);
		if (findings.length === 0) return { kind: "done" };
		if (meta.fixRound >= maxFixRound) return { kind: "halt", reason: `fix rounds capped at ${maxFixRound} with ${findings.length} blocker(s) left` };
		return { kind: "fix", findings };
	}
	return { kind: "review" };
}

/**
 * The review brief the fleet writes for itself after an implement job passed its
 * contract. It names the fixed point and the two axes, because the reviewer reads
 * this text and nothing else.
 */
export function reviewBriefFor(meta: JobMeta, contract: { branch?: string; commits?: unknown[]; summary?: string }): string {
	const base = meta.base ?? contract.branch ?? "HEAD~1";
	const commits = contract.commits?.length ?? 0;
	const claim = contract.summary ? `What the implementer claims it does: ${contract.summary}` : "What the implementer claims is unstated; read the diff.";
	return [
		"Review task: judge the committed work on this branch against two axes and write the contract file.",
		"",
		`The diff under review: git diff ${base}..HEAD (${commits} commit(s) reported by the implementation job). Read it in full first.`,
		claim,
		"",
		"Axis 1 - standards: report findings as rule/file/line/quote. Check the documented interface rules of this repository, dead code, error handling that swallows a failure, and any invariant the diff weakens.",
		"Axis 2 - spec: does the code do what the ticket says? Report findings as quote/file/line, where quote is the ticket sentence the code fails or satisfies.",
		"",
		"Out of scope: do not fix anything, do not commit, do not push, do not close a ticket.",
	].join("\n");
}

/** The fix brief the fleet writes for a review that found blockers. */
export function fixBriefFor(meta: JobMeta, findings: string[]): string {
	return [
		`Fix round ${meta.fixRound + 1} for ticket ${meta.ticket}: the review of your previous work found ${findings.length} blocker(s). Resolve every one of them, then commit.`,
		"",
		"Blockers (from the review's own findings, classified by the triage channel):",
		...findings.map((finding) => `- ${finding}`),
		"",
		"If a blocker is wrong or you refuse it, say so in the contract's summary instead of silently skipping it. Never run git stash, git commit --amend, or any force push.",
	].join("\n");
}
