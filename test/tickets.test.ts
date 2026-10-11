import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claimTicket, CLAIMED, DONE, parseTicket, READY, setStatus } from "../extensions/lib/tickets.ts";

const TICKET = `# 03: Token refresh

**What to build:** the client refreshes an expired token once, then retries.

**Blocked by:** None (can start immediately).

**Status:** ${READY}

- [ ] An expired token triggers exactly one refresh.
- [ ] A failed refresh surfaces the original error.
`;

test("parseTicket reads the number, the title, and the status", () => {
	const ticket = parseTicket(TICKET, "/x/03-token-refresh.md");
	assert.equal(ticket.id, "03");
	assert.equal(ticket.title, "Token refresh");
	assert.equal(ticket.status, READY);
});

test("parseTicket survives a bold status, a heading without a number, and neither", () => {
	assert.equal(parseTicket("# t\n\n**Status:** done\n", "x.md").status, "done");
	assert.equal(parseTicket("# no number here\n", "07-thing.md").id, "07");
	assert.equal(parseTicket("# no number here\n", "07-thing.md").title, "no number here");
	assert.equal(parseTicket("# plain\n", "weird-name.md").id, "weird-name");
	assert.deepEqual(parseTicket("body only\n", "08-slug.md").status, "");
});

test("setStatus rewrites only the value, and keeps the rest of the file byte for byte", () => {
	const claimed = setStatus(TICKET, CLAIMED);
	assert.match(claimed, /\*\*Status:\*\* claimed/);
	// The bold markers, the criteria, and the blocked-by line all survive.
	assert.match(claimed, /- \[ \] A failed refresh surfaces the original error\./);
	assert.match(claimed, /\*\*Blocked by:\*\* None \(can start immediately\)\./);
	assert.equal(claimed.replace(CLAIMED, READY), TICKET);
});

test("setStatus accepts an unbolded status line", () => {
	const text = "# 9: t\n\nStatus: ready-for-agent\n";
	assert.equal(setStatus(text, DONE), "# 9: t\n\nStatus: done\n");
});

test("setStatus adds a line when the ticket has none, so a ticket is never unclaimable", () => {
	const text = "# 09: A ticket with no status\n\nBody.\n";
	const updated = setStatus(text, CLAIMED);
	assert.match(updated, /\*\*Status:\*\* claimed/);
	assert.match(updated, /Body\./);
});

test("claimTicket claims a ready ticket once, and refuses the second claim", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-tickets-"));
	try {
		const path = join(dir, "03-token-refresh.md");
		writeFileSync(path, TICKET, "utf8");

		const first = claimTicket(path);
		assert.equal(first.ok, true);
		assert.equal(first.ticket?.id, "03");
		assert.equal(parseTicket(readFileSync(path, "utf8"), path).status, CLAIMED);

		// The second caller is the race this exists to stop: one ticket, one job.
		const second = claimTicket(path);
		assert.equal(second.ok, false);
		assert.match(second.error ?? "", /not claimable/);
		assert.match(second.error ?? "", /claimed/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("claimTicket refuses a ticket with no status line, naming the reason", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fleet-tickets-"));
	try {
		const path = join(dir, "no-status.md");
		writeFileSync(path, "# t\n\nbody\n", "utf8");
		const result = claimTicket(path);
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /no Status line/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("claimTicket refuses a missing file and reports the path", () => {
	const result = claimTicket("/nowhere/at/all/03.md");
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /no ticket file at/);
});
