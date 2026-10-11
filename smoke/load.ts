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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	loadSkillsFromDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { FLEET_TOOLS, judgeSmoke, type LoadedTool, type SmokeDecision, type SmokeInput } from "../extensions/lib/smoke.ts";
import { PACKAGE_ROOT } from "../extensions/lib/skills.ts";

interface SmokeOptions {
	root: string;
	entry: string;
	cwd: string;
	agentDir: string;
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeDecision> {
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
	let sessionError: string | undefined;
	let activeToolNames: string[] = [];
	let tools: LoadedTool[] = [];
	try {
		const { session } = await createAgentSession({
			cwd: options.cwd,
			agentDir: options.agentDir,
			sessionManager: SessionManager.inMemory(options.cwd),
			settingsManager: SettingsManager.create(options.cwd, options.agentDir),
			resourceLoader: loader,
		});
		try {
			activeToolNames = session.getActiveToolNames();
			tools = session.getAllTools();
		} finally {
			session.dispose();
		}
	} catch (error) {
		sessionError = error instanceof Error ? error.message : String(error);
	}

	const fleet = loadSkillsFromDir({ dir: join(options.root, "skills", "fleet"), source: "pi-fleet" });
	const input: SmokeInput = {
		entry: options.entry,
		extensions: loaded.extensions.map((extension) => ({
			path: extension.path,
			resolvedPath: extension.resolvedPath,
			toolNames: [...(extension.tools?.keys() ?? [])],
		})),
		loadErrors: loaded.errors,
		activeToolNames,
		tools,
		skillNames: fleet.skills.map((skill) => skill.name),
		skillDiagnostics: fleet.diagnostics.map((diagnostic) => diagnostic.message),
		vendoredSkillSets: ["planning", "execution"].filter((side) => existsSync(join(options.root, "skills", side))),
		sessionError,
	};
	const decision = judgeSmoke(input);

	console.log(`loaded extensions: ${loaded.extensions.length}`);
	console.log(`entry under test: ${options.entry}`);
	for (const extension of decision.entryExtensions) {
		console.log(`ours: ${extension.path}`);
		console.log(`      tools: ${extension.toolNames.join(", ")}`);
	}
	const otherErrors = loaded.errors.filter((error) => error.path !== options.entry);
	if (otherErrors.length > 0) {
		console.log(`other loader errors: ${otherErrors.map((error) => `${error.path}: ${error.error}`).join("; ")}`);
	}
	console.log(`active tools: ${FLEET_TOOLS.map((name) => `${name}=${activeToolNames.includes(name)}`).join(" ")}`);
	console.log(`active tools from entry: ${decision.activeToolsFromEntry.join(", ")}`);
	console.log(`skills this package ships (${decision.skillNames.length}): ${decision.skillNames.join(", ")}`);

	return decision;
}

function isMain(importPath: string, argvPath: string): boolean {
	return argvPath !== "" && importPath === resolve(argvPath);
}

if (isMain(fileURLToPath(import.meta.url), process.argv[1] ?? "")) {
	const entry = join(PACKAGE_ROOT, "extensions", "index.ts");
	const result = await runSmoke({ root: PACKAGE_ROOT, entry, cwd: process.cwd(), agentDir: getAgentDir() });
	for (const failure of result.failures) console.error(failure);
	if (!result.ok) process.exit(1);
}
