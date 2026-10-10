import assert from "node:assert/strict";
import test from "node:test";
import { computeFrontier, type Ticket } from "../extensions/lib/frontier.ts";

const t = (id: string, status: Ticket["status"], blockers?: string[]): Ticket => ({ id, status, blockers });

test("open tickets with all-done blockers are ready", () => {
	const result = computeFrontier([t("a", "done"), t("b", "done"), t("c", "open", ["a", "b"]), t("d", "open", ["c"])]);
	assert.deepEqual(result.ready.map((ticket) => ticket.id), ["c"]);
	assert.deepEqual(result.waiting.map((ticket) => ticket.id), ["d"]);
	assert.deepEqual(result.errors, []);
});

test("no blockers means immediately ready", () => {
	const result = computeFrontier([t("solo", "open")]);
	assert.deepEqual(result.ready.map((ticket) => ticket.id), ["solo"]);
});

test("closed tickets never appear as ready", () => {
	const result = computeFrontier([t("a", "open"), t("b", "failed", ["a"]), t("c", "in_progress", ["a"])]);
	assert.deepEqual(result.ready.map((ticket) => ticket.id), ["a"]);
});

test("unknown blocker refs are reported and the ticket is held back", () => {
	const result = computeFrontier([t("a", "open", ["ghost"])]);
	assert.match(result.errors[0], /unknown ticket "ghost"/);
	assert.deepEqual(result.ready, []);
});

test("dependency cycles are reported", () => {
	const result = computeFrontier([t("a", "open", ["b"]), t("b", "open", ["a"])]);
	assert.match(result.errors.join("\n"), /cycle/);
});

test("the implement-spec shape: graph pace over list order", () => {
	const graph = [t("1", "done"), t("2", "done"), t("3", "open", ["1"]), t("4", "open", ["1"]), t("5", "open", ["3", "4"]), t("6", "open", ["2"])];
	const result = computeFrontier(graph);
	assert.deepEqual(result.ready.map((ticket) => ticket.id).sort(), ["3", "4", "6"]);
});
