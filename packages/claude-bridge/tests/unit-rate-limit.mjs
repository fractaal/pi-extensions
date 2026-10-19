/**
 * Tests for Claude SDK rate-limit event rendering.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatAllowedRateLimitWarning } from "../src/index.ts";

describe("rate_limit_event allowed_warning", () => {
	const warning = (fields) => formatAllowedRateLimitWarning({ status: "allowed_warning", rateLimitType: "seven_day", ...fields });

	it("warns from 70% of a limit with the floored percentage, reading utilization as a fraction like Claude Code", () => {
		assert.equal(warning({ utilization: 0.69 }), undefined);
		assert.equal(warning({ utilization: 0 }), undefined);
		assert.equal(warning({ utilization: 0.7 }), "Claude rate limit warning: You've used 70% of your weekly limit");
		assert.equal(warning({ utilization: 0.919 }), "Claude rate limit warning: You've used 91% of your weekly limit");
		assert.equal(warning({ utilization: 1 }), "Claude rate limit warning: You've used 100% of your weekly limit");
	});

	it("still warns when no utilization is reported", () => {
		assert.equal(warning({}), "Claude rate limit warning: Approaching weekly limit");
	});

	it("names each limit the way Claude Code does", () => {
		const names = {
			five_hour: "session limit",
			seven_day: "weekly limit",
			seven_day_opus: "Opus limit",
			seven_day_sonnet: "Sonnet limit",
			seven_day_overage_included: "Fable limit",
			overage: "usage credit limit",
			monthly: "monthly limit",
		};
		for (const [rateLimitType, name] of Object.entries(names)) {
			assert.equal(warning({ rateLimitType, utilization: 0.8 }), `Claude rate limit warning: You've used 80% of your ${name}`);
		}
	});

	it("shows nothing for other statuses or a limit Claude Code does not name", () => {
		assert.equal(formatAllowedRateLimitWarning({ status: "allowed", rateLimitType: "seven_day", utilization: 0.95 }), undefined);
		assert.equal(formatAllowedRateLimitWarning({ status: "rejected", rateLimitType: "seven_day", utilization: 0.95 }), undefined);
		assert.equal(warning({ rateLimitType: undefined, utilization: 0.95 }), undefined);
	});
});
