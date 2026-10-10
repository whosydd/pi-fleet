/**
 * Preflight fixes are the one place a dispatch writes into someone else's
 * checkout, so they are tested on a real temp dir: no spawn, no model call,
 * no network — just the file it touches.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureStateDirIgnored, inspectNodeDeps } from "../extensions/lib/preflight.ts";

function worktree(): string {
	return mkdtempSync(join(tmpdir(), "pi-fleet-ignore-"));
}

test("a worktree missing the entry gets exactly one line, and a second dispatch adds nothing", () => {
	const dir = worktree();
	try {
		writeFileSync(join(dir, ".gitignore"), "node_modules/\n*.log\n", "utf8");

		const first = ensureStateDirIgnored(dir, ".fleet");
		assert.equal(first.appended, ".fleet/");
		assert.equal(first.error, undefined);
		assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "node_modules/\n*.log\n.fleet/\n");

		const second = ensureStateDirIgnored(dir, ".fleet");
		assert.equal(second.appended, undefined);
		assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "node_modules/\n*.log\n.fleet/\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a checkout with no .gitignore gets one created", () => {
	const dir = worktree();
	try {
		const fix = ensureStateDirIgnored(dir, ".fleet");
		assert.equal(fix.appended, ".fleet/");
		assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), ".fleet/\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a .gitignore without a trailing newline still gets one clean line", () => {
	const dir = worktree();
	try {
		writeFileSync(join(dir, ".gitignore"), "node_modules/", "utf8");
		ensureStateDirIgnored(dir, ".fleet");
		assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "node_modules/\n.fleet/\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a state dir already listed without a slash is left alone", () => {
	const dir = worktree();
	try {
		writeFileSync(join(dir, ".gitignore"), ".fleet\n", "utf8");
		assert.equal(ensureStateDirIgnored(dir, ".fleet").appended, undefined);
		assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), ".fleet\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a PI_FLEET_STATE_DIR outside the worktree changes nothing", () => {
	const dir = worktree();
	try {
		const outside = join(tmpdir(), "pi-fleet-state-elsewhere", ".fleet");
		assert.equal(ensureStateDirIgnored(dir, outside).appended, undefined);
		assert.equal(existsSync(join(dir, ".gitignore")), false);
		// A nested state dir is still inside: its basename is the entry.
		mkdirSync(join(dir, "var"), { recursive: true });
		assert.equal(ensureStateDirIgnored(dir, "var/fleet-state").appended, "fleet-state/");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dependency prep is reported, never fixed", () => {
	// A non-Node checkout is not the fleet's question at all.
	const plain = mkdtempSync(join(tmpdir(), "pi-fleet-deps-plain-"));
	try {
		assert.equal(inspectNodeDeps(plain), "not-node");
	} finally {
		rmSync(plain, { recursive: true, force: true });
	}

	// A worktree with no dependencies: say so before the executor spends a round.
	const bare = mkdtempSync(join(tmpdir(), "pi-fleet-deps-bare-"));
	try {
		writeFileSync(join(bare, "package.json"), "{}");
		const state = inspectNodeDeps(bare);
		assert.equal(typeof state, "object");
		assert.equal((state as { state: string }).state, "missing");
		assert.match((state as { hint: string }).hint, /node_modules/);
	} finally {
		rmSync(bare, { recursive: true, force: true });
	}

	// A symlink with only `node_modules/` in .gitignore reads as untracked work.
	const linked = mkdtempSync(join(tmpdir(), "pi-fleet-deps-link-"));
	try {
		writeFileSync(join(linked, "package.json"), "{}");
		const target = mkdtempSync(join(tmpdir(), "pi-fleet-deps-target-"));
		symlinkSync(target, join(linked, "node_modules"));
		writeFileSync(join(linked, ".gitignore"), "node_modules/\n");
		const state = inspectNodeDeps(linked);
		assert.equal((state as { state: string }).state, "untracked-link");
		// The bare name covers a link, so the note goes away once it is ignored.
		writeFileSync(join(linked, ".gitignore"), "node_modules\n");
		assert.deepEqual(inspectNodeDeps(linked), { state: "ready" });
		rmSync(target, { recursive: true, force: true });
	} finally {
		rmSync(linked, { recursive: true, force: true });
	}
});
