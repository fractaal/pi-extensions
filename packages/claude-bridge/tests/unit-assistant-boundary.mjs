import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { processAssistantMessage, processStreamEvent, streamClaudeAgentSdk } from "../src/index.ts";
import { ctx, resetStack } from "../src/query-state.ts";

const model = {
	api: "claude-bridge",
	provider: "claude-bridge",
	id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function installFakeStream() {
	const events = [];
	const stream = {
		push(event) { events.push(event); },
		end(result) { events.push({ type: "stream_end", result }); },
	};
	ctx().currentPiStream = stream;
	return events;
}

describe("assistant tool-use boundary fallback", () => {
	beforeEach(() => resetStack());

	it("ends a streamed tool-use turn when the SDK assistant message arrives before message_stop", () => {
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();
		c.turnSawStreamEvent = true;
		c.turnSawToolCall = true;
		c.turnToolCallIds = ["toolu_1"];
		c.turnBlocks.push({
			type: "toolCall",
			id: "toolu_1",
			name: "bash",
			arguments: {},
			partialJson: "{\"command\":\"echo hi\"}",
			index: 0,
		});

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{
					type: "tool_use",
					id: "toolu_1",
					name: "mcp__custom-tools__bash",
					input: { command: "echo hi" },
				}],
			},
		}, model, new Map([["mcp__custom-tools__bash", "bash"]]));

		assert.equal(c.currentPiStream, null);
		assert.equal(c.turnOutput.stopReason, "toolUse");
		assert.deepEqual(c.turnToolCallIds, ["toolu_1"]);
		assert.equal(c.turnBlocks.length, 1, "must not duplicate streamed tool call block");
		assert.equal(c.turnBlocks[0].arguments.command, "echo hi");
		assert.ok(!("partialJson" in c.turnBlocks[0]), "partial JSON should be finalized");
		assert.equal(events.at(-2).type, "done");
		assert.equal(events.at(-2).reason, "toolUse");
		assert.equal(events.at(-1).type, "stream_end");
	});

	it("adds missing tool-use blocks from assistant message before ending the turn", () => {
		const c = ctx();
		c.resetTurnState(model);
		const events = installFakeStream();
		c.turnSawStreamEvent = true;

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{
					type: "tool_use",
					id: "toolu_missing",
					name: "mcp__custom-tools__read",
					input: { file_path: "README.md" },
				}],
			},
		}, model, new Map([["mcp__custom-tools__read", "read"]]));

		assert.equal(c.currentPiStream, null);
		assert.deepEqual(c.turnToolCallIds, ["toolu_missing"]);
		assert.equal(c.turnBlocks.length, 1);
		assert.equal(c.turnBlocks[0].name, "read");
		assert.equal(c.turnBlocks[0].arguments.path, "README.md");
		assert.deepEqual(events.map((event) => event.type), ["start", "toolcall_start", "toolcall_end", "done", "stream_end"]);
	});

	it("delivers a late same-message tool call exactly once when its first result opens the next stream", async () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		const names = new Map([["mcp__custom-tools__read", "read"]]);

		processStreamEvent({ type: "stream_event", event: { type: "message_start", message: { id: "msg-1" } } }, names, model);
		processStreamEvent({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-a", name: "mcp__custom-tools__read", input: {} } } }, names, model);
		processStreamEvent({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"file_path\":\"a.txt\"}" } } }, names, model);
		processStreamEvent({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }, names, model);
		processStreamEvent({ type: "stream_event", event: { type: "message_stop" } }, names, model);

		let resolved;
		c.activeQuery = {};
		c.pendingToolCalls.set("call-a", { toolName: "read", resolve(result) { resolved = result; } });
		const deliveryStream = streamClaudeAgentSdk(model, { messages: [
			{ role: "assistant", content: [{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.txt" } }] },
			{ role: "toolResult", toolCallId: "call-a", content: [{ type: "text", text: "A result" }] },
		] });

		processAssistantMessage({ type: "assistant", message: { id: "msg-1", content: [
			{ type: "tool_use", id: "call-a", name: "mcp__custom-tools__read", input: { file_path: "a.txt" } },
		] } }, model, names);
		assert.strictEqual(c.currentPiStream, deliveryStream, "already-emitted fragments must leave the result stream open");

		processAssistantMessage({ type: "assistant", message: { id: "msg-1", content: [
			{ type: "tool_use", id: "call-a", name: "mcp__custom-tools__read", input: { file_path: "a.txt" } },
			{ type: "tool_use", id: "call-b", name: "mcp__custom-tools__read", input: { file_path: "b.txt" } },
		] } }, model, names);

		const events = [];
		for await (const event of deliveryStream) events.push(event);
		assert.deepEqual(events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall.id), ["call-b"]);
		assert.deepEqual(resolved.content, [{ type: "text", text: "A result" }]);
		assert.equal(c.claimToolCall("read", { path: "b.txt" }).toolCallId, "call-b");
		assert.deepEqual(c.unemittedToolCalls(), []);
	});

	it("terminates the active query and suppresses new-message calls after an unmatched result", async () => {
		const c = ctx();
		c.resetTurnState(model);
		let interrupted = false;
		let closed = false;
		c.activeQuery = {
			interrupt() { interrupted = true; return Promise.resolve(); },
			close() { closed = true; },
		};
		c.assistantMessageId = "msg-1";
		c.recordToolCall("call-b", "write", { path: "out.txt", content: "ok" });
		let stoppedResult;
		c.pendingToolCalls.set("call-b", { toolName: "write", resolve(result) { stoppedResult = result; } });

		const stoppedStream = streamClaudeAgentSdk(model, { messages: [
			{ role: "assistant", content: [{ type: "toolCall", id: "other", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "unknown", content: "unexpected" },
		] });
		const stoppedEvents = [];
		for await (const event of stoppedStream) stoppedEvents.push(event);

		const names = new Map([["mcp__custom-tools__write", "write"]]);
		c.resetTurnState(model);
		const lateEvents = installFakeStream();
		processStreamEvent({ type: "stream_event", event: { type: "message_start", message: { id: "msg-2" } } }, names, model);
		processStreamEvent({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "post-mismatch-write", name: "mcp__custom-tools__write", input: {} } } }, names, model);
		processAssistantMessage({ type: "assistant", message: { id: "msg-2", content: [
			{ type: "tool_use", id: "post-mismatch-write", name: "mcp__custom-tools__write", input: { file_path: "out.txt", content: "bad" } },
		] } }, model, names);

		assert.equal(stoppedResult.isError, true);
		assert.equal(interrupted, true);
		assert.equal(closed, true);
		assert.deepEqual(stoppedEvents.map((event) => event.type), ["error"]);
		assert.deepEqual(lateEvents, []);
		assert.equal(c.reportedToolResultMismatch, true);
		assert.equal(c.emittedToolCallIds.has("post-mismatch-write"), false);
	});

	it("ignores a late bare message_stop so the next assistant fallback still renders text", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processStreamEvent({ type: "stream_event", event: { type: "message_stop" } }, new Map(), model);

		assert.equal(c.turnSawStreamEvent, false, "late stop-only event must not mask assistant fallback");
		assert.equal(c.currentPiStream !== null, true);

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{ type: "text", text: "next turn text" }],
			},
		}, model, new Map());

		assert.equal(c.turnBlocks.length, 1);
		assert.equal(c.turnBlocks[0].type, "text");
		assert.equal(c.turnBlocks[0].text, "next turn text");
	});

	it("ignores late unmatched content_block events so assistant fallback is not masked", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processStreamEvent({ type: "stream_event", event: { type: "content_block_delta", index: 7, delta: { type: "text_delta", text: "late" } } }, new Map(), model);
		processStreamEvent({ type: "stream_event", event: { type: "content_block_stop", index: 7 } }, new Map(), model);

		assert.equal(c.turnSawStreamEvent, false, "unmatched late content events must not mask assistant fallback");
		assert.equal(c.turnBlocks.length, 0);

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{ type: "text", text: "fallback after stale content event" }],
			},
		}, model, new Map());

		assert.equal(c.turnBlocks.length, 1);
		assert.equal(c.turnBlocks[0].text, "fallback after stale content event");
	});

	it("updates the Pi assistant model when Claude Code switches models at message_start", () => {
		const c = ctx();
		c.resetTurnState({ ...model, id: "claude-fable-5" });
		installFakeStream();

		processStreamEvent({
			type: "stream_event",
			event: {
				type: "message_start",
				message: {
					model: "claude-opus-4-8",
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
		}, new Map(), model);

		assert.equal(c.turnOutput.model, "claude-opus-4-8");
		assert.equal(c.turnSawStreamEvent, false);
	});

	it("records fallback assistant blocks without rendering them as text", () => {
		const c = ctx();
		c.resetTurnState({ ...model, id: "claude-fable-5" });
		installFakeStream();

		processAssistantMessage({
			type: "assistant",
			message: {
				model: "claude-opus-4-8",
				content: [{
					type: "fallback",
					from: { model: "claude-fable-5" },
					to: { model: "claude-opus-4-8" },
				}],
			},
		}, model, new Map());

		assert.equal(c.turnOutput.model, "claude-opus-4-8");
		assert.equal(c.turnBlocks.length, 0);
	});
});
