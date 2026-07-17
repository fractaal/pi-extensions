import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

function createPi() {
	const handlers = new Map();
	const providers = [];
	return {
		pi: {
			events: { emit() {}, on() { return () => {}; } },
			on(event, handler) { handlers.set(event, handler); },
			registerCommand() {},
			registerProvider(name, config) { providers.push({ name, config }); },
		},
		handlers,
		providers,
	};
}

afterEach(() => {
	delete globalThis[ACTIVE_STREAM_SIMPLE_KEY];
});

describe("provider state ownership", () => {
	it("creates separate stream state for sibling runtimes from one isolated factory", async () => {
		const isolated = await import(`../bundle/isolated.js?test=${Math.random()}`);
		const first = createPi();
		const second = createPi();

		isolated.default(first.pi);
		isolated.default(second.pi);

		assert.equal(first.providers.length, 1);
		assert.equal(second.providers.length, 1);
		assert.notEqual(first.providers[0].config.streamSimple, second.providers[0].config.streamSimple);
		assert.equal(globalThis[ACTIVE_STREAM_SIMPLE_KEY], undefined);
	});

	it("preserves first-stream ownership for nested instances sharing a registry", async () => {
		const shared = await import(`../bundle/index.js?test=${Math.random()}`);
		const parent = createPi();
		const child = createPi();

		shared.default(parent.pi);
		shared.default(child.pi);

		assert.equal(parent.providers.length, 1);
		assert.equal(child.providers.length, 0);
		assert.equal(globalThis[ACTIVE_STREAM_SIMPLE_KEY], parent.providers[0].config.streamSimple);
	});
});
