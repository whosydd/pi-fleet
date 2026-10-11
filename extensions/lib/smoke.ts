/**
 * The decisions the headless load smoke test makes, kept away from pi's loader.
 *
 * `smoke/load.ts` supplies the observations: the extensions and load errors the
 * loader produced, the session's active tools, and the skills found on disk. This
 * module says which observations pass. That keeps every decision testable without
 * constructing a loader or an agent session.
 */

export const FLEET_TOOLS = ["FleetDispatch", "FleetHarvest", "FleetStatus", "FleetCleanup"] as const;

export interface LoadedExtension {
	path: string;
	resolvedPath: string;
	toolNames: string[];
}

export interface LoadError {
	path: string;
	error: string;
}

export interface LoadedTool {
	name: string;
	sourceInfo: { path: string };
}

export interface SmokeInput {
	entry: string;
	extensions: LoadedExtension[];
	loadErrors: LoadError[];
	activeToolNames: string[];
	tools: LoadedTool[];
	skillNames: string[];
	skillDiagnostics: string[];
	vendoredSkillSets: string[];
	sessionError?: string;
}

export interface SmokeDecision {
	ok: boolean;
	failures: string[];
	entryExtensions: LoadedExtension[];
	activeToolsFromEntry: string[];
	skillNames: string[];
}

export function judgeSmoke(input: SmokeInput): SmokeDecision {
	const failures: string[] = [];
	const entryExtensions = input.extensions.filter((extension) => extension.resolvedPath === input.entry);
	if (entryExtensions.length !== 1) failures.push(`expected one extension at ${input.entry}, found ${entryExtensions.length}`);

	const entryErrors = input.loadErrors.filter((error) => error.path === input.entry);
	if (entryErrors.length > 0) {
		failures.push(`entry under test failed to load: ${entryErrors.map((error) => error.error).join("; ")}`);
	}
	if (input.sessionError !== undefined) failures.push(`session creation failed: ${input.sessionError}`);

	const active = new Set(input.activeToolNames);
	const activeToolsFromEntry = FLEET_TOOLS.filter(
		(name) => active.has(name) && input.tools.some((tool) => tool.name === name && tool.sourceInfo.path === input.entry),
	);
	const missing = FLEET_TOOLS.filter((name) => !activeToolsFromEntry.includes(name));
	if (missing.length > 0) failures.push(`fleet tools not active from ${input.entry}: ${missing.join(", ")}`);

	const skillNames = [...input.skillNames].sort();
	if (skillNames.length !== 1 || skillNames[0] !== "fleet") {
		failures.push(`expected exactly the fleet skill, found: ${skillNames.join(", ") || "(none)"}`);
	}
	if (input.skillDiagnostics.length > 0) failures.push(`fleet skill diagnostics: ${input.skillDiagnostics.join("; ")}`);
	for (const side of input.vendoredSkillSets) {
		failures.push(`skills/${side} exists: both upstream sets must be installed or provided elsewhere, not vendored here`);
	}

	return { ok: failures.length === 0, failures, entryExtensions, activeToolsFromEntry, skillNames };
}
