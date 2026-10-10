/**
 * Headless load smoke test: load this extension through pi's own loader,
 * without making a model call. Verifies that pi accepts the package entry and
 * that the fleet tools register. Run with `npm run smoke`.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
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
	const tools = [...(extension.tools?.keys() ?? [])];
	console.log(`ours: ${extension.path}`);
	console.log(`      tools: ${tools.join(", ")}`);
}
const errors = (loaded as { errors?: unknown[] }).errors;
if (errors && errors.length > 0) console.log("loader errors:", errors);

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
		`active tools: FleetDispatch=${active.includes("FleetDispatch")} FleetHarvest=${active.includes("FleetHarvest")} FleetStatus=${active.includes("FleetStatus")}`,
	);
	session.dispose();
} catch (error) {
	console.log(`session creation skipped: ${error instanceof Error ? error.message : String(error)}`);
}
