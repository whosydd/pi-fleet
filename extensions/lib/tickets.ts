/**
 * The local-markdown ticket tracker, as this package uses it.
 *
 * Pure aside from reading and rewriting one file, which is the only write this
 * package ever makes to the tracker.
 *
 * The conventions come from the tracker document the upstream setup skill
 * writes: one file per ticket under `.scratch/<feature>/issues/<NN>-<slug>.md`,
 * with a `Status:` line near the top. This package supports that medium only.
 * A hosted tracker would move the claim behind an API call, and nothing here is
 * shaped in a way that blocks adding one later.
 *
 * Why the claim lives in code rather than in the skill: two dispatches racing
 * for one ticket is a concurrency bug, and concurrency bugs belong in code.
 * Every other ticket write — ticking acceptance criteria, recording the
 * outcome, closing the ticket — is the orchestrating model's, and it makes
 * those edits with its own file tools.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * The status vocabulary. The upstream `to-tickets` skill publishes
 * `ready-for-agent`; this package adds `claimed` and `done`.
 *
 * `claimed` is what makes the frontier readable from the files alone: a ticket
 * someone is building is neither ready nor done, so a second scan must skip it.
 */
export const READY = "ready-for-agent";
export const CLAIMED = "claimed";
export const DONE = "done";

export interface Ticket {
	/** The tracker's own id: the `NN` prefix, e.g. "03". */
	id: string;
	status: string;
	/** The ticket's title, without the `NN:` prefix. */
	title: string;
}

/**
 * One status line: an optional comment or list marker, the `Status:` label with
 * or without bold markers, the value, and trailing space.
 *
 * Group 1 is the prefix and is preserved verbatim on a rewrite, so a ticket that
 * writes `**Status:**` keeps its bold rather than being reformatted to
 * `Status:` by a claim.
 */
const STATUS_LINE = /^([ \t>*-]*\*{0,2}Status:\*{0,2}[ \t]*)(.+?)[ \t]*$/m;

/** A `# NN: title` or `# title` heading. */
const TITLE_PATTERN = /^#[ \t]+(?:(\d+)[:.][ \t]*)?(.+?)[ \t]*$/m;

/**
 * Read the status and title out of a ticket file.
 *
 * `id` prefers the `NN` in the heading, because that is the id the tracker doc
 * uses for blocking edges, and falls back to the filename prefix. A file with
 * neither still dispatches: it gets the basename, so the contract check can
 * still compare something recognizable.
 */
export function parseTicket(text: string, filename: string): Ticket {
	const status = STATUS_LINE.exec(text)?.[2]?.trim() ?? "";
	const title = TITLE_PATTERN.exec(text);
	return {
		id: title?.[1] ?? filenamePrefix(filename),
		title: title?.[2]?.trim() ?? "",
		status,
	};
}

function filenamePrefix(filename: string): string {
	const name = basename(filename, ".md");
	const match = /^(\d+)/.exec(name);
	return match?.[1] ?? name;
}

/**
 * Rewrite the `Status:` line in place.
 *
 * Everything else in the file is preserved byte for byte, including the heading
 * and the body: an executor's acceptance criteria are the human's record, and a
 * claim that reformatted them would be a ticket edit nobody asked for.
 */
export function setStatus(text: string, status: string): string {
	if (!STATUS_LINE.test(text)) {
		// No status line: add one under the heading rather than leaving the ticket
		// permanently unclaimable.
		return text.replace(TITLE_PATTERN, (heading) => `${heading}\n\n**Status:** ${status}`);
	}
	return text.replace(STATUS_LINE, (_line, prefix: string) => `${prefix}${status}`);
}

export interface ClaimResult {
	ok: boolean;
	error?: string;
	ticket?: Ticket;
}

/**
 * Claim a ticket for one job, or refuse and say why.
 *
 * The check and the write happen in one synchronous block with nothing awaited
 * between them, so within a process no two claims interleave. Two pi processes
 * started by hand at the same moment still have a window; run the fleet from one
 * session, or claim the tickets before starting a second.
 */
export function claimTicket(path: string): ClaimResult {
	if (!existsSync(path)) return { ok: false, error: `no ticket file at ${path}. The tracker medium is local markdown: .scratch/<feature>/issues/<NN>-<slug>.md` };
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return { ok: false, error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
	const ticket = parseTicket(text, path);
	if (ticket.status !== READY) {
		const because = ticket.status === "" ? "it carries no Status line, and this package only claims tickets the tracker published" : `its status is "${ticket.status}"`;
		return { ok: false, error: `ticket ${ticket.id} is not claimable: ${because}. Only "${READY}" tickets are.`, ticket };
	}
	try {
		writeFileSync(path, setStatus(text, CLAIMED), "utf8");
	} catch (error) {
		return { ok: false, error: `cannot claim ticket ${ticket.id}: ${error instanceof Error ? error.message : String(error)}`, ticket };
	}
	return { ok: true, ticket: { ...ticket, status: CLAIMED } };
}
