import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureRunsDirIgnored, gitignoreLine, ignoreTarget } from "../extensions/lib/preflight.ts";

test("gitignoreLine reports nothing when the file already covers the entry", () => {
	assert.equal(gitignoreLine(".pi/fleet/\n", ".pi/fleet"), undefined);
	assert.equal(gitignoreLine(".pi/fleet\n", ".pi/fleet"), undefined);
	// A wider pattern that happens to cover it is still a covered entry only when
	// it is the entry: `.pi/` would also hide the committed `.pi/settings.json`.
	assert.equal(gitignoreLine(".pi/\n", ".pi/fleet"), ".pi/fleet/");
	assert.equal(gitignoreLine("", ".pi/fleet"), ".pi/fleet/");
	assert.equal(gitignoreLine("node_modules\n", ".pi/fleet"), ".pi/fleet/");
	assert.equal(gitignoreLine("  .pi/fleet/  \n", ".pi/fleet"), undefined, "surrounding space is ignored");
	assert.equal(gitignoreLine(".pi/fleet/runs/\n", ".pi/fleet"), ".pi/fleet/", "a deeper entry does not cover the parent");
});

test("gitignoreLine returns a trailing-slash entry and refuses an empty one", () => {
	// The trailing slash says "directory", which is what the fleet writes.
	assert.equal(gitignoreLine("", "runs"), "runs/");
	assert.equal(gitignoreLine("", "runs/"), "runs/");
	assert.equal(gitignoreLine("", "   "), undefined);
	assert.equal(gitignoreLine("", ""), undefined);
});

test("ignoreTarget owns the fleet directory, not only the runs inside it", () => {
	// The default layout: `.pi/fleet` is ignored so a later release can keep other
	// state beside `runs` without the project learning a new line.
	assert.equal(ignoreTarget("/repo", "/repo/.pi/fleet/runs"), ".pi/fleet");
	// A configured runs directory elsewhere is ignored as the directory it is.
	assert.equal(ignoreTarget("/repo", "/repo/other/runs"), "other/runs");
	assert.equal(ignoreTarget("/repo", "/repo/runs"), "runs");
});

test("ignoreTarget leaves a directory outside the project alone", () => {
	// Another project's git status cannot show these files, so its .gitignore is
	// not this package's to edit.
	assert.equal(ignoreTarget("/repo", "/elsewhere/.pi/fleet/runs"), undefined);
	assert.equal(ignoreTarget("/repo", "/repo/../elsewhere/runs"), undefined);
	assert.equal(ignoreTarget("/repo", "/repo"), undefined);
});

test("ensureRunsDirIgnored appends once and leaves the rest of the file intact", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-ignore-"));
	try {
		writeFileSync(join(dir, ".gitignore"), "node_modules\n*.log\n", "utf8");

		const first = ensureRunsDirIgnored(dir, join(dir, ".pi/fleet/runs"));
		assert.equal(first.appended, ".pi/fleet/");
		assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "node_modules\n*.log\n.pi/fleet/\n");

		// A second dispatch into the same project must not append a duplicate.
		assert.deepEqual(ensureRunsDirIgnored(dir, join(dir, ".pi/fleet/runs")), {});
		assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "node_modules\n*.log\n.pi/fleet/\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ensureRunsDirIgnored starts a file that does not exist, and keeps a missing newline", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-ignore-"));
	try {
		assert.equal(ensureRunsDirIgnored(dir, join(dir, ".pi/fleet/runs")).appended, ".pi/fleet/");
		assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), ".pi/fleet/\n");

		const noNewline = mkdtempSync(join(tmpdir(), "pi-fleet-ignore-"));
		try {
			writeFileSync(join(noNewline, ".gitignore"), "dist", "utf8");
			ensureRunsDirIgnored(noNewline, join(noNewline, ".pi/fleet/runs"));
			// "dist.pi/fleet/" would be a pattern matching nothing.
			assert.equal(readFileSync(join(noNewline, ".gitignore"), "utf8"), "dist\n.pi/fleet/\n");
		} finally {
			rmSync(noNewline, { recursive: true, force: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unwritable .gitignore is a note, never a failed dispatch", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-ignore-"));
	try {
		const path = join(dir, ".gitignore");
		writeFileSync(path, "node_modules\n", "utf8");
		chmodSync(path, 0o444);
		const fix = ensureRunsDirIgnored(dir, join(dir, ".pi/fleet/runs"));
		// Running as root ignores the mode bit, so accept either outcome and assert
		// only that nothing threw and no line was invented.
		assert.equal(fix.error === undefined || typeof fix.error === "string", true);
		assert.equal(readFileSync(path, "utf8"), "node_modules\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
