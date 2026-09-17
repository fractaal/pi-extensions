import { Type, type Static } from "typebox";
import { parseGoalBlockedPause } from "./goal-contract.ts";

export const GOAL_TRANSCRIPT_EVENT = "pi-goal:transcript-event";

export const GOAL_TRANSCRIPT_EVENT_KINDS = [
	"goal_started",
	"goal_updated",
	"goal_blocked",
	"goal_waiting",
	"goal_paused",
	"goal_resumed",
	"goal_completion_rejected",
	"goal_completed",
	"goal_abandoned",
	"goal_notice",
	"goal_error",
] as const;

export type GoalTranscriptEventKind = typeof GOAL_TRANSCRIPT_EVENT_KINDS[number];
export type GoalTranscriptEventLevel = "info" | "warning" | "error";

export const GOAL_TRANSCRIPT_MESSAGE_MAX_LENGTH = 4_000;

const FIELD_LIMITS = {
	goalId: 160,
	objective: 20_000,
	changeSummary: 2_000,
	reason: 2_000,
	suggestedAction: 2_000,
	completionSummary: 4_000,
	auditorReport: 12_000,
	message: GOAL_TRANSCRIPT_MESSAGE_MAX_LENGTH,
	tuiMessage: 4_000,
} as const;

const EventCommonProperties = {
	version: Type.Literal(1),
	emittedAt: Type.String({ minLength: 1, maxLength: 64 }),
	level: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
	goalId: Type.Optional(Type.String({ maxLength: FIELD_LIMITS.goalId })),
	objective: Type.Optional(Type.String({ maxLength: FIELD_LIMITS.objective })),
	autoContinue: Type.Optional(Type.Boolean()),
	changeSummary: Type.Optional(Type.String({ maxLength: FIELD_LIMITS.changeSummary })),
	reason: Type.Optional(Type.String({ maxLength: FIELD_LIMITS.reason })),
	suggestedAction: Type.Optional(Type.String({ maxLength: FIELD_LIMITS.suggestedAction })),
	completionSummary: Type.Optional(Type.String({ maxLength: FIELD_LIMITS.completionSummary })),
	auditorReport: Type.Optional(Type.String({ maxLength: FIELD_LIMITS.auditorReport })),
	tuiMessage: Type.String({ maxLength: FIELD_LIMITS.tuiMessage }),
};

export const GoalTranscriptEventSchema = Type.Union([
	Type.Object({
		...EventCommonProperties,
		kind: Type.Literal("goal_blocked"),
		reason: Type.String({ minLength: 1, maxLength: FIELD_LIMITS.reason }),
		suggestedAction: Type.String({ minLength: 1, maxLength: FIELD_LIMITS.suggestedAction }),
		message: Type.Optional(Type.String({ maxLength: FIELD_LIMITS.message })),
	}, { additionalProperties: false }),
	Type.Object({
		...EventCommonProperties,
		kind: Type.Union([
			Type.Literal("goal_started"),
			Type.Literal("goal_updated"),
			Type.Literal("goal_waiting"),
			Type.Literal("goal_paused"),
			Type.Literal("goal_resumed"),
			Type.Literal("goal_completion_rejected"),
			Type.Literal("goal_completed"),
			Type.Literal("goal_abandoned"),
		]),
		message: Type.Optional(Type.String({ maxLength: FIELD_LIMITS.message })),
	}, { additionalProperties: false }),
	Type.Object({
		...EventCommonProperties,
		kind: Type.Union([Type.Literal("goal_notice"), Type.Literal("goal_error")]),
		message: Type.String({ minLength: 1, maxLength: FIELD_LIMITS.message }),
	}, { additionalProperties: false }),
]);

export type GoalTranscriptEvent = Static<typeof GoalTranscriptEventSchema>;
type WithoutEventEnvelope<T> = T extends unknown ? Omit<T, "version" | "emittedAt"> : never;
export type GoalTranscriptEventInput = WithoutEventEnvelope<GoalTranscriptEvent>;

/**
 * Keep a small deterministic margin below common 64 KiB transport boundaries.
 * Enforce the producer contract in UTF-8 bytes rather than JavaScript string
 * units so optional downstream adapters never need to guess or truncate.
 */
export const GOAL_TRANSCRIPT_DATA_MAX_BYTES = 60 * 1024;

type SemanticTextField = Exclude<keyof typeof FIELD_LIMITS, "tuiMessage">;

// Event-specific human meaning wins before general context and audit detail.
// Later fields are deterministically truncated or omitted when the total
// serialized UTF-8 budget is exhausted.
const SEMANTIC_TEXT_PRIORITY: readonly SemanticTextField[] = [
	"goalId",
	"message",
	"reason",
	"completionSummary",
	"changeSummary",
	"suggestedAction",
	"objective",
	"auditorReport",
];

const utf8Encoder = new TextEncoder();

