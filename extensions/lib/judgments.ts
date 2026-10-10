/**
 * Jev judgments for the fleet: the two soft calls the orchestrating model
 * used to make on its own, turned into typed, thresholded decisions.
 *
 *   - Gate (pre-dispatch): three atomic nouls over the brief — entry points,
 *     acceptance, scope boundary. A brief below the floor is refused with the
 *     missing dimensions named; the implement workflow's own weak point
 *     ("nothing agrees the seams") becomes a code-enforced check.
 *   - Triage (post-harvest, review jobs): one choice per finding — blocker,
 *     style, ignore. Only blockers should consume fix rounds.
 *
 * Pure in this module except `classifyViaRegistry`, which wraps the pi model
 * registry. Every judgment is degradable: an unavailable channel must never
 * block the main dispatch path.
 *
 * Calibration notes from live runs (typesafe/jev-latest): compound questions
 * wash out (0.71 vs 0.73 for thin vs complete briefs); atomic nouls separate
 * cleanly (0.05 vs 0.97). One narrow judgment per question, one brief per
 * call, backticked state paths.
 */

import type { TriageRecord } from "./types.ts";
import type { ClassifierAnswer, ClassifierContext, ClassifierQuestion, ClassifierResult, Usage } from "@earendil-works/pi-ai";

export type { ClassifierAnswer };

// ---------------------------------------------------------------------------
// Settings

export interface JudgmentSettings {
	enabled: boolean;
	/** provider/id of the classifier model, resolved through pi's model registry. */
	modelProvider: string;
	modelId: string;
	/** Per-noul hard floor; below it the dispatch is refused. */
	gateFloor: number;
	/** Per-noul warn line; between floor and warn the dispatch proceeds with a note. */
	gateWarn: number;
	/** Choice confidence below this marks a triage verdict uncertain. */
	triageConfidence: number;
}

export function readJudgmentSettings(env: NodeJS.ProcessEnv = process.env): JudgmentSettings {
	return {
		enabled: env.PI_FLEET_JUDGMENTS !== "off",
		modelProvider: env.PI_FLEET_JUDGE_PROVIDER || "typesafe",
		modelId: env.PI_FLEET_JUDGE_ID || "jev-latest",
		gateFloor: parseThreshold(env.PI_FLEET_GATE_FLOOR, 0.7),
		gateWarn: parseThreshold(env.PI_FLEET_GATE_WARN, 0.85),
		triageConfidence: parseThreshold(env.PI_FLEET_TRIAGE_CONFIDENCE, 0.8),
	};
}

