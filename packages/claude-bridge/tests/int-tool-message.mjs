#!/usr/bin/env node
// Integration tests for tool execution + message interaction scenarios.
// Uses pi in RPC mode with the bridge + SlowTool test extension.
// Exercises how the bridge handles messages arriving during tool execution.

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 30_000;
// Keep live bridge acceptance independent of Claude Code's known third-party
// system-prompt discrimination, which can reject a test before inference.
const NEUTRAL_SYSTEM_PROMPT = "You are a software test assistant. Follow the user's instructions and use only the tools provided by the test host.";

const harness = createRpcHarness({
	name: "tool-message",
	args: [
		"--system-prompt", NEUTRAL_SYSTEM_PROMPT,
		"-e", "./tests/fixtures/slow-tool-extension.ts",
		"--model", "claude-bridge/claude-haiku-4-5",
	],
	defaultTimeout: TEST_TIMEOUT,
});

describe("tool-message integration", () => {
	const { start, stop, send, waitForEvent, waitForMatch, collectText, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

	// --- Lifecycle ---

	before(async () => {
		harness.start();
		await new Promise((r) => setTimeout(r, 2000));
	});

	afterEach(async () => {
		if (harness.pi().exitCode !== null) {
			harness.start();
			await new Promise((r) => setTimeout(r, 2000));
		}
	});

	after(async () => {
		await harness.stop();
		console.log(`  RPC log: ${RPC_LOG}`);
		console.log(`  Debug log: ${DEBUG_LOG}`);
	});

	// --- Tests ---

	it("tool call completes normally", { timeout: TEST_TIMEOUT }, async () => {
		const text = await promptAndWait(
			"Call SlowTool with seconds=1. Then repeat exactly what it returned, nothing else."
		);
		assert.match(text.toLowerCase(), /slowtool completed/);
	});

	it("followUp during tool execution delivers after tool completes", { timeout: TEST_TIMEOUT }, async () => {
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=5. Then repeat exactly what it returned.",
		});
		await waitForEvent("tool_execution_start");
		// followUp is queued by pi until the current turn finishes
		await send({
			type: "prompt",
			message: "This is a followUp during tool execution.",
			streamingBehavior: "followUp",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /slowtool completed/);
	});

	it("steer during tool execution still delivers tool result", { timeout: 15_000 }, async () => {
		// Issue #3: steer injects a user message into the context during an active
		// tool call. extractAllToolResults stops at the user message and returns 0
		// results, leaving the pending handler stuck.
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=2. Then repeat exactly what it returned.",
		});
		await waitForEvent("tool_execution_start");
		await send({
			type: "prompt",
			message: "Do not call another tool. In your final response, include the exact text returned by the current SlowTool call.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /slowtool completed/);
	});

	it("parallel tool calls with steer delivers all results", { timeout: 30_000 }, async () => {
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Call SlowTool three times in parallel: seconds=3, seconds=4, seconds=5. Then list all three results.",
		});
		// Wait for at least one tool to start, then inject steer
		await waitForEvent("tool_execution_start");
		await send({
			type: "prompt",
			message: "Do not call more tools. After every current parallel SlowTool call finishes, list the exact text returned by all three calls.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		// All three tools should have their results in the response
		const matches = (text.match(/slowtool completed/gi) || []).length;
		assert.ok(matches >= 3, `Expected 3 SlowTool results, found ${matches}: ${text.slice(0, 300)}`);
	});

	it("steer during text response (no tool call) completes both turns", { timeout: 30_000 }, async () => {
		// Steer during text-only streaming: the assistant is generating text (no tool
		// calls), a steer arrives, and pi delivers it after the current turn ends.
		// Risk: if activeQuery hasn't been cleared by the time pi calls streamSimple
		// for the steer, the bridge enters the tool-result-delivery path incorrectly.
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Write at least 5 detailed paragraphs about the history of computing, from Babbage to modern times. Do NOT call any tools. Do NOT stop early.",
		});
		// Wait until text is actually streaming before injecting the steer
		await waitForMatch(
			(msg) => msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta",
			"text_delta during assistant response",
		);
		await send({
			type: "prompt",
			message: "After you finish, also say the exact word 'PINEAPPLE' on its own line.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /pineapple/);
	});

	it("steer prevents the next stale-plan tool from starting", { timeout: 30_000 }, async () => {
		const collector = collectText();
		const startedTools = [];
		const removeListener = harness.addListener((message) => {
			if (message.type === "tool_execution_start") startedTools.push(message.toolName);
		});
		try {
			const firstBoundary = waitForMatch(
				(message) => message.type === "agent_end"
					|| (message.type === "tool_execution_start" && message.toolName === "SlowTool"),
				"SlowTool execution start or turn end",
			);
			await send({
				type: "prompt",
				message: "Call SlowTool with seconds=2. Wait for its result. Then call ForbiddenTool exactly once.",
			});
			const boundary = await firstBoundary;
			if (boundary.type !== "tool_execution_start") {
				assert.fail(`Turn ended before SlowTool started: ${collector.stop().slice(0, 300)}`);
			}
			await send({
				type: "prompt",
				message: "STOP. Let the current SlowTool finish, but do not call ForbiddenTool. Acknowledge this correction by saying the exact word 'MANGO'.",
				streamingBehavior: "steer",
			});
			await waitForEvent("agent_end");
			const text = collector.stop();
			assert.match(text.toLowerCase(), /mango/, `Steer content not visible to assistant: ${text.slice(0, 300)}`);
			assert.deepEqual(startedTools, ["SlowTool"], `A stale-plan tool started after steering: ${startedTools.join(", ")}`);
		} finally {
			collector.stop();
			removeListener();
		}
	});

	it("replayed correction can call a tool and still produce final prose", { timeout: 40_000 }, async () => {
		const collector = collectText();
		const startedTools = [];
		const removeListener = harness.addListener((message) => {
			if (message.type === "tool_execution_start") startedTools.push(message.toolName);
		});
		try {
			const firstBoundary = waitForMatch(
				(message) => message.type === "agent_end"
					|| (message.type === "tool_execution_start" && message.toolName === "SlowTool"),
				"SlowTool execution start or turn end",
			);
			await send({
				type: "prompt",
				message: "Call SlowTool with seconds=2. Wait for its result. Then call ForbiddenTool exactly once.",
			});
			const boundary = await firstBoundary;
			if (boundary.type !== "tool_execution_start") {
				assert.fail(`Turn ended before SlowTool started: ${collector.stop().slice(0, 300)}`);
			}
			await send({
				type: "prompt",
				message: "STOP. Let the current SlowTool finish, but do not call ForbiddenTool. Instead call SlowTool with seconds=1. After it returns, say the exact word 'PAPAYA'.",
				streamingBehavior: "steer",
			});
			await waitForEvent("agent_end");
			const text = collector.stop();
			assert.match(text.toLowerCase(), /papaya/, `Final prose after the steered tool call is missing: ${text.slice(0, 300)}`);
			assert.deepEqual(startedTools, ["SlowTool", "SlowTool"], `Unexpected tool sequence after steering: ${startedTools.join(", ")}`);
		} finally {
			collector.stop();
			removeListener();
		}
	});

	it("batches all-mode steering into one balanced continuation", { timeout: 30_000 }, async () => {
		const collector = collectText();
		const startedTools = [];
		let assistantStarts = 0;
		let assistantEnds = 0;
		const removeListener = harness.addListener((message) => {
			if (message.type === "tool_execution_start") startedTools.push(message.toolName);
			if (message.type === "message_start" && message.message?.role === "assistant") assistantStarts += 1;
			if (message.type === "message_end" && message.message?.role === "assistant") assistantEnds += 1;
		});
		try {
			await send({ type: "set_steering_mode", mode: "all" });
			await send({
				type: "prompt",
				message: "Call SlowTool with seconds=2. Wait for its result. Then say ORIGINAL.",
			});
			await waitForEvent("tool_execution_start");
			await send({
				type: "prompt",
				message: "STOP. Do not call another tool. Say the exact word 'FIRST'.",
				streamingBehavior: "steer",
			});
			await send({
				type: "prompt",
				message: "Also say the exact word 'SECOND'.",
				streamingBehavior: "steer",
			});
			await waitForEvent("agent_end");
			const text = collector.stop();
			assert.match(text.toLowerCase(), /first/, `First steer effect missing: ${text.slice(0, 300)}`);
			assert.match(text.toLowerCase(), /second/, `Second steer effect missing: ${text.slice(0, 300)}`);
			assert.deepEqual(startedTools, ["SlowTool"]);
			assert.equal(assistantStarts, assistantEnds, `Unbalanced assistant lifecycle: ${assistantStarts} starts, ${assistantEnds} ends`);
		} finally {
			await send({ type: "set_steering_mode", mode: "one-at-a-time" }).catch(() => {});
			collector.stop();
			removeListener();
		}
	});

	it("abort during tool execution recovers cleanly", { timeout: TEST_TIMEOUT }, async () => {
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=30.",
		});
		await waitForEvent("tool_execution_start");
		const idle = waitForEvent("agent_end");
		await send({ type: "abort" });
		await idle;
		// Next prompt should work without hanging
		const text = await promptAndWait("Reply with just the word 'recovered'.");
		assert.match(text.toLowerCase(), /recovered/);
	});
});
