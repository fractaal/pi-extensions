/**
 * Black-box behaviour of the bridge against the real Claude Code binary.
 *
 * Pi's side is driven through the registered provider exactly as Pi's agent
 * loop calls it. Claude Code is the Agent SDK's bundled CLI, talking to a
 * scripted fake Anthropic API, so these tests need no credentials or network.
 * Assertions look only at what Pi receives and what the API receives.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { startFakeAnthropic } from "./lib/fake-anthropic.mjs";

// Each extension instance gets its own runtime, as in Aria Local Runtime.
globalThis.CLAUDE_BRIDGE_ISOLATED = true;
const { createClaudeBridgeExtension, formatResetTimestamp } = await import("../src/index.ts");

const require = createRequire(import.meta.url);
function bundledClaudeBinary() {
	try {
		const sdkRequire = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
		return sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
	} catch {
		return undefined;
	}
}
const claudeBinary = bundledClaudeBinary();

const HAIKU = { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", api: "claude-bridge", provider: "claude-bridge", contextWindow: 200_000, maxTokens: 64_000, reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const FABLE = { ...HAIKU, id: "claude-fable-5", name: "Claude Fable 5", contextWindow: 1_000_000, maxTokens: 128_000 };
const LOOKUP_TOOL = { name: "lookup", description: "Look something up.", parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] } };
const LOOKUP_SDK_NAME = "mcp__custom-tools__lookup";

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const toolResult = (toolCall, text) => ({ role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() });
const toolCallsOf = (message) => message.content.filter((block) => block.type === "toolCall");
const textOf = (message) => message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
const hasFakeReply = (request) => request.messages.some((message) => message.parts.some((part) => /No response requested/.test(part)));

let workDir;
let fakeApi;
let respond;

function newBridge() {
	const handlers = new Map();
	const notifications = [];
	let provider;
	const cwd = mkdtempSync(join(workDir, "session-"));
	createClaudeBridgeExtension({ userDir: join(workDir, "user") })({
		registerCommand() {},
		on(event, handler) { handlers.set(event, handler); },
		registerProvider(_id, config) { provider = config; },
		appendEntry() {},
		events: { emit() {} },
	});
	handlers.get("session_start")?.({ reason: "new" }, { cwd, ui: { notify: (message, level) => notifications.push({ message, level }) } });
	return {
		notifications,
		/** One provider call, as Pi's agent loop makes it. Resolves with the final assistant message. */
		async call(model, messages, { signal, onEvent } = {}) {
			const stream = provider.streamSimple(model, { systemPrompt: "You are a test assistant.", messages, tools: [LOOKUP_TOOL] }, { cwd, signal });
			let last;
			for await (const event of stream) {
				last = event;
				onEvent?.(event);
			}
			return last.type === "done" ? last.message : last.error;
		},
	};
}

