/**
 * Ticket frontier: pure functions over the task graph the orchestrating model
 * passes in. The tracker (files or issues) stays the source of truth; the
 * extension never owns ticket state, it only reads what it is handed and
 * computes what may start.
 *
 * The orchestrator closes tickets — executors never do. Closing happens in the
 * model's tracker workflow (bash on files, or the tracker CLI); this module
 * only recomputes what a fresh frontier looks like afterwards.
 */

export type TicketStatus = "open" | "in_progress" | "done" | "failed" | "blocked";

export interface Ticket {
	id: string;
	blockers?: string[];
	status: TicketStatus;
}

export interface FrontierResult {
	/** Open tickets whose blockers are all done, ready to dispatch now. */
	ready: Ticket[];
	/** Structural problems: unknown blocker refs and dependency cycles. */
	errors: string[];
	/** Open tickets waiting on at least one not-done blocker. */
	waiting: Ticket[];
}

const DONE_STATUSES: readonly TicketStatus[] = ["done"];

function findCycle(tickets: Map<string, Ticket>): string[] | undefined {
	const visiting = new Set<string>();
	const done = new Set<string>();

	function visit(id: string, path: string[]): string[] | undefined {
		if (done.has(id)) return undefined;
		if (visiting.has(id)) {
			const from = path.indexOf(id);
			return [...path.slice(from === -1 ? 0 : from), id];
		}
		visiting.add(id);
		const ticket = tickets.get(id);
		for (const blocker of ticket?.blockers ?? []) {
			const cycle = visit(blocker, [...path, id]);
			if (cycle) return cycle;
		}
		visiting.delete(id);
		done.add(id);
		return undefined;
	}

	for (const id of tickets.keys()) {
		const cycle = visit(id, []);
		if (cycle) return cycle;
	}
	return undefined;
}

export function computeFrontier(tickets: Ticket[]): FrontierResult {
	const errors: string[] = [];
	const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));

	for (const ticket of tickets) {
		for (const blocker of ticket.blockers ?? []) {
			if (!byId.has(blocker)) errors.push(`ticket "${ticket.id}" blocks on unknown ticket "${blocker}"`);
		}
	}
	const cycle = findCycle(byId);
	if (cycle) errors.push(`dependency cycle: ${cycle.join(" -> ")}`);

	const ready: Ticket[] = [];
	const waiting: Ticket[] = [];
	for (const ticket of tickets) {
		if (ticket.status !== "open") continue;
		const blockers = ticket.blockers ?? [];
		if (blockers.some((blocker) => !byId.has(blocker))) continue;
		if (blockers.every((blocker) => DONE_STATUSES.includes(byId.get(blocker)!.status))) {
			ready.push(ticket);
		} else {
			waiting.push(ticket);
		}
	}
	return { ready, waiting, errors };
}