function parseThreshold(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Registry call wrapper: never throws, degrades to a reason string.

/**
 * What one classifier call cost the orchestrator. Executors bill their own
 * accounts and their spend is never recorded here; this is pi's own judgment
 * channel, which is the spend the orchestrator can actually decide to cut.
 */
export interface JudgmentUsage {
	tokens: number;
	cost: number;
}

export type ClassifyAttempt = { ok: true; answers: Record<string, ClassifierAnswer>; usage?: JudgmentUsage } | { ok: false; reason: string };

export interface ClassifyRegistry {
	classify(model: unknown, context: ClassifierContext): Promise<ClassifierResult>;
	findOfType(type: "classifier", provider: string, id: string): unknown;
}

/** Token totals and catalog cost, when the service reports them. */
function usageOf(usage: Usage | undefined): JudgmentUsage | undefined {
	if (!usage) return undefined;
	return { tokens: usage.totalTokens, cost: usage.cost.total };
}

export async function classifyViaRegistry(
	registry: ClassifyRegistry,
	settings: JudgmentSettings,
	context: ClassifierContext,
): Promise<ClassifyAttempt> {
	const model = registry.findOfType("classifier", settings.modelProvider, settings.modelId);
	if (!model) {
		return { ok: false, reason: `classifier "${settings.modelProvider}/${settings.modelId}" not found in the model catalog` };
	}
	const result = await registry.classify(model, context);
	if (result.stopReason !== "stop") {
		return { ok: false, reason: result.errorMessage ?? `classifier stopped with "${result.stopReason}"` };
	}
	return { ok: true, answers: result.answers, usage: usageOf(result.usage) };
}

// ---------------------------------------------------------------------------
// Gate: pre-dispatch brief readiness, three atomic nouls.

export const GATE_DIMENSIONS = ["entry_points", "acceptance", "scope_boundary"] as const;
export type GateDimension = (typeof GATE_DIMENSIONS)[number];

const GATE_QUESTION_IDS: Record<GateDimension, string> = {
	entry_points: "has_entry_points",
	acceptance: "has_acceptance",
	scope_boundary: "has_scope_boundary",
};

const GATE_QUESTIONS: Record<string, ClassifierQuestion> = {
	has_entry_points: {
		type: "bool",
		instructions: "Does `brief` name the concrete entry points or APIs the work must go through?",
		criteria: { true: "named explicitly", false: "absent or vague" },
	},
	has_acceptance: {
		type: "bool",
		instructions: "Does `brief` state observable acceptance criteria an executor can verify itself?",
		criteria: { true: "checkable statements", false: "absent or subjective ('nice', 'handle errors')" },
	},
	has_scope_boundary: {
		type: "bool",
		instructions: "Does `brief` say what is out of scope?",
		criteria: { true: "explicit exclusions", false: "no exclusions named" },
	},
};

export function buildGateContext(brief: string): ClassifierContext {
	return { state: { brief }, questions: GATE_QUESTIONS };
}

export interface GateVerdict {
	outcome: "pass" | "warn" | "refuse";
	probabilities: Record<GateDimension, number>;
	/** Dimensions below the floor; the refusal names these. */
	missing: GateDimension[];
	/** Dimensions between floor and warn; the warning names these. */
	weak: GateDimension[];
}

export function interpretGate(answers: Record<string, ClassifierAnswer>, thresholds: { floor: number; warn: number }): GateVerdict {
	const probabilities = {} as Record<GateDimension, number>;
	const missing: GateDimension[] = [];
	const weak: GateDimension[] = [];
	for (const dimension of GATE_DIMENSIONS) {
		const answer = answers[GATE_QUESTION_IDS[dimension]];
		// A missing or malformed answer is evidence the channel cannot read
		// this brief dimension: treat it as absent, never as pass.
		const probability = answer?.type === "bool" ? answer.probability : 0;
		probabilities[dimension] = probability;
		if (probability < thresholds.floor) missing.push(dimension);
		else if (probability < thresholds.warn) weak.push(dimension);
	}
	const outcome = missing.length > 0 ? "refuse" : weak.length > 0 ? "warn" : "pass";
	return { outcome, probabilities, missing, weak };
}

// ---------------------------------------------------------------------------
// Triage: per-finding severity after a review harvest.

export const TRIAGE_LABELS = ["blocker", "style", "ignore"] as const;
export type TriageLabel = (typeof TRIAGE_LABELS)[number];

export interface TriageFinding {
	axis: "standards" | "spec";
	label: string;
	file?: string;
	line?: number;
	quote?: string;
}

export interface TriageVerdict {
	index: number;
	choice: TriageLabel;
	confidence: number;
	/** Confidence under the floor: the model should read this finding itself. */
	uncertain: boolean;
}

export function buildTriageContext(findings: TriageFinding[]): ClassifierContext {
	const questions: Record<string, ClassifierQuestion> = {};
	findings.forEach((_finding, index) => {
		questions[`f${index}`] = {
			type: "choice",
			instructions: `Classify the code-review finding at \`findings[${index}]\` by its power to block merging the change it was raised on.`,
			criteria: {
				blocker: "must fix before merge: correctness, security, or a violation of a documented interface rule",
				style: "cosmetic or convention-only; fix opportunistically",
				ignore: "subjective or no effect on behaviour",
			},
		};
	});
	// Plain JSON state: the classifier sees exactly the fields it needs.
	const state = {
		findings: findings.map((finding) => ({
			axis: finding.axis,
			label: finding.label,
			...(finding.file !== undefined ? { file: finding.file } : {}),
			...(finding.line !== undefined ? { line: finding.line } : {}),
			...(finding.quote !== undefined ? { quote: finding.quote } : {}),
		})),
	};
	return { state: state as unknown as ClassifierContext["state"], questions };
}

export function interpretTriage(
	answers: Record<string, ClassifierAnswer>,
	count: number,
	confidenceFloor: number,
): TriageVerdict[] {
	const verdicts: TriageVerdict[] = [];
	for (let index = 0; index < count; index += 1) {
		const answer = answers[`f${index}`];
		const choice = answer?.type === "choice" && (TRIAGE_LABELS as readonly string[]).includes(answer.choice) ? (answer.choice as TriageLabel) : "ignore";
		const confidence = answer?.type === "choice" ? answer.confidence : 0;
		verdicts.push({ index, choice, confidence, uncertain: confidence < confidenceFloor });
	}
	return verdicts;
}

/** The counts a harvest note reports about a triage. */
export interface TriageSummary {
	blockers: number;
	style: number;
	ignore: number;
	uncertain: number;
}

/**
 * Count a triage for the harvest note.
 *
 * The arithmetic it replaces was `total - blockers - uncertain`, which charged a
 * verdict that is both a blocker and low-confidence twice and printed a negative
 * style count (seen live: "1 blocker, style -1"). Blocker, style, and ignore
 * partition the findings and sum to the total; uncertain crosses that partition,
 * so it is its own number and never a subtraction.
 */
export function summarizeTriage(records: TriageRecord[]): TriageSummary {
	const count = (choice: string) => records.filter((record) => record.choice === choice).length;
	return {
		blockers: count("blocker"),
		style: count("style"),
		ignore: count("ignore"),
		uncertain: records.filter((record) => record.uncertain).length,
	};
}

/** The findings a human should read before the loop acts on them. */
export function uncertainIndices(records: TriageRecord[]): number[] {
	return records.filter((record) => record.uncertain).map((record) => record.index);
}