describe("Claude Code contract", { timeout: 60_000, skip: claudeBinary ? false : "bundled Claude Code binary not installed for this platform" }, () => {
	before(async () => {
		workDir = mkdtempSync(join(tmpdir(), "claude-bridge-contract-"));
		const bin = join(workDir, "bin");
		mkdirSync(bin);
		symlinkSync(claudeBinary, join(bin, "claude"));
		fakeApi = await startFakeAnthropic((request, index) => respond(request, index));
		for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) delete process.env[key];
		Object.assign(process.env, {
			PATH: `${bin}:${process.env.PATH}`,
			CLAUDE_CONFIG_DIR: join(workDir, "claude-config"),
			ANTHROPIC_API_KEY: "sk-ant-test-only",
			ANTHROPIC_BASE_URL: fakeApi.url,
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		});
	});

	after(async () => {
		await fakeApi?.close();
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	it("a message sent while a tool runs reaches Claude with the tool result, in the same turn", async () => {
		const bridge = newBridge();
		const start = fakeApi.requests.length;
		respond = (_request, index) => index === start
			? { toolUse: { id: "toolu_steer_1", name: LOOKUP_SDK_NAME, input: { topic: "sky" } } }
			: { text: "The sky is blue, and 17 × 3 = 51." };

		const history = [user("Look up the colour of the sky.")];
		const toolTurn = await bridge.call(HAIKU, history);
		const [toolCall] = toolCallsOf(toolTurn);
		assert.equal(toolCall.name, "lookup");

		// Pi drains the steering queue after the tool batch and appends it after the results.
		history.push(toolTurn, toolResult(toolCall, "blue"), user("Also, what is 17 * 3?"));
		const reply = await bridge.call(HAIKU, history);

		assert.equal(reply.stopReason, "stop");
		assert.equal(textOf(reply), "The sky is blue, and 17 × 3 = 51.");
		const requests = fakeApi.requests.slice(start);
		assert.equal(requests.length, 2, "the steer must not start a second query");
		const last = requests[1].messages.at(-1);
		assert.equal(last.role, "user");
		assert.ok(last.parts.some((part) => part.startsWith("tool_result:blue")));
		assert.ok(last.parts.some((part) => part.includes("Also, what is 17 * 3?")));
		assert.equal(requests.some(hasFakeReply), false);
	});

	it("after Stop, the flushed message reaches Claude without a fake reply and the stopped tool is shown as aborted", async () => {
		const bridge = newBridge();
		const start = fakeApi.requests.length;
		respond = (_request, index) => index === start
			? { toolUse: { id: "toolu_stop_1", name: LOOKUP_SDK_NAME, input: { topic: "auth" } } }
			: { text: "Switching to login first." };

		const stop = new AbortController();
		const history = [user("Refactor the auth module.")];
		const toolTurn = await bridge.call(HAIKU, history, { signal: stop.signal });
		const [toolCall] = toolCallsOf(toolTurn);
		stop.abort();

		// Pi records the stopped tool and calls once more with the aborted signal.
		history.push(toolTurn, { ...toolResult(toolCall, "Operation aborted"), isError: true });
		const leftover = await bridge.call(HAIKU, history, { signal: stop.signal });
		assert.equal(leftover.stopReason, "aborted");
		assert.equal(fakeApi.requests.length, start + 1, "the aborted leftover call must not reach Claude");

		// The queued message is flushed as a new run.
		history.push(leftover, user("Wait, do login first."));
		const reply = await bridge.call(HAIKU, history);

		assert.equal(textOf(reply), "Switching to login first.");
		const request = fakeApi.requests.at(-1);
		assert.equal(hasFakeReply(request), false);
		const last = request.messages.at(-1);
		assert.equal(last.role, "user");
		assert.ok(last.parts.some((part) => part.startsWith("tool_result:Operation aborted")));
		assert.ok(last.parts.some((part) => part.includes("Wait, do login first.")));
	});

	it("continuing from tool results after compaction produces Claude's answer", async () => {
		const bridge = newBridge();
		respond = () => ({ text: "Here is the ticket draft." });
		const toolTurn = {
			role: "assistant", provider: "claude-bridge", api: "claude-bridge", model: HAIKU.id, stopReason: "toolUse", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			content: [{ type: "toolCall", id: "toolu_compact_1", name: "lookup", arguments: { topic: "screenshot" } }],
		};

		const reply = await bridge.call(HAIKU, [
			user("[Summary of the earlier conversation]"),
			user("Make the Jira ticket."),
			toolTurn,
			toolResult(toolTurn.content[0], "screenshot contents"),
		]);

		assert.equal(reply.stopReason, "stop");
		assert.equal(textOf(reply), "Here is the ticket draft.");
		const request = fakeApi.requests.at(-1);
		assert.equal(hasFakeReply(request), false);
		assert.ok(request.messages.at(-1).parts.some((part) => part.startsWith("tool_result:screenshot contents")));
	});

	it("a message queued during Claude's final reply starts the next turn instead of being lost", async () => {
		const bridge = newBridge();
		respond = (request) => request.messages.at(-1).parts.some((part) => part.includes("second question"))
			? { text: "second answer" }
			: { text: "first answer" };

		const history = [user("first question")];
		let next;
		const first = await bridge.call(HAIKU, history, {
			// Pi can call again the moment it sees the reply end.
			onEvent: (event) => {
				if (event.type === "done") next = bridge.call(HAIKU, [...history, event.message, user("second question")]);
			},
		});

		assert.equal(textOf(first), "first answer");
		assert.equal(textOf(await next), "second answer");
	});

	it("an over-long prompt reaches Pi as a context overflow it can compact and retry", async () => {
		const bridge = newBridge();
		respond = () => ({ status: 400, message: "prompt is too long: 250000 tokens > 200000 maximum" });

		const reply = await bridge.call(HAIKU, [user("hello")]);

		assert.equal(reply.stopReason, "error");
		assert.equal(isContextOverflow(reply, HAIKU.contextWindow), true);
		assert.equal(textOf(reply), "", "the error must not also appear as assistant text");
	});

	it("1M-context models are requested with Claude Code's 1M window; 200k models are not", async () => {
		respond = () => ({ text: "ok" });

		await newBridge().call(FABLE, [user("hello")]);
		const fableRequest = fakeApi.requests.at(-1);
		await newBridge().call(HAIKU, [user("hello")]);
		const haikuRequest = fakeApi.requests.at(-1);

		assert.match(fableRequest.beta, /context-1m/);
		assert.equal(fableRequest.body.model, "claude-fable-5");
		assert.doesNotMatch(haikuRequest.beta, /context-1m/);
	});

	it("two sessions in one process keep their Claude turns separate", async () => {
		respond = (request) => ({ text: `answer to ${request.messages.at(-1).parts.at(-1)}`, delayMs: 50 });
		const first = newBridge();
		const second = newBridge();

		const [firstReply, secondReply] = await Promise.all([
			first.call(HAIKU, [user("alpha")]),
			second.call(HAIKU, [user("beta")]),
		]);

		assert.equal(textOf(firstReply), "answer to alpha");
		assert.equal(textOf(secondReply), "answer to beta");
	});

	it("a stopped turn's unexecuted tool calls are not replayed or reported as lost output", async () => {
		const bridge = newBridge();
		respond = () => ({ text: "Explaining Y." });
		const stoppedTurn = {
			role: "assistant", provider: "claude-bridge", api: "claude-bridge", model: HAIKU.id, stopReason: "aborted", errorMessage: "Operation aborted", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			content: [{ type: "text", text: "Let me look" }, { type: "toolCall", id: "toolu_never_ran", name: "lookup", arguments: { topic: "x" } }],
		};

		const reply = await bridge.call(HAIKU, [user("Explain X."), stoppedTurn, user("Actually, explain Y.")]);

		assert.equal(textOf(reply), "Explaining Y.");
		const request = fakeApi.requests.at(-1);
		assert.equal(request.messages.some((message) => message.parts.some((part) => part.startsWith("tool_use"))), false);
		assert.equal(hasFakeReply(request), false);
		assert.deepEqual(bridge.notifications.filter((note) => note.level === "error"), []);
	});
});

describe("rate-limit reset time", () => {
	it("reads the SDK's Unix-seconds reset time as a present-day date", () => {
		const formatted = formatResetTimestamp(1_790_000_000);
		assert.match(formatted, /2026/);
		assert.doesNotMatch(formatted, /1970/);
	});
});
