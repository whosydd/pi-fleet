import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSmoke } from "../smoke/load.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageEntry = join(packageRoot, "extensions", "index.ts");

interface Environment {
	cwd: string;
	agentDir: string;
	root: string;
	entry: string;
	dispose(): void;
}

function createEnvironment(extension = ""): Environment {
	const base = mkdtempSync(join(tmpdir(), "pi-fleet-smoke-"));
	const cwd = join(base, "cwd");
	const agentDir = join(base, "agent");
	const root = extension === "" ? packageRoot : join(base, "package");
	const entry = extension === "" ? packageEntry : join(root, "index.ts");
	mkdirSync(cwd, { recursive: true });
	if (extension !== "") mkdirSync(root, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	if (extension !== "") {
		writeFileSync(entry, extension, "utf8");
		cpSync(join(packageRoot, "skills", "fleet"), join(root, "skills", "fleet"), { recursive: true });
	}
	return {
		cwd,
		agentDir,
		root,
		entry,
		dispose: () => rmSync(base, { recursive: true, force: true }),
	};
}

test("the current package loads its entry, all four tools, and the fleet skill", async () => {
	const env = createEnvironment();
	try {
		const result = await runSmoke({ root: env.root, entry: env.entry, cwd: env.cwd, agentDir: env.agentDir });
		assert.equal(result.ok, true, result.failures.join("\n"));
	} finally {
		env.dispose();
	}
});

test("an entry that throws on load fails the smoke test", async () => {
	const env = createEnvironment('export default function entry() {\n\tthrow new Error("BOOM");\n}\n');
	try {
		const result = await runSmoke({ root: env.root, entry: env.entry, cwd: env.cwd, agentDir: env.agentDir });
		assert.equal(result.ok, false);
		assert.match(result.failures.join("\n"), /entry under test failed to load/);
	} finally {
		env.dispose();
	}
});

test("an entry that registers none of the fleet tools fails the smoke test", async () => {
	const env = createEnvironment("export default function entry() {}\n");
	try {
		const result = await runSmoke({ root: env.root, entry: env.entry, cwd: env.cwd, agentDir: env.agentDir });
		assert.equal(result.ok, false);
		assert.match(result.failures.join("\n"), /fleet tools not active from/);
		assert.match(result.failures.join("\n"), /FleetDispatch/);
	} finally {
		env.dispose();
	}
});

test("a missing or empty fleet skill directory fails the smoke test", async () => {
	const base = mkdtempSync(join(tmpdir(), "pi-fleet-smoke-"));
	const cwd = join(base, "cwd");
	const agentDir = join(base, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(base, "skills", "fleet"), { recursive: true });
	try {
		const result = await runSmoke({
			root: base,
			entry: packageEntry,
			cwd,
			agentDir,
		});
		assert.equal(result.ok, false);
		assert.match(result.failures.join("\n"), /expected exactly the fleet skill/);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("a path containing pi-fleet does not stand in for the entry under test", async () => {
	const base = mkdtempSync(join(tmpdir(), "pi-fleet-substring-"));
	const cwd = join(base, "cwd");
	const agentDir = join(base, "agent");
	const root = join(base, "package");
	const entry = join(root, "index.ts");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(root, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(entry, "export default function entry() {}\n", "utf8");
	cpSync(join(packageRoot, "skills", "fleet"), join(root, "skills", "fleet"), { recursive: true });
	try {
		const result = await runSmoke({ root, entry, cwd, agentDir });
		assert.equal(result.ok, false);
		assert.match(result.failures.join("\n"), /fleet tools not active from/);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
