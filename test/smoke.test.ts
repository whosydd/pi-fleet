import assert from "node:assert/strict";
import test from "node:test";
import { FLEET_TOOLS, judgeSmoke } from "../extensions/lib/smoke.ts";

const entry = "/machine/entry-pi-fleet/extensions/index.ts";

function tool(name: string, path = entry) {
	return { name, sourceInfo: { path } };
}

test("a load from the entry, with all four tools active from it and one fleet skill, succeeds", () => {
	const result = judgeSmoke({
		entry,
		extensions: [{ path: entry, resolvedPath: entry, toolNames: [...FLEET_TOOLS] }],
		loadErrors: [],
		activeToolNames: [...FLEET_TOOLS],
		tools: FLEET_TOOLS.map((name) => tool(name)),
		skillNames: ["fleet"],
		skillDiagnostics: [],
		vendoredSkillSets: [],
	});
	assert.equal(result.ok, true, result.failures.join("\n"));
});

test("an entry that throws on load fails the smoke decision", () => {
	const result = judgeSmoke({
		entry,
		extensions: [],
		loadErrors: [{ path: entry, error: "BOOM" }],
		activeToolNames: [],
		tools: [],
		skillNames: ["fleet"],
		skillDiagnostics: [],
		vendoredSkillSets: [],
	});
	assert.equal(result.ok, false);
	assert.match(result.failures.join("\n"), /entry under test failed to load: BOOM/);
});

test("an entry that registers none of the fleet tools fails the smoke decision", () => {
	const result = judgeSmoke({
		entry,
		extensions: [{ path: entry, resolvedPath: entry, toolNames: [] }],
		loadErrors: [],
		activeToolNames: [],
		tools: [],
		skillNames: ["fleet"],
		skillDiagnostics: [],
		vendoredSkillSets: [],
	});
	assert.equal(result.ok, false);
	assert.match(result.failures.join("\n"), /fleet tools not active from/);
	assert.match(result.failures.join("\n"), /FleetDispatch/);
});

test("a missing or empty fleet skill directory fails the smoke decision", () => {
	const result = judgeSmoke({
		entry,
		extensions: [{ path: entry, resolvedPath: entry, toolNames: [...FLEET_TOOLS] }],
		loadErrors: [],
		activeToolNames: [...FLEET_TOOLS],
		tools: FLEET_TOOLS.map((name) => tool(name)),
		skillNames: [],
		skillDiagnostics: [],
		vendoredSkillSets: [],
	});
	assert.equal(result.ok, false);
	assert.match(result.failures.join("\n"), /expected exactly the fleet skill/);
});

test("a second pi-fleet copy cannot answer for a broken entry under test", () => {
	const other = "/machine/other-pi-fleet/extensions/index.ts";
	const result = judgeSmoke({
		entry,
		extensions: [{ path: other, resolvedPath: other, toolNames: [...FLEET_TOOLS] }],
		loadErrors: [{ path: entry, error: "BOOM" }],
		activeToolNames: [...FLEET_TOOLS],
		tools: FLEET_TOOLS.map((name) => tool(name, other)),
		skillNames: ["fleet"],
		skillDiagnostics: [],
		vendoredSkillSets: [],
	});
	assert.equal(result.ok, false);
	// A substring match would count the other copy and report one extension.
	assert.ok(
		result.failures.includes(`expected one extension at ${entry}, found 0`),
		result.failures.join("\n"),
	);
	assert.match(result.failures.join("\n"), /entry under test failed to load: BOOM/);
	assert.match(result.failures.join("\n"), /fleet tools not active from/);
});
