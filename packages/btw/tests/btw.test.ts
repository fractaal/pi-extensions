import { type Api, type AssistantMessage, type Context, createAssistantMessageEventStream, type Message, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { handoffText, mainContext } from "../src/branch.ts";
import { BtwThread } from "../src/thread.ts";

const model = { id: "test-model", provider: "test", api: "test-api", reasoning: false } as unknown as Model<Api>;

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: 0,
	} as AssistantMessage;
}

/** A provider that answers each request with the next scripted reply and records what it was sent. */
function fakeProvider(replies: AssistantMessage[]) {
	const requests: Context[] = [];
	const streamSimple = (_model: Model<Api>, context: Context) => {
		requests.push(structuredClone(context));
		const reply = replies.shift();
		if (!reply) throw new Error("unexpected extra request");
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: reply });
			stream.push({ type: "done", reason: reply.stopReason as "stop", message: reply });
			stream.end(reply);
		});
		return stream;
	};
	return { requests, streamSimple };
}

const mainMessages: Message[] = [
	{ role: "system", content: "You are the main agent.", timestamp: 0 } as Message,
	{ role: "user", content: [{ type: "text", text: "Refactor the parser." }], timestamp: 0 },
	assistant([{ type: "text", text: "Done refactoring." }]),
];

const textOf = (message: Message | undefined) =>
	message && message.role !== "system" && typeof message.content !== "string"
		? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
		: "";

describe("/btw thread", () => {
	it("sends the main session's context unchanged, followed by the question", async () => {
		const provider = fakeProvider([assistant([{ type: "text", text: "Because of the tokenizer." }])]);
		const thread = new BtwThread({ model, mainMessages, streamSimple: provider.streamSimple, sessionId: "s1" });

		await thread.ask("Why did that take so long?");

		const sent = provider.requests[0]!.messages;
		expect(sent.slice(0, mainMessages.length)).toEqual(mainMessages);
		expect(sent).toHaveLength(mainMessages.length + 1);
		expect(textOf(sent.at(-1))).toContain("Why did that take so long?");
		expect(textOf(sent.at(-1))).toContain("Tool calls are blocked");
		expect(thread.turns).toEqual([
			{ role: "user", text: "Why did that take so long?" },
			{ role: "assistant", text: "Because of the tokenizer.", blockedTools: [] },
		]);
	});

	it("blocks tool calls and lets the model answer in text instead", async () => {
		const provider = fakeProvider([
			assistant([{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "rm -rf build" } }], "toolUse"),
			assistant([{ type: "text", text: "I can't run tools here; send this back to do it." }]),
		]);
		const thread = new BtwThread({ model, mainMessages, streamSimple: provider.streamSimple, sessionId: "s1" });

		await thread.ask("Clean the build dir");

		const retry = provider.requests[1]!.messages;
		const blocked = retry.at(-1)!;
		expect(blocked).toMatchObject({ role: "toolResult", toolCallId: "call-1", isError: true });
		expect(textOf(blocked)).toMatch(/blocked/i);
		expect(thread.turns.at(-1)).toEqual({
			role: "assistant",
			text: "I can't run tools here; send this back to do it.",
			blockedTools: ["bash"],
		});
	});

	it("keeps the conversation going across questions", async () => {
		const provider = fakeProvider([assistant([{ type: "text", text: "A" }]), assistant([{ type: "text", text: "B" }])]);
		const thread = new BtwThread({ model, mainMessages, streamSimple: provider.streamSimple, sessionId: "s1" });

		await thread.ask("first");
		await thread.ask("second");

		const second = provider.requests[1]!.messages;
		expect(second.slice(0, mainMessages.length)).toEqual(mainMessages);
		expect(second.slice(mainMessages.length).map(textOf)).toEqual([expect.stringContaining("first"), "A", "second"]);
	});

	it("answers tool calls still running in the main session so the branch request is valid", async () => {
		const midRun: Message[] = [...mainMessages, assistant([{ type: "toolCall", id: "running", name: "bash", arguments: {} }], "toolUse")];
		const provider = fakeProvider([assistant([{ type: "text", text: "ok" }])]);
		const thread = new BtwThread({ model, mainMessages: midRun, streamSimple: provider.streamSimple, sessionId: "s1" });

		await thread.ask("what's it doing?");

		const sent = provider.requests[0]!.messages;
		expect(sent.slice(0, midRun.length)).toEqual(midRun);
		expect(sent[midRun.length]).toMatchObject({ role: "toolResult", toolCallId: "running" });
		expect(textOf(sent[midRun.length])).toMatch(/still running in the main session/);
	});
});

describe("/btw handoff", () => {
	it("carries the side discussion back without the branch notice", async () => {
		const provider = fakeProvider([
			assistant([{ type: "toolCall", id: "c", name: "read", arguments: {} }], "toolUse"),
			assistant([{ type: "text", text: "Yes, that is plausible." }]),
		]);
		const thread = new BtwThread({ model, mainMessages, streamSimple: provider.streamSimple, sessionId: "s1" });
		await thread.ask("Could the cache be stale?");

		const text = handoffText(thread.turns);

		expect(text).toMatch(/^<system>The user branched this conversation/);
		expect(text).toContain("USER: Could the cache be stale?\n\nASSISTANT: Yes, that is plausible.\n(tried to call read; blocked in /btw)");
		expect(text).not.toContain("system-reminder");
	});
});

describe("main context at the branch point", () => {
	const bash = { name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } };
	const system = { role: "system", content: "Base prompt.", toolsAdded: [bash], timestamp: 1 } as Message;
	const ask = { role: "user", content: [{ type: "text", text: "Run ls" }], timestamp: 2 } as Message;
	const call = assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: {} }], "toolUse");
	const result = { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp: 4 } as Message;
	const reply = assistant([{ type: "text", text: "One file." }]);

	it("extends the last request with what the session gained since", () => {
		const lastRequest = [{ ...system, content: "Forced." } as Message, ask];
		expect(mainContext(lastRequest, [system, ask, call, result, reply])).toEqual([...lastRequest, call, result, reply]);
	});

	it("falls back to the session history when it no longer extends the last request", () => {
		const lastRequest = [system, ask, call, result, reply];
		const compacted = [system, { role: "compactionSummary", summary: "Ran ls.", tokensBefore: 10, timestamp: 5 } as never];
		expect(mainContext(lastRequest, compacted)).toEqual(compacted);
		expect(mainContext(undefined, [system, ask])).toEqual([system, ask]);
	});
});