function bounded(value: string | undefined, max: number): string | undefined {
	if (value === undefined || value.length <= max) return value;
	let end = max;
	const last = value.charCodeAt(end - 1);
	if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
	return value.slice(0, end);
}

function semanticDataBytes(event: GoalTranscriptEvent): number {
	const { tuiMessage: _tuiMessage, ...goal } = event;
	return utf8Encoder.encode(JSON.stringify({ goal })).byteLength;
}

const EVENT_KEYS = new Set([
	"version", "kind", "emittedAt", "level", "goalId", "objective", "autoContinue",
	"changeSummary", "reason", "suggestedAction", "completionSummary", "auditorReport", "message", "tuiMessage",
]);
const EVENT_KINDS = new Set<string>(GOAL_TRANSCRIPT_EVENT_KINDS);

export function isGoalTranscriptEvent(value: unknown): value is GoalTranscriptEvent {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const event = value as Record<string, unknown>;
	if (!Object.keys(event).every((key) => EVENT_KEYS.has(key))) return false;
	if (event.version !== 1 || typeof event.kind !== "string" || !EVENT_KINDS.has(event.kind)) return false;
	if (typeof event.emittedAt !== "string" || event.emittedAt.length === 0 || event.emittedAt.length > 64) return false;
	if (event.level !== "info" && event.level !== "warning" && event.level !== "error") return false;
	if (typeof event.tuiMessage !== "string" || event.tuiMessage.length > FIELD_LIMITS.tuiMessage) return false;
	if (event.autoContinue !== undefined && typeof event.autoContinue !== "boolean") return false;
	if ((event.kind === "goal_notice" || event.kind === "goal_error") && (typeof event.message !== "string" || event.message.trim().length === 0)) return false;
	for (const field of SEMANTIC_TEXT_PRIORITY) {
		const text = event[field];
		if (text !== undefined && (typeof text !== "string" || text.length > FIELD_LIMITS[field])) return false;
	}
	if (event.kind === "goal_blocked" && !parseGoalBlockedPause({ reason: event.reason, suggestedAction: event.suggestedAction })) return false;
	return semanticDataBytes(event as GoalTranscriptEvent) <= GOAL_TRANSCRIPT_DATA_MAX_BYTES;
}

export function parseGoalTranscriptEvent(value: unknown): GoalTranscriptEvent | null {
	return isGoalTranscriptEvent(value) ? structuredClone(value) : null;
}

function addTextWithinBudget(
	event: GoalTranscriptEvent,
	field: SemanticTextField,
	value: string | undefined,
): void {
	const clamped = bounded(value, FIELD_LIMITS[field]);
	if (clamped === undefined) return;

	const full = { ...event, [field]: clamped };
	if (semanticDataBytes(full) <= GOAL_TRANSCRIPT_DATA_MAX_BYTES) {
		Object.assign(event, { [field]: clamped });
		return;
	}

	let low = 0;
	let high = clamped.length;
	let best = "";
	while (low <= high) {
		const midpoint = Math.floor((low + high) / 2);
		const candidate = bounded(clamped, midpoint) ?? "";
		const next = { ...event, [field]: candidate };
		if (semanticDataBytes(next) <= GOAL_TRANSCRIPT_DATA_MAX_BYTES) {
			best = candidate;
			low = midpoint + 1;
		} else {
			high = midpoint - 1;
		}
	}
	if (best) Object.assign(event, { [field]: best });
}

/**
 * Build the public Goal transcript contract at one bounded boundary. Internal
 * state snapshots, ledgers, continuation checkpoints, and audit animation never
 * pass through this function.
 */
export function createGoalTranscriptEvent(
	input: GoalTranscriptEventInput,
	emittedAt = new Date().toISOString(),
): GoalTranscriptEvent {
	const requiredMessage = input.kind === "goal_notice" || input.kind === "goal_error" ? input.message.trim() : undefined;
	if (requiredMessage === "") {
		throw new Error(`${input.kind} requires a non-empty message.`);
	}
	const event = {
		version: 1,
		kind: input.kind,
		emittedAt: bounded(emittedAt, 64) ?? "",
		level: input.level,
		tuiMessage: bounded(input.tuiMessage, FIELD_LIMITS.tuiMessage) ?? "",
	} as GoalTranscriptEvent;
	if (input.autoContinue !== undefined) event.autoContinue = input.autoContinue;
	for (const field of SEMANTIC_TEXT_PRIORITY) {
		const value = field === "message" && requiredMessage !== undefined ? requiredMessage : input[field] as string | undefined;
		addTextWithinBudget(event, field, value);
	}
	if (event.kind === "goal_blocked" && !parseGoalBlockedPause({ reason: event.reason, suggestedAction: event.suggestedAction })) {
		throw new Error("goal_blocked requires a complete block proof and unblock condition.");
	}
	return event;
}
