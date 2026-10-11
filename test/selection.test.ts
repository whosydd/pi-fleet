import assert from "node:assert/strict";
import test from "node:test";
import { defaultExecutor } from "../extensions/lib/selection.ts";
import type { JobMeta } from "../extensions/lib/types.ts";

function build(ticket: string, executor: "codex" | "claude", at = 0): JobMeta {
	return { ticket, role: "implement", executor, startedAt: at } as JobMeta;
}

test("an implementation defaults to codex", () => {
	assert.equal(defaultExecutor("implement", [], "03"), "codex");
	assert.equal(defaultExecutor("implement", [build("03", "claude")], "03"), "codex", "the default does not follow the previous job");
});

test("a review runs on the harness that did not write the code", () => {
	assert.equal(defaultExecutor("review", [build("03", "codex")], "03"), "claude");
	assert.equal(defaultExecutor("review", [build("03", "claude")], "03"), "codex");
});

test("the latest implementation decides, because that is the code under review", () => {
	const jobs = [build("03", "claude", 1), build("03", "codex", 2)];
	assert.equal(defaultExecutor("review", jobs, "03"), "claude", "codex wrote the latest one");
});

test("another ticket's build does not decide this ticket's reviewer", () => {
	assert.equal(defaultExecutor("review", [build("04", "claude")], "03"), "claude", "no build on record: nothing to avoid, so the default stands");
});

test("a review job on record does not stand in for a build", () => {
	const jobs = [{ ticket: "03", role: "review", executor: "claude", startedAt: 1 } as JobMeta];
	assert.equal(defaultExecutor("review", jobs, "03"), "claude");
});
