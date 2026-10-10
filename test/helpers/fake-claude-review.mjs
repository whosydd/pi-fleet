#!/usr/bin/env node
// Stands in for `claude -p`: prints the JSON envelope with a review contract in
// structured_output, so the fleet's harvest can extract it without a model call.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const schemaPath = args.includes("--json-schema") ? args[args.indexOf("--json-schema") + 1] : undefined;
const findings = schemaPath ? [] : [];
const review = {
	base: "deadbeef",
	standards: {
		worst_issue: "the fix round is not covered by a test",
		findings: [
			{ rule: "fix rounds must be capped in code", file: "extensions/lib/plan.ts", line: 140, quote: "exceeds the cap of" },
			{ rule: "judgments stay advisory and degradable", file: "extensions/index.ts", line: 480, quote: "advanceChain" },
			...findings,
		],
	},
	spec: {
		spec_found: true,
		worst_issue: "none",
		findings: [],
	},
};
process.stdout.write(JSON.stringify({ structured_output: review, usage: { input_tokens: 10, output_tokens: 5 } }) + "\n");
// Read the prompt so a broken argv still shows up as an empty run rather than a
// silent success: -p must be followed by the task text.
const prompt = args.includes("-p") ? args[args.indexOf("-p") + 1] : "";
if (!prompt || prompt.startsWith("--")) process.stderr.write("fake-claude: no prompt after -p\n");
void readFileSync;
