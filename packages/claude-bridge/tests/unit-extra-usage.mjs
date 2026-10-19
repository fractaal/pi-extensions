/**
 * Tests for extra-usage detection helpers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatResetTimestamp, isExtraUsageRequiredMessage, uniqueNonEmptyLines } from "../src/index.ts";

describe("isExtraUsageRequiredMessage", () => {
	it("recognizes Claude Code's own signals that a request needs usage credits", () => {
		const needsCredits = [
			// A subscriber's long-context request, as Claude Code words it.
			"API Error: Usage credits required for 1M context · turn on usage credits at claude.ai/settings/usage (they take effect in a new session)",
			// The API's own wording, which Claude Code passes through for other logins.
			"API Error: Request rejected (429) · Extra usage is required for long context requests.",
			"Usage credits are required for long context requests.",
			new Error("Claude Code returned an error result: API Error: Request rejected (429) · Extra usage is required for long context requests."),
			// Rate-limit info from a request the API rejected with credits_required.
			{ status: "rejected", overageStatus: "rejected", overageDisabledReason: "out_of_credits", isUsingOverage: false, errorCode: "credits_required" },
		];
		for (const signal of needsCredits) assert.equal(isExtraUsageRequiredMessage(signal), true, String(signal?.message ?? JSON.stringify(signal)));
	});

	it("ignores ordinary rate limits, including the overage fields Claude Code reports with them", () => {
		const ordinary = [
			"Claude rate limited; resets at 12:00",
			"You've hit your session limit · resets 9:06pm (Asia/Manila)",
			{ status: "rejected", resetsAt: 1792415179, rateLimitType: "five_hour", overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false },
		];
		for (const signal of ordinary) assert.equal(isExtraUsageRequiredMessage(signal), false, typeof signal === "string" ? signal : JSON.stringify(signal));
	});

	it("deduplicates repeated Claude Code error lines", () => {
		assert.deepEqual(uniqueNonEmptyLines(["You're out of extra usage", "You're out of extra usage", " other "]), [
			"You're out of extra usage",
			"other",
		]);
	});

	it("formats reset timestamps with timezone context", () => {
		const formatted = formatResetTimestamp("2026-05-23T13:19:55Z");
		assert.match(formatted, /2026|May|23|13|1|UTC|GMT|AM|PM/i);
		assert.equal(formatResetTimestamp("not a date"), "unknown");
	});
});
