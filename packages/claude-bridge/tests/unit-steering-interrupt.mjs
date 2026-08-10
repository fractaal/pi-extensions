import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	__testSetBridgeIntegrityState,
	assertInitialQuerySucceeded,
	prepareFreshUserPrompt,
	replayDeferredUserMessages,
	requestDeferredSteeringInterrupt,
	wasDeferredSteeringInterruptAcknowledged,
} from "../src/index.ts";
import { QueryContext } from "../src/query-state.ts";

function fakeQuery({ interrupt } = {}) {
	let interruptCount = 0;
	let closeCount = 0;
	return {
		query: {
			interrupt() {
				interruptCount += 1;
				return interrupt?.() ?? Promise.resolve();
			},
			close() {
				closeCount += 1;
			},
		},
		counts: () => ({ interruptCount, closeCount }),
	};
}

function completeToolBoundary(context, toolCallId = "tool-a") {
	context.recordToolCall(toolCallId, "SlowTool");
	context.markToolResultDelivered(toolCallId);
	context.markToolResultResolved(toolCallId);
}

describe("deferred steering interrupt", () => {
	it("waits for every parallel tool result, then interrupts exactly once without closing", async () => {
		const context = new QueryContext();
		const active = fakeQuery();
		context.activeQuery = active.query;
		context.deferredUserMessages.push("stop, do not call the next tool");
		context.recordToolCall("tool-a", "SlowTool", { seconds: 2 });
		context.recordToolCall("tool-b", "ReadTool", { path: "README.md" });
		context.markToolResultDelivered("tool-a");
		context.markToolResultResolved("tool-a");
		context.pendingToolCalls.set("tool-b", { toolName: "ReadTool", resolve() {} });

		assert.equal(requestDeferredSteeringInterrupt(context), false);
		assert.deepEqual(active.counts(), { interruptCount: 0, closeCount: 0 });

		context.pendingToolCalls.delete("tool-b");
		context.markToolResultDelivered("tool-b");
		context.markToolResultResolved("tool-b");

		assert.equal(requestDeferredSteeringInterrupt(context), true);
		assert.equal(requestDeferredSteeringInterrupt(context), false);
		assert.deepEqual(active.counts(), { interruptCount: 0, closeCount: 0 });
		assert.equal(await wasDeferredSteeringInterruptAcknowledged(context, active.query), true);
		assert.deepEqual(active.counts(), { interruptCount: 1, closeCount: 0 });
	});

	it("does not interrupt without a deferred steer or a tool boundary", () => {
		const withoutSteer = new QueryContext();
		const first = fakeQuery();
		withoutSteer.activeQuery = first.query;
		completeToolBoundary(withoutSteer);

		assert.equal(requestDeferredSteeringInterrupt(withoutSteer), false);
		assert.deepEqual(first.counts(), { interruptCount: 0, closeCount: 0 });

		const withoutToolBoundary = new QueryContext();
		const second = fakeQuery();
		withoutToolBoundary.activeQuery = second.query;
		withoutToolBoundary.deferredUserMessages.push("change direction");

		assert.equal(requestDeferredSteeringInterrupt(withoutToolBoundary), false);
		assert.deepEqual(second.counts(), { interruptCount: 0, closeCount: 0 });
	});

	it("retries from production and acknowledges only after the SDK accepts the interrupt", async () => {
		const context = new QueryContext();
		let attempt = 0;
		const active = fakeQuery({
			interrupt: () => ++attempt === 1
				? Promise.reject(new Error("control request failed"))
				: Promise.resolve(),
		});
		context.activeQuery = active.query;
		context.deferredUserMessages.push("stop");
		completeToolBoundary(context);

		assert.equal(requestDeferredSteeringInterrupt(context), true);
		assert.equal(await wasDeferredSteeringInterruptAcknowledged(context, active.query), true);
		assert.deepEqual(active.counts(), { interruptCount: 2, closeCount: 0 });
		assert.equal(context.steeringInterruptStatus, "acknowledged");
	});

	it("does not classify a concurrent SDK error as steering when both interrupt attempts fail", async () => {
		const context = new QueryContext();
		const rejections = [];
		const notifications = [];
		const active = fakeQuery({
			interrupt: () => new Promise((_, reject) => rejections.push(reject)),
		});
		context.activeQuery = active.query;
		context.deferredUserMessages.push("stop");
		completeToolBoundary(context);
		__testSetBridgeIntegrityState({ ui: { notify: (message, level) => notifications.push({ message, level }) } });

		try {
			assert.equal(requestDeferredSteeringInterrupt(context), true);
			const classification = wasDeferredSteeringInterruptAcknowledged(context, active.query);
			let settled = false;
			void classification.then(() => { settled = true; });

			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(settled, false, "classification must wait for the pending control request");
			assert.equal(rejections.length, 1);
			rejections.shift()(new Error("first request rejected"));

			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(rejections.length, 1);
			rejections.shift()(new Error("second request rejected"));

			assert.equal(await classification, false);
			assert.equal(context.steeringInterruptStatus, "failed");
			assert.deepEqual(active.counts(), { interruptCount: 2, closeCount: 0 });
			assert.deepEqual(context.deferredUserMessages, ["stop"]);
			assert.equal(notifications.length, 1);
			assert.match(notifications[0].message, /could not stop the current Claude turn after 2 attempts/i);
			assert.equal(notifications[0].level, "warning");
		} finally {
			__testSetBridgeIntegrityState({ ui: null });
		}
	});
});

