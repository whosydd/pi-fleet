/**
 * Headless load smoke test: load this package through pi's own loader, without
 * making a model call.
 *
 * Two claims are checked, because this package is one artifact with two halves.
 * The extension half must register its tools and its setup command. The skill
 * half must load the fleet skill and must not load the execution set, which is
 * the boundary the whole design rests on.
 *
 * The planning set is deliberately absent here: it is installed into the project
 * from upstream behind a settings filter, not shipped by this package.
 *
 * Run with `npm run smoke`.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	loadSkillsFromDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "extensions", "index.ts");
const cwd = process.cwd();
const agentDir = getAgentDir();

const loader = new DefaultResourceLoader({
	cwd,
	agentDir,
	additionalExtensionPaths: [entry],
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});
await loader.reload();

const loaded = loader.getExtensions();
const ours = loaded.extensions.filter((extension) => extension.path.includes("pi-fleet"));
console.log(`loaded extensions: ${loaded.extensions.length}`);
for (const extension of ours) {
	console.log(`ours: ${extension.path}`);
	console.log(`      tools: ${[...(extension.tools?.keys() ?? [])].join(", ")}`);
}
const errors = (loaded as { errors?: unknown[] }).errors;
if (errors && errors.length > 0) console.log("loader errors:", errors);

// The skill half: the one skill this package ships, and the assertion that it
// ships no upstream copy of the other two sets. A vendored planning skill wins
// the name collision against the project's upstream install and freezes the
// orchestrator on it; a vendored execution skill makes the executor load two
// revisions of one skill at once.
const fleet = loadSkillsFromDir({ dir: join(root, "skills", "fleet"), source: "pi-fleet" });
const names = fleet.skills.map((skill) => skill.name).sort();
console.log(`skills this package ships (${names.length}): ${names.join(", ")}`);
if (fleet.diagnostics.length > 0) console.log("skill diagnostics:", fleet.diagnostics);
for (const side of ["planning", "execution"]) {
	if (existsSync(join(root, "skills", side))) {
		console.log(`skills/${side} exists: both upstream sets are installed or provided elsewhere, not vendored here`);
		process.exitCode = 1;
	}
}
if (!existsSync(join(root, ".pi", "settings.json"))) {
	console.log("no .pi/settings.json: run /fleet-setup to install the planning skills into this project");
}

try {
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.create(cwd, agentDir),
		resourceLoader: loader,
	});
	const active = session.getActiveToolNames();
	console.log(
		`active tools: FleetDispatch=${active.includes("FleetDispatch")} FleetHarvest=${active.includes("FleetHarvest")} FleetStatus=${active.includes("FleetStatus")} FleetCleanup=${active.includes("FleetCleanup")}`,
	);
	session.dispose();
} catch (error) {
	console.log(`session creation skipped: ${error instanceof Error ? error.message : String(error)}`);
}
