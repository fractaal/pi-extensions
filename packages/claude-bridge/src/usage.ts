// Claude plan usage (5-hour and weekly windows) for hosts that show quota.
//
// Claude Code exposes /usage data through an Agent SDK control request that
// Anthropic marks experimental. The bridge reads it on a live query, at most
// once per interval, and publishes a small stable shape. Any sign the API has
// changed (method gone, unexpected shape, repeated failures) switches reads off
// for the rest of the process: a missing usage bar is fine, a broken turn is not.

export const CLAUDE_USAGE_EVENT = "claude-bridge:usage";
export const CLAUDE_USAGE_PROVIDER = "anthropic-claude-code";

export interface ClaudeUsageWindow {
	id: "five_hour" | "weekly";
	label: "5h" | "weekly";
	windowSeconds: number;
	usedPercent: number;
	resetAt: string | null;
}

export interface ClaudeUsageReport {
	provider: typeof CLAUDE_USAGE_PROVIDER;
	observedAt: string;
	planType: string | null;
	windows: ClaudeUsageWindow[];
}

export type ClaudeUsageParse =
	| { kind: "report"; report: ClaudeUsageReport }
	// Nothing to show: plan limits do not apply (API key, Bedrock, Vertex) or no window is reported.
	| { kind: "not_applicable" }
	| { kind: "invalid" };

const WINDOWS = [
	{ key: "five_hour", id: "five_hour", label: "5h", windowSeconds: 5 * 60 * 60 },
	{ key: "seven_day", id: "weekly", label: "weekly", windowSeconds: 7 * 24 * 60 * 60 },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseClaudeUsage(response: unknown, observedAt: string): ClaudeUsageParse {
	if (!isRecord(response) || typeof response.rate_limits_available !== "boolean") return { kind: "invalid" };
	if (!response.rate_limits_available) return { kind: "not_applicable" };
	const rateLimits = response.rate_limits;
	if (!isRecord(rateLimits)) return { kind: "invalid" };

	const windows: ClaudeUsageWindow[] = [];
	for (const spec of WINDOWS) {
		const window = rateLimits[spec.key];
		if (window === null || window === undefined) continue;
		if (!isRecord(window)) return { kind: "invalid" };
		const { utilization, resets_at: resetsAt } = window;
		if (utilization !== null && (typeof utilization !== "number" || !Number.isFinite(utilization) || utilization < 0 || utilization > 100)) {
			return { kind: "invalid" };
		}
		if (resetsAt !== null && resetsAt !== undefined && (typeof resetsAt !== "string" || !Number.isFinite(Date.parse(resetsAt)))) {
			return { kind: "invalid" };
		}
		if (typeof utilization !== "number") continue;
		windows.push({
			id: spec.id,
			label: spec.label,
			windowSeconds: spec.windowSeconds,
			usedPercent: utilization,
			resetAt: typeof resetsAt === "string" ? new Date(resetsAt).toISOString() : null,
		});
	}
	// Known shape but no current windows: nothing to show, not an API change.
	if (windows.length === 0) return { kind: "not_applicable" };
	const planType = typeof response.subscription_type === "string" && response.subscription_type ? response.subscription_type : null;
	return { kind: "report", report: { provider: CLAUDE_USAGE_PROVIDER, observedAt, planType, windows } };
}

export const CLAUDE_USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
export const DEFAULT_USAGE_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

/** Shared switch-off rules for every way the bridge reads usage. */
export interface ClaudeUsageGuard {
	readonly disabled: boolean;
	/** One guarded read through a live query. Resolves to a report or null; never rejects. */
	read(query: unknown, now?: () => number): Promise<ClaudeUsageReport | null>;
}

export function createClaudeUsageGuard(onDisabled?: (reason: string) => void): ClaudeUsageGuard {
	let disabled = false;
	let failures = 0;
	const disable = (reason: string) => {
		if (disabled) return;
		disabled = true;
		onDisabled?.(reason);
	};
	return {
		get disabled() { return disabled; },
		async read(query, now = Date.now) {
			if (disabled) return null;
			const read = (query as Record<string, unknown> | null)?.[CLAUDE_USAGE_METHOD];
			if (typeof read !== "function") {
				disable("usage method unavailable");
				return null;
			}
			try {
				const response = await (read as (opts: { skipBehaviors: boolean }) => Promise<unknown>).call(query, { skipBehaviors: true });
				failures = 0;
				const parsed = parseClaudeUsage(response, new Date(now()).toISOString());
				if (parsed.kind === "invalid") disable("unexpected usage response shape");
				return parsed.kind === "report" ? parsed.report : null;
			} catch {
				failures += 1;
				if (failures >= MAX_CONSECUTIVE_FAILURES) disable("usage read failed repeatedly");
				return null;
			}
		},
	};
}

export interface ClaudeUsageReader {
	/** Read usage through a live query if a read is due. Never throws or blocks the caller. */
	maybeRead(query: unknown): void;
	readonly disabled: boolean;
}

export function createClaudeUsageReader(options: {
	publish: (report: ClaudeUsageReport) => void;
	onDisabled?: (reason: string) => void;
	intervalMs?: number;
	now?: () => number;
}): ClaudeUsageReader {
	const intervalMs = options.intervalMs ?? DEFAULT_USAGE_INTERVAL_MS;
	const now = options.now ?? Date.now;
	const guard = createClaudeUsageGuard(options.onDisabled);
	let inFlight = false;
	let lastReadAt = Number.NEGATIVE_INFINITY;

	return {
		get disabled() { return guard.disabled; },
		maybeRead(query) {
			if (guard.disabled || inFlight || now() - lastReadAt < intervalMs) return;
			inFlight = true;
			lastReadAt = now();
			void guard.read(query, now)
				.then((report) => {
					if (!report) return;
					try { options.publish(report); } catch { /* a listener's failure is not an API change */ }
				})
				.finally(() => { inFlight = false; });
		},
	};
}
