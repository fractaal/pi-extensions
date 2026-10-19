/**
 * Tests for Claude SDK rate-limit event rendering.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatAllowedRateLimitWarning } from "../src/index.ts";

describe("rate_limit_event allowed_warning", () => {
	it("suppresses low fractional utilization for seven_day warnings", () => {
		const warning = formatAllowedRateLimitWarning({
			status: "allowed_warning",
			rateLimitType: "seven_day",
			utilization: 0.01,
		});

		assert.equal(warning, undefined);
	});

	it("suppresses exact 1 because SDK unit is ambiguous", () => {
		const warning = formatAllowedRateLimitWarning({
			status: "allowed_warning",
			rateLimitType: "seven_day",
			utilization: 1,
		});

		assert.equal(warning, undefined);
	});

	it("warns at high utilization reported as a fraction or as a percent", () => {
		for (const utilization of [0.91, 91]) {
			assert.equal(
				formatAllowedRateLimitWarning({
					status: "allowed_warning",
					rateLimitType: "seven_day",
					utilization,
				}),
				"Claude rate limit warning: nearing seven_day limit; check Claude Code /usage for exact utilization.",
			);
		}
	});
});
