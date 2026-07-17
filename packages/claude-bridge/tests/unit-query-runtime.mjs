import { setImmediate as waitForImmediate } from "node:timers/promises";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createQueryRuntimeState, ctx, runWithQueryRuntime } from "../src/query-state.ts";

describe("query runtime isolation", () => {
	it("preserves separate state across interleaved async work", async () => {
		const first = createQueryRuntimeState();
		const second = createQueryRuntimeState();

		await Promise.all([
			runWithQueryRuntime(first, async () => {
				ctx().deferredUserMessages.push("first");
				await waitForImmediate();
				assert.deepEqual(ctx().deferredUserMessages, ["first"]);
			}),
			runWithQueryRuntime(second, async () => {
				ctx().deferredUserMessages.push("second");
				await waitForImmediate();
				assert.deepEqual(ctx().deferredUserMessages, ["second"]);
			}),
		]);

		assert.deepEqual(first.current.deferredUserMessages, ["first"]);
		assert.deepEqual(second.current.deferredUserMessages, ["second"]);
	});
});
