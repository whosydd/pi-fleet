import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ROLE_SKILLS } from "../extensions/lib/brief.ts";
import { PACKAGE_ROOT } from "../extensions/lib/skills.ts";
import { readSettings } from "../extensions/lib/types.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(packageRoot, "skills", "manifest.json"), "utf8")) as {
	upstream: { repository: string; ref: string };
	planning: string[];
	execution: string[];
	excluded: Record<string, string>;
};
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { pi: { extensions: string[]; skills: string[] } };

function skillNames(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((entry) => existsSync(join(dir, entry, "SKILL.md")))
		.sort();
}

test("this package ships exactly one skill, and it is not from upstream", () => {
	// The upstream sets are installed into the project (planning) or provided by
	// the executor's own harness (execution). Shipping a second copy of either is
	// what this design removes: a vendored planning copy wins the name collision
	// and freezes the orchestrator, and a vendored execution copy makes the
	// executor load two revisions of one skill at once.
	const declared = pkg.pi.skills.map((entry) => entry.replace(/^\.\//, ""));
	assert.deepEqual(declared, ["skills/fleet"]);
	assert.deepEqual(skillNames(join(packageRoot, "skills")), ["fleet"]);
	assert.equal(existsSync(join(packageRoot, "skills", "planning")), false);
	assert.equal(existsSync(join(packageRoot, "skills", "execution")), false);
});

test("the names a role uses are the names the manifest records", () => {
	const named = [...new Set([...ROLE_SKILLS.implement, ...ROLE_SKILLS.review])].sort();
	assert.deepEqual(named, ["code-review", "tdd"]);
	// The task text names these skills; `execution` records the upstream paths those
	// names come from. Nothing compares either side to upstream (see AGENTS.md), so
	// this test pins the half the package can check offline: that the two agree.
	assert.deepEqual(manifest.execution.map((path) => path.split("/").at(-1)).sort(), named);
});

test("the upstream implementation skill is not named, because it would reinstate the self-review", () => {
	// Its six instructions are covered by the task text and the contract, except
	// the one that invokes the upstream review skill inside the run that wrote the
	// code — which is exactly what the cross-harness review exists to avoid.
	assert.equal([...ROLE_SKILLS.implement, ...ROLE_SKILLS.review].includes("implement"), false);
	assert.ok(manifest.excluded["engineering/implement"], "implement stays on record, with the reason it is not used");
	assert.equal(
		manifest.execution.some((path) => path.split("/").at(-1) === "implement"),
		false,
		"it is not one of the names a role may ask for",
	);
});

const sharedReasons = new Map(Object.entries(manifest.excluded).filter(([key]) => key.startsWith("$")));
const expectedSharedReasons = {
	"$executor-provides": {
		users: [
			"engineering/codebase-design",
			"engineering/diagnosing-bugs",
			"engineering/improve-codebase-architecture",
			"engineering/pr",
			"engineering/prototype",
			"engineering/research",
			"engineering/retro",
			"engineering/wizard",
		],
	},
	"$writing-prose": {
		users: ["in-progress/writing-beats", "in-progress/writing-fragments", "in-progress/writing-shape"],
	},
	"$project-scaffold": {
		users: ["in-progress/setup-ts-deep-modules", "misc/setup-pre-commit"],
	},
};

function exclusionReason(value: string): string | undefined {
	return value.startsWith("$") ? sharedReasons.get(value) : value;
}

test("a repeated exclusion reason is written once, and every entry that used it points at it", () => {
	// The manifest collapsed eight, three and two entries onto one shared sentence
	// each. Two choices below are deliberate and easy to undo by accident, which is
	// why they are the ones that carry a reason. `raw` counts the sentence in the
	// file text, because a sentence written out twice parses into a map that looks
	// correct. Both halves of the user list are sorted, so reordering the manifest
	// is not a failure.
	const raw = readFileSync(join(packageRoot, "skills", "manifest.json"), "utf8");
	assert.deepEqual(
		[...sharedReasons.keys()].sort(),
		Object.keys(expectedSharedReasons).sort(),
		"the manifest carries exactly the shared explanations",
	);
	for (const [key, expected] of Object.entries(expectedSharedReasons)) {
		const reason = exclusionReason(key);
		assert.ok(reason && reason.trim().length > 20, `${key} has a usable explanation`);
		assert.equal(raw.split(reason).length - 1, 1, `${key}'s explanation must appear once in the file`);
		const users = Object.entries(manifest.excluded)
			.filter(([path, why]) => path !== key && why === key)
			.map(([path]) => path);
		assert.deepEqual([...users].sort(), [...expected.users].sort(), `${key} must point at exactly its original users`);
	}
	for (const [path, why] of Object.entries(manifest.excluded)) {
		if (path.startsWith("$")) continue;
		if (why.startsWith("$")) assert.ok(sharedReasons.has(why), `${path} points at a reason the manifest does not carry`);
	}
});

test("the manifest classifies the skills this package relies on, with a reason for each exclusion", () => {
	const all = [...manifest.planning, ...manifest.execution];
	assert.equal(new Set(all).size, all.length, "a skill cannot be in both live lists");
	assert.ok(manifest.planning.length > 0 && manifest.execution.length > 0);
	for (const [path, why] of Object.entries(manifest.excluded)) {
		if (path.startsWith("$")) continue;
		const reason = exclusionReason(why);
		assert.ok(reason && reason.trim().length > 20, `${path} is excluded without a usable reason`);
		assert.equal(all.includes(path), false, `${path} is both listed and excluded`);
	}
	for (const path of all) assert.match(path, /^[a-z-]+\/[a-z0-9-]+$/, `${path} is not a <bucket>/<name> upstream path`);
	assert.equal(existsSync(join(packageRoot, "skills", "UPSTREAM.json")), false, "nothing is vendored, so there is no vendored commit to record");
});

test("this repository's own install matches the manifest, so the two cannot drift", () => {
	const settings = JSON.parse(readFileSync(join(packageRoot, ".pi", "settings.json"), "utf8")) as { packages: Array<Record<string, unknown>> };
	const entry = settings.packages.find((item) => item.source === manifest.upstream.repository);
	assert.ok(entry, `.pi/settings.json must install ${manifest.upstream.repository}`);
	// No `./`, which pi does not strip before matching: a leading `./` matches
	// nothing and loads no skill, with no diagnostic.
	assert.deepEqual(entry.skills, manifest.planning.map((path) => `skills/${path}`));
	assert.deepEqual(entry.extensions, [], "an absent property loads everything the package publishes");
	assert.deepEqual(entry.prompts, []);
	assert.deepEqual(entry.themes, []);
});

test("the fleet skill is one pi can load", () => {
	const text = readFileSync(join(PACKAGE_ROOT, "skills", "fleet", "SKILL.md"), "utf8");
	assert.match(text, /^---\r?\n/);
	const front = text.slice(0, text.indexOf("\n---", 3));
	assert.match(front, /^name:\s*fleet$/m);
	assert.match(front, /^description:\s*\S+/m);
});

test("settings come from the environment, and the run root is absolute", () => {
	const settings = readSettings({ PI_FLEET_MAX_FIX_ROUND: "1", PI_FLEET_RUNS_DIR: "tmp fleet" }, "/repo");
	assert.equal(settings.runsDir, "/repo/tmp fleet");
	assert.equal(settings.maxFixRound, 1);
	// A relative run root would resolve against the orchestrator here and against
	// the executor's worktree there, landing on no file. The default lives under
	// `.pi/` because pi's state belongs in pi's own project directory.
	assert.equal(readSettings({}, "/repo").runsDir, "/repo/.pi/fleet/runs");
	assert.equal(readSettings({ PI_FLEET_MAX_FIX_ROUND: "-3" }, "/repo").maxFixRound, 2, "junk falls back");
	assert.equal(readSettings({ PI_FLEET_GIT_GUARD: "off" }, "/repo").gitGuard, false);
	assert.equal(readSettings({}, "/repo").gitGuard, true);
});
