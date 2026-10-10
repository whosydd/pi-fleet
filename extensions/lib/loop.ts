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
