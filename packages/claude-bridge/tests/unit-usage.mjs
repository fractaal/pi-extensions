/**
 * Claude plan usage: parsing Claude Code's experimental /usage response and
 * the guards that keep a changed or failing API from affecting turns.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_USAGE_METHOD, createClaudeUsageReader, parseClaudeUsage } from "../src/usage.ts";

const OBSERVED_AT = "2026-09-25T05:00:00.000Z";
const window = (utilization, resetsAt) => ({ utilization, resets_at: resetsAt, limit_dollars: null, used_dollars: null });
const maxPlanResponse = {
	subscription_type: "max",
	rate_limits_available: true,
	rate_limits: {
		five_hour: window(31, "2026-09-25T05:30:00.087815+00:00"),
		seven_day: window(63, "2026-09-26T08:00:00.087835+00:00"),
		seven_day_opus: null,
		nimbus_quill: window(0, null),
	},
};

describe("parseClaudeUsage", () => {
	it("reads the 5-hour and weekly windows of a subscription", () => {
		assert.deepEqual(parseClaudeUsage(maxPlanResponse, OBSERVED_AT), {
			kind: "report",
			report: {
				provider: "anthropic-claude-code",
				observedAt: OBSERVED_AT,
				planType: "max",
				windows: [
					{ id: "five_hour", label: "5h", windowSeconds: 18_000, usedPercent: 31, resetAt: "2026-09-25T05:30:00.087Z" },
					{ id: "weekly", label: "weekly", windowSeconds: 604_800, usedPercent: 63, resetAt: "2026-09-26T08:00:00.087Z" },
				],
			},
		});
	});

	it("has nothing to show when plan limits do not apply or no window is reported", () => {
		assert.deepEqual(parseClaudeUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null }, OBSERVED_AT), { kind: "not_applicable" });
		assert.deepEqual(parseClaudeUsage({ ...maxPlanResponse, rate_limits: { five_hour: null, seven_day: null } }, OBSERVED_AT), { kind: "not_applicable" });
		assert.deepEqual(parseClaudeUsage({ ...maxPlanResponse, rate_limits: { five_hour: window(null, null) } }, OBSERVED_AT), { kind: "not_applicable" });
	});

	it("rejects shapes that suggest the API changed", () => {
		for (const response of [
			null,
			"usage",
			{ rate_limits: maxPlanResponse.rate_limits },
			{ rate_limits_available: true, rate_limits: [] },
			{ rate_limits_available: true, rate_limits: { five_hour: "31%" } },
			{ rate_limits_available: true, rate_limits: { five_hour: window("31", null) } },
			{ rate_limits_available: true, rate_limits: { five_hour: window(0.31e3, null) } },
			{ rate_limits_available: true, rate_limits: { seven_day: window(63, "next tuesday") } },
		]) {
			assert.deepEqual(parseClaudeUsage(response, OBSERVED_AT), { kind: "invalid" }, JSON.stringify(response));
		}
	});
});

function fakeQuery(respond) {
	const query = { calls: 0 };
	query[CLAUDE_USAGE_METHOD] = async () => { query.calls += 1; return respond(query.calls); };
	return query;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("Claude usage reader", () => {
	it("publishes the account's usage from a live query", async () => {
		const published = [];
		const reader = createClaudeUsageReader({ publish: (report) => published.push(report) });

		reader.maybeRead(fakeQuery(() => maxPlanResponse));
		await settle();

		assert.equal(published.length, 1);
		assert.deepEqual(published[0].windows.map((w) => [w.id, w.usedPercent]), [["five_hour", 31], ["weekly", 63]]);
	});

	it("stops reading for good once the response no longer looks like usage", async () => {
		const published = [];
		const reader = createClaudeUsageReader({ publish: (report) => published.push(report), intervalMs: 0 });
		const query = fakeQuery((call) => (call === 1 ? { rateLimits: "renamed" } : maxPlanResponse));

		for (let i = 0; i < 5; i += 1) { reader.maybeRead(query); await settle(); }

		assert.equal(query.calls, 1);
		assert.deepEqual(published, []);
	});

	it("stops reading when the usage call keeps failing, without throwing into the turn", async () => {
		const reader = createClaudeUsageReader({ publish() {}, intervalMs: 0 });
		const query = fakeQuery(() => { throw new Error("control request failed"); });

		for (let i = 0; i < 20; i += 1) {
			assert.doesNotThrow(() => reader.maybeRead(query));
			await settle();
		}

		const callsSoFar = query.calls;
		reader.maybeRead(query);
		await settle();
		assert.equal(query.calls, callsSoFar, "a permanently failing call must eventually stop being made");
	});

	it("does nothing when the SDK no longer offers the usage call", async () => {
		const published = [];
		const reader = createClaudeUsageReader({ publish: (report) => published.push(report) });

		assert.doesNotThrow(() => reader.maybeRead({ interrupt() {} }));
		await settle();

		assert.deepEqual(published, []);
	});
});
