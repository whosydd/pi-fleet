#!/usr/bin/env node
// Stands in for `claude -p --output-format json` when the provider refuses the
// call: exit 1, nothing on stderr, and the cause inside the stdout envelope.
// This is the shape observed live from a 403 quota rejection.
process.stdout.write(
	JSON.stringify({
		type: "result",
		subtype: "success",
		is_error: true,
		api_error_status: 403,
		terminal_reason: "api_error",
		stop_reason: "stop_sequence",
		result: "Failed to authenticate. API Error: 403 subscription quota insufficient, bucket=basic",
	}) + "\n",
);
process.exit(1);