describe("deferred steering replay", () => {
	it("removes the active batch while replaying and preserves later messages for the next batch", async () => {
		const context = new QueryContext();
		context.deferredUserMessages.push("first", "second");
		const attempted = [];

		await replayDeferredUserMessages(context, async (messages) => {
			attempted.push([...messages]);
			assert.deepEqual(context.deferredUserMessages, []);
			if (attempted.length === 1) context.deferredUserMessages.push("third");
		});

		assert.deepEqual(attempted, [
			["first", "second"],
			["third"],
		]);
		assert.deepEqual(context.deferredUserMessages, []);
	});

	it("routes a normally resolved terminal error through failure restoration", () => {
		const context = new QueryContext();
		context.handledTerminalError = true;
		context.turnOutput = { stopReason: "error", errorMessage: "resolved terminal failure" };

		assert.throws(() => assertInitialQuerySucceeded(context), /resolved terminal failure/);
	});

	it("carries a failed replay batch into the next fresh prompt ahead of newer input", async () => {
		const context = new QueryContext();
		context.deferredUserMessages.push("first", "second", "third");
		const attempted = [];

		await assert.rejects(
			replayDeferredUserMessages(context, async (messages) => {
				attempted.push([...messages]);
				assert.deepEqual(context.deferredUserMessages, []);
				context.deferredUserMessages.push("later");
				throw new Error("continuation failed");
			}),
			/continuation failed/,
		);
		assert.deepEqual(attempted, [["first", "second", "third"]]);
		assert.deepEqual(context.deferredUserMessages, ["first", "second", "third", "later"]);

		const freshPrompt = prepareFreshUserPrompt(context, "newest");
		assert.deepEqual(freshPrompt.retainedUserMessages, ["first", "second", "third", "later"]);
		assert.deepEqual(context.deferredUserMessages, []);
		assert.ok(freshPrompt.promptText.indexOf("first") < freshPrompt.promptText.indexOf("second"));
		assert.ok(freshPrompt.promptText.indexOf("second") < freshPrompt.promptText.indexOf("third"));
		assert.ok(freshPrompt.promptText.indexOf("third") < freshPrompt.promptText.indexOf("later"));
		assert.ok(freshPrompt.promptText.indexOf("later") < freshPrompt.promptText.indexOf("newest"));
	});
});
