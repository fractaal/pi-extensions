import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { QueryContext } from "../src/query-state.js";
import { __testSetBridgeIntegrityState, reportToolResultMismatch } from "../src/index.js";

let dir;
let diagPath;
let notifications;

function makeMismatchContext() {
	const queryCtx = new QueryContext();
	queryCtx.activeQuery = { id: "query" };
	queryCtx.recordToolCall("t0", "read", { path: "safe.txt" });
	queryCtx.recordToolCall("t1", "bash", { command: "echo should-not-leak" });
	queryCtx.markToolResultDelivered("t0");
	queryCtx.markToolResultResolved("t0");
	queryCtx.markToolResultDelivered("t1");
	queryCtx.pendingResults.set("t1", { toolCallId: "t1", content: [{ type: "text", text: "queued" }] });
	return queryCtx;
}

describe("tool-result integrity reporting", () => {
	beforeEach(() => {
		dir = mkdtempSync("/tmp/claude-bridge-integrity-");
		diagPath = join(dir, "diag.log");
		process.env.CLAUDE_BRIDGE_DIAG_PATH = diagPath;
		notifications = [];
		__testSetBridgeIntegrityState({
			ui: { notify: (message, level) => notifications.push({ message, level }) },
			sharedSession: { sessionId: "session-12345678", cursor: 4, cwd: "/repo" },
		});
	});

	afterEach(() => {
		__testSetBridgeIntegrityState({ ui: null, sharedSession: null });
		delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps a tool-result mismatch out of the user's transcript", () => {
		reportToolResultMismatch(makeMismatchContext(), "query teardown", "/repo");

		assert.deepEqual(notifications, []);
	});

	it("writes the mismatch diagnostic privately and without tool arguments", () => {
		reportToolResultMismatch(makeMismatchContext(), "query teardown", "/repo");

		assert.equal(statSync(diagPath).mode & 0o777, 0o600);
		assert.equal(readFileSync(diagPath, "utf8").includes("should-not-leak"), false);
	});
});
