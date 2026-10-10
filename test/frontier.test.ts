import assert from "node:assert/strict";
import test from "node:test";
import { computeFrontier, reportFrontier, type Ticket } from "../extensions/lib/frontier.ts";

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

test("the frontier report names the ready set, the waiters, and every graph problem", () => {
	const tickets = [
		{ id: "1", status: "done" as const },
		{ id: "2", status: "open" as const, blockers: ["1"] },
		{ id: "3", status: "open" as const, blockers: ["2"] },
		{ id: "4", status: "open" as const, blockers: ["nope"] },
	];
	const report = reportFrontier(tickets);
	assert.deepEqual(report.summary, { ready: ["2"], waiting: ["3"], errors: ['ticket "4" blocks on unknown ticket "nope"'] });
	assert.match(report.text, /ready: 2/);
	assert.match(report.text, /waiting: 3/);
	assert.match(report.text, /Graph problems: ticket "4"/, "the unknown ref is reported, not dropped in silence");

	// An empty frontier says so in words: a quiet line must not read as no work.
	const empty = reportFrontier([{ id: "1", status: "in_progress" as const }]);
	assert.match(empty.text, /ready: \(none\)/);
	assert.doesNotMatch(empty.text, /Graph problems/);

	// A cycle comes back as text, never as a throw.
	const looped = reportFrontier([
		{ id: "a", status: "open" as const, blockers: ["b"] },
		{ id: "b", status: "open" as const, blockers: ["a"] },
	]);
	assert.equal(looped.summary.ready.length, 0);
	assert.match(looped.summary.errors.join(" "), /cycle/);
});
