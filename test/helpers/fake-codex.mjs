#!/usr/bin/env node
// Stands in for `codex exec`: honours `-o <file>` by writing the final
// message there (as the real CLI does), prints the JSONL event stream with
// usage to stdout, and honours --bad to exit zero with a broken contract.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const o = args.includes("-o") ? args[args.indexOf("-o") + 1] : undefined;
const bad = args.includes("--bad");
const payload = bad
	? { oops: true }
	: { ticket: "42", status: "implemented", branch: "fleet/42-b", commits: [{ sha: "a", subject: "s" }], tests: { command: "x", passed: 1, failed: 0 } };

if (o) writeFileSync(o, JSON.stringify(payload, null, 2));
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t" }) + "\n");
process.stdout.write(
	JSON.stringify({ type: "turn.completed", usage: { input_tokens: 250, output_tokens: 40, cached_input_tokens: 200 } }) + "\n",
);
