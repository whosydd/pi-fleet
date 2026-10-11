/**
 * Headless load smoke test: load this package through pi's own loader, without
 * making a model call.
 *
 * The smoke test judges the artifact it was pointed at. It fails when the entry
 * under test fails to load, when the session does not activate all four fleet
 * tools from that exact entry, or when the one fleet skill does not load cleanly.
 * It judges the entry by path, not by a substring or another pi-fleet install,
 * so an installed copy cannot answer for this tree. It still forbids vendored
 * upstream skill sets, because a second copy can win a name collision.
 *
 * Run with `npm run smoke`.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	loadSkillsFromDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const FLEET_TOOLS = ["FleetDispatch", "FleetHarvest", "FleetStatus", "FleetCleanup"] as const;

interface SmokeOptions {
	root: string;
	entry: string;
	cwd: string;
	agentDir: string;
}

interface SmokeResult {
	ok: boolean;
	failures: string[];
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
	const failures: string[] = [];
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		additionalExtensionPaths: [options.entry],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();

	const loaded = loader.getExtensions();
	const ours = loaded.extensions.filter((extension) => extension.resolvedPath === options.entry);
	console.log(`loaded extensions: ${loaded.extensions.length}`);
	console.log(`entry under test: ${options.entry}`);
	for (const extension of ours) {
		console.log(`ours: ${extension.path}`);
		console.log(`      tools: ${[...(extension.tools?.keys() ?? [])].join(", ")}`);
	}
	if (ours.length !== 1) failures.push(`expected one extension at ${options.entry}, found ${ours.length}`);
	const entryErrors = loaded.errors.filter((error) => error.path === options.entry);
	if (entryErrors.length > 0) failures.push(`entry under test failed to load: ${entryErrors.map((error) => error.error).join("; ")}`);
	if (loaded.errors.length > entryErrors.length) {
		const others = loaded.errors.filter((error) => error.path !== options.entry);
		console.log(`other loader errors: ${others.map((error) => `${error.path}: ${error.error}`).join("; ")}`);
	}

	// The session is the loadable boundary. A tool can be registered and still
	// fail to be declared to the model, so judge the active list, not the map.
	try {
		const { session } = await createAgentSession({
			cwd: options.cwd,
			agentDir: options.agentDir,
			sessionManager: SessionManager.inMemory(options.cwd),
			settingsManager: SettingsManager.create(options.cwd, options.agentDir),
			resourceLoader: loader,
		});
		const active = new Set(session.getActiveToolNames());
		const allTools = session.getAllTools();
		const oursActive = FLEET_TOOLS.filter((name) => {
			const tool = allTools.find((candidate) => candidate.name === name);
			return active.has(name) && tool?.sourceInfo.path === options.entry;
		});
		console.log(
			`active tools: ${FLEET_TOOLS.map((name) => `${name}=${active.has(name)}`).join(" ")}`,
		);
		console.log(`active tools from entry: ${oursActive.join(", ")}`);
		const missing = FLEET_TOOLS.filter((name) => !oursActive.includes(name));
		if (missing.length > 0) failures.push(`fleet tools not active from ${options.entry}: ${missing.join(", ")}`);
		session.dispose();
	} catch (error) {
		failures.push(`session creation failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	// The skill half: the one skill this package ships, and the assertion that it
	// ships no upstream copy of the other two sets. A vendored planning skill wins
	// the name collision against the project's upstream install and freezes the
	// orchestrator on it; a vendored execution skill makes the executor load two
	// revisions of one skill at once.
	const fleet = loadSkillsFromDir({ dir: join(options.root, "skills", "fleet"), source: "pi-fleet" });
	const names = fleet.skills.map((skill) => skill.name).sort();
	console.log(`skills this package ships (${names.length}): ${names.join(", ")}`);
	if (names.length !== 1 || names[0] !== "fleet") failures.push(`expected exactly the fleet skill, found: ${names.join(", ") || "(none)"}`);
	if (fleet.diagnostics.length > 0) {
		failures.push(`fleet skill diagnostics: ${fleet.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`);
	}
	for (const side of ["planning", "execution"]) {
		if (existsSync(join(options.root, "skills", side))) {
			failures.push(`skills/${side} exists: both upstream sets must be installed or provided elsewhere, not vendored here`);
		}
	}

	return { ok: failures.length === 0, failures };
}

function isMain(importPath: string, argvPath: string): boolean {
	return argvPath !== "" && importPath === resolve(argvPath);
}

if (isMain(fileURLToPath(import.meta.url), process.argv[1] ?? "")) {
	const root = dirname(dirname(fileURLToPath(import.meta.url)));
	const entry = join(root, "extensions", "index.ts");
	const result = await runSmoke({ root, entry, cwd: process.cwd(), agentDir: getAgentDir() });
	for (const failure of result.failures) console.error(failure);
	if (!result.ok) process.exit(1);
}
