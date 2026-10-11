#!/usr/bin/env node
/**
 * Install the upstream skills into one project, filtered to the planning set.
 *
 * Why this exists rather than a line in the README.
 *
 * The upstream repository publishes 38 skills and no `pi` manifest, so installing
 * it as a package loads every one of them: `code-review`, `tdd`, `research`,
 * `prototype`, and the rest of the execution set land in the orchestrator's
 * context, and a harness that can load `tdd` will implement instead of
 * dispatching. The repository cannot be filtered by its own manifest, because it
 * has none. So the filter has to live in the installing project's settings.
 *
 * Two details of the filter are not guessable and were found by experiment:
 *
 *   - patterns are matched against the path relative to the package root, so a
 *     pattern must read `skills/engineering/to-tickets`;
 *   - a leading `./` is NOT stripped before matching, so `./skills/engineering/
 *     to-tickets` silently matches nothing. A wrong pattern fails silently: the
 *     skill simply does not load and no diagnostic is produced. That is why the
 *     list comes from `skills/manifest.json` rather than from a human's memory,
 *     and why `--check` exists.
 *
 * Usage:
 *   node scripts/install-planning.mjs [--target DIR] [--pi-bin PATH]
 *   node scripts/install-planning.mjs --check [--target DIR]
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(packageRoot, "skills", "manifest.json"), "utf8"));

const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const target = resolve(valueOf("--target") ?? process.cwd());
const piBin = valueOf("--pi-bin") ?? "pi";
const settingsPath = join(target, ".pi", "settings.json");

function valueOf(flag) {
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
}

function fail(message) {
	console.error(`install-planning: ${message}`);
	process.exit(1);
}

/**
 * The settings entry that installs upstream and loads only the planning set.
 *
 * `extensions`, `prompts`, and `themes` are empty rather than absent: an absent
 * property loads everything the package publishes, and the upstream repository
 * publishes no such directories today but should not be trusted to keep it that
 * way.
 */
function desiredEntry() {
	return {
		source: manifest.upstream.repository,
		extensions: [],
		// The `./` is deliberately absent. See the header.
		skills: manifest.planning.map((path) => `skills/${path}`),
		prompts: [],
		themes: [],
	};
}

function readSettings() {
	if (!existsSync(settingsPath)) return {};
	try {
		return JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch (error) {
		fail(`${settingsPath} is not JSON: ${error.message}`);
	}
}

/** Replace this repository's entry, keep every other package, and keep its order. */
function mergeEntry(settings, entry) {
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	const others = packages.filter((item) => (typeof item === "string" ? item : item?.source) !== entry.source);
	return { ...settings, packages: [entry, ...others] };
}

function sameEntry(settings) {
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	const existing = packages.find((item) => (typeof item === "string" ? item : item?.source) === manifest.upstream.repository);
	if (existing === undefined || typeof existing === "string") return false;
	return JSON.stringify(existing) === JSON.stringify(desiredEntry());
}

/**
 * The clone lives inside the project, and it is not source: committing it would
 * put a second copy of upstream in this repository's history.
 */
function ignoreClone(dir) {
	const path = join(dir, ".gitignore");
	const line = ".pi/git/";
	try {
		const content = existsSync(path) ? readFileSync(path, "utf8") : "";
		if (content.split(/\r?\n/).some((entry) => entry.trim() === line)) return false;
		appendFileSync(path, `${content === "" || content.endsWith("\n") ? "" : "\n"}${line}\n`, "utf8");
		return true;
	} catch (error) {
		console.warn(`install-planning: could not update ${path} (${error.message}); add "${line}" by hand`);
		return false;
	}
}

function main() {
	if (!manifest.planning?.length) fail("skills/manifest.json has no planning list");
	const settings = readSettings();
	const entry = desiredEntry();

	if (checkOnly) {
		if (sameEntry(settings)) {
			console.log(`install-planning: ${settingsPath} already installs upstream filtered to ${entry.skills.length} planning skill(s)`);
			return;
		}
		console.error(
			`install-planning: ${settingsPath} does not match skills/manifest.json.\n` +
				`  Expected the entry for ${entry.source} to declare exactly:\n${entry.skills.map((path) => `    ${path}`).join("\n")}\n` +
				"  Run `npm run install-planning` in this project, or fix the list by hand.",
		);
		process.exit(1);
	}

	// Install first, so the clone exists and pi owns its own bookkeeping. Then
	// replace the entry with the filtered form.
	try {
		execFileSync(piBin, ["install", "-l", manifest.upstream.repository], { cwd: target, stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.toString().trim();
		fail(`${piBin} install -l ${manifest.upstream.repository} failed in ${target}${detail ? `: ${detail}` : ""}`);
	}

	const merged = mergeEntry(readSettings(), entry);
	writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

	console.log(`install-planning: wrote ${settingsPath}`);
	console.log(`  installed ${entry.source} project-locally, filtered to ${entry.skills.length} planning skill(s):`);
	for (const path of entry.skills) console.log(`    ${path}`);
	console.log("  no global settings were touched");
	if (ignoreClone(target)) console.log(`  added .pi/git/ to ${join(target, ".gitignore")}`);
	console.log("  the upstream clone and the settings entry are project-local; commit .pi/settings.json, not .pi/git/");
	console.log("\nVerify from inside pi: the available skills should list the planning set and no execution skill.");
}

main();
