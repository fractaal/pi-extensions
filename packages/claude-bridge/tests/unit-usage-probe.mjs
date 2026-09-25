/**
 * The usage probe Symphony Desktop polls for Claude pacing: one idle Claude
 * Code process while reads continue, none once they stop, and no effect on
 * the host when Claude Code or its usage API is missing or changed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClaudeUsageProbe } from "../src/usage-probe.ts";
import { CLAUDE_USAGE_METHOD } from "../src/usage.ts";

const usageResponse = {
	subscription_type: "max",
	rate_limits_available: true,
	rate_limits: {
		five_hour: { utilization: 12, resets_at: "2026-09-25T10:00:00Z" },
		seven_day: { utilization: 64, resets_at: "2026-09-26T08:00:00Z" },
	},
};

function fakeClaudeCode(respond = () => usageResponse) {
	const processes = [];
	const startQuery = (options) => {
		let closed = false;
		let wake;
		const process = {
			options,
			get closed() { return closed; },
			usageCalls: 0,
			close() { closed = true; wake?.(); },
			async *[Symbol.asyncIterator]() { while (!closed) await new Promise((resolve) => { wake = resolve; }); },
		};
		process[CLAUDE_USAGE_METHOD] = async () => { process.usageCalls += 1; return respond(process.usageCalls); };
		processes.push(process);
		return process;
	};
	return { processes, startQuery };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Claude usage probe", () => {
	it("reads usage through one idle Claude Code process while reads continue", async () => {
		const claude = fakeClaudeCode();
		const probe = createClaudeUsageProbe({ executablePath: "/usr/bin/claude", startQuery: claude.startQuery });

		const first = await probe.read();
		const second = await probe.read();
		probe.close();

		assert.deepEqual(first.windows.map((w) => [w.id, w.usedPercent]), [["five_hour", 12], ["weekly", 64]]);
		assert.deepEqual(second.windows.map((w) => w.usedPercent), [12, 64]);
		assert.equal(claude.processes.length, 1);
		assert.deepEqual(claude.processes[0].options.tools, [], "the idle process must not load tools");
		assert.deepEqual(claude.processes[0].options.mcpServers, {});
	});

	it("shuts the process down once reads stop, and starts a new one when they resume", async () => {
		const claude = fakeClaudeCode();
		const probe = createClaudeUsageProbe({ executablePath: "/usr/bin/claude", startQuery: claude.startQuery, idleShutdownMs: 20 });

		await probe.read();
		await wait(60);
		assert.equal(claude.processes[0].closed, true);

		assert.ok(await probe.read());
		assert.equal(claude.processes.length, 2);
		probe.close();
	});

	it("does not start anything when Claude Code is not installed", async () => {
		const claude = fakeClaudeCode();
		const probe = createClaudeUsageProbe({ env: { PATH: "" }, startQuery: claude.startQuery });

		assert.equal(await probe.read(), null);
		assert.equal(claude.processes.length, 0);
	});

	it("stays off once the usage API looks changed", async () => {
		const claude = fakeClaudeCode(() => ({ usage: "moved" }));
		const probe = createClaudeUsageProbe({ executablePath: "/usr/bin/claude", startQuery: claude.startQuery });

		assert.equal(await probe.read(), null);
		assert.equal(await probe.read(), null);
		probe.close();

		assert.equal(probe.disabled, true);
		assert.equal(claude.processes[0].usageCalls, 1);
	});

	it("gives up on a read that hangs instead of blocking the host", async () => {
		const claude = fakeClaudeCode(() => new Promise(() => {}));
		const probe = createClaudeUsageProbe({ executablePath: "/usr/bin/claude", startQuery: claude.startQuery, readTimeoutMs: 20 });

		assert.equal(await probe.read(), null);
		probe.close();
	});
});
