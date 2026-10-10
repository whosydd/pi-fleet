import assert from "node:assert/strict";
import test from "node:test";
import { findGitHazard, parseGitCall, splitSegments } from "../extensions/lib/gitguard.ts";

test("gitguard: splitSegments cuts on unquoted separators only", () => {
	assert.deepEqual(splitSegments("git add -A && git commit -m 'fix && ship'"), ["git add -A", "git commit -m 'fix && ship'"]);
	assert.deepEqual(splitSegments("git status; git stash list"), ["git status", "git stash list"]);
	assert.deepEqual(splitSegments("git stash\n  pop"), ["git stash", "pop"]);
});

test("gitguard: parseGitCall skips global flags and their values", () => {
	assert.deepEqual(parseGitCall("git -C /wt/x --no-pager stash push"), { subcommand: "stash", rest: ["push"] });
	assert.deepEqual(parseGitCall("git -c core.editor=vim commit --amend"), { subcommand: "commit", rest: ["--amend"] });
	assert.deepEqual(parseGitCall("git --git-dir=/x/.git push -f"), { subcommand: "push", rest: ["-f"] });
	assert.equal(parseGitCall("npm run check"), undefined);
});

test("gitguard: stash is a hazard in any position", () => {
	for (const command of ["git stash", "git stash push -m wip", "cd /wt && git stash pop", "sudo git stash drop", "GIT_DIR=/x git stash"]) {
		const hazard = findGitHazard(command);
		assert.equal(hazard?.id, "git-stash", command);
		assert.ok(hazard && hazard.reason.includes("refs/stash"), command);
		assert.ok(hazard && hazard.alternative.length > 0, command);
	}
});

test("gitguard: amend and force push are hazards; plain commit and push are not", () => {
	assert.equal(findGitHazard("git commit --amend -m x")?.id, "commit-amend");
	assert.equal(findGitHazard("git add -A; git commit --amend")?.id, "commit-amend");
	assert.equal(findGitHazard("git push -f origin main")?.id, "force-push");
	assert.equal(findGitHazard("git push --force-with-lease")?.id, "force-push");
	assert.equal(findGitHazard("git push --no-verify"), undefined);
	assert.equal(findGitHazard("git commit -m 'add the login form'"), undefined);
	assert.equal(findGitHazard("git push"), undefined);
});

test("gitguard: a quoted word never reads as a subcommand", () => {
	assert.equal(findGitHazard('git commit -m "stash the old files and --amend later"'), undefined);
	assert.equal(findGitHazard('git log --grep="git stash"'), undefined);
	assert.equal(findGitHazard('echo "git push --force" && git status'), undefined);
});

test("gitguard: only the worktree-safe git commands pass", () => {
	for (const command of [
		"git worktree add /wt/x -b fleet/42",
		"git -C /wt/x checkout -b fleet/42",
		"git diff main..HEAD",
		"git log --oneline -5",
		"git worktree remove /wt/x",
		"npm run check && git status",
	]) {
		assert.equal(findGitHazard(command), undefined, command);
	}
});
