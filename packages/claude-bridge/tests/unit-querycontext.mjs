/**
 * Tool-call claiming: which recorded tool call an MCP handler invocation
 * belongs to. Parallel calls must each receive their own result.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ctx, resetStack } from "../src/query-state.js";

describe("claimToolCall", () => {
	beforeEach(() => resetStack());

	it("matches handler invocation by tool name and args, not stream position", () => {
		ctx().recordToolCall("call-read", "read", { path: "a.txt" });
		ctx().recordToolCall("call-grep", "grep", { pattern: "needle", path: "src" });

		const second = ctx().claimToolCall("grep", { path: "src", pattern: "needle" });
		assert.equal(second.toolCallId, "call-grep");
		assert.equal(second.match, "tool-args");

		const first = ctx().claimToolCall("read", { path: "a.txt" });
		assert.equal(first.toolCallId, "call-read");
		assert.equal(first.match, "tool-args");
	});

	it("handles same-tool parallel calls invoked out of stream order", () => {
		ctx().recordToolCall("read-a", "read", { path: "a.txt" });
		ctx().recordToolCall("read-b", "read", { path: "b.txt" });
		ctx().recordToolCall("grep-src", "grep", { path: "src", pattern: "needle" });
		ctx().recordToolCall("grep-tests", "grep", { path: "tests", pattern: "needle" });

		const readSecond = ctx().claimToolCall("read", { path: "b.txt" });
		const grepSecond = ctx().claimToolCall("grep", { pattern: "needle", path: "tests" });
		const readFirst = ctx().claimToolCall("read", { path: "a.txt" });
		const grepFirst = ctx().claimToolCall("grep", { path: "src", pattern: "needle" });

		assert.equal(readSecond.toolCallId, "read-b");
		assert.equal(grepSecond.toolCallId, "grep-tests");
		assert.equal(readFirst.toolCallId, "read-a");
		assert.equal(grepFirst.toolCallId, "grep-src");
		for (const claim of [readSecond, grepSecond, readFirst, grepFirst]) {
			assert.equal(claim.match, "tool-args");
			assert.equal(claim.ambiguous, false);
		}
	});

	it("refuses to fall back to a different tool type", () => {
		ctx().recordToolCall("bash-1", "bash", { command: "echo ok", timeout: 120 });

		const claim = ctx().claimToolCall("write", { path: "out.txt", content: "ok" });

		assert.equal(claim.toolCallId, undefined);
		assert.equal(claim.match, "none");
		// The unclaimed bash call is still available to its own handler.
		assert.equal(ctx().claimToolCall("bash", { command: "echo ok", timeout: 120 }).toolCallId, "bash-1");
	});

	it("claims the sole same-name call before its arguments finalize", () => {
		ctx().recordToolCall("read-pending", "read", {});

		const claim = ctx().claimToolCall("read", { path: "README.md" });

		assert.equal(claim.toolCallId, "read-pending");
		assert.equal(claim.match, "tool-name");
		assert.equal(claim.ambiguous, false);
	});

	it("claims the sole same-name call when MCP strips an undeclared argument", () => {
		// The model sent {id, reason}, but monitor_stop's declared schema has no
		// `reason`, so MCP validation hands the handler {id} alone while the
		// recorded tool_use block keeps the model's raw arguments. Refusing the
		// claim strands the real result and returns a bridge internal error.
		ctx().recordToolCall("toolu_stop", "monitor_stop", { id: "1e256bfc", reason: "reviewer is quota blocked" });

		const claim = ctx().claimToolCall("monitor_stop", { id: "1e256bfc" });

		assert.equal(claim.toolCallId, "toolu_stop");
		assert.equal(claim.match, "tool-name");
		assert.equal(claim.ambiguous, false);
	});
});
