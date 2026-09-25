// Canonical selection + display order for the model picker.
// `resolveModelId` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

export const FABLE_MODEL_ID = "claude-fable-5";
export const OPUS_5_5_MODEL_ID = "claude-opus-5-5";
export const OPUS_5_MODEL_ID = "claude-opus-5";
export const FABLE_FALLBACK_MODEL_ID = "claude-opus-4-8";
export const SONNET_5_MODEL_ID = "claude-sonnet-5";

export function fallbackModelForPrimaryModel(modelId: string): string | undefined {
	return modelId === FABLE_MODEL_ID ? FABLE_FALLBACK_MODEL_ID : undefined;
}

const ONE_MILLION_CONTEXT = 1_000_000;
const ONE_MILLION_SUFFIX = "[1m]";

// Claude Code enforces its own idea of the context window before calling the
// API. Models it does not recognise as 1M get 200k and fail locally with
// "Prompt is too long" at about 177k, while Pi (told 1M) never compacts.
// The `[1m]` suffix is Claude Code's documented way to declare a 1M window; it
// strips the suffix and sends the context-1m beta.
export function claudeCodeModelArg(modelId: string, contextWindow: number | undefined): string {
	return (contextWindow ?? 0) >= ONE_MILLION_CONTEXT ? `${modelId}${ONE_MILLION_SUFFIX}` : modelId;
}

export function stripClaudeCodeModelSuffix(modelId: string): string {
	return modelId.endsWith(ONE_MILLION_SUFFIX) ? modelId.slice(0, -ONE_MILLION_SUFFIX.length) : modelId;
}

export const MODEL_IDS_IN_ORDER = [
	FABLE_MODEL_ID,
	OPUS_5_5_MODEL_ID,
	OPUS_5_MODEL_ID,
	FABLE_FALLBACK_MODEL_ID,
	"claude-opus-4-7",
	"claude-opus-4-6",
	SONNET_5_MODEL_ID,
	"claude-sonnet-4-6",
	"claude-haiku-4-5",
];

type BridgeModelMetadata = {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
};

const FALLBACK_MODELS: Record<string, BridgeModelMetadata> = {
	[FABLE_MODEL_ID]: {
		id: FABLE_MODEL_ID,
		name: "Claude Fable 5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[OPUS_5_5_MODEL_ID]: {
		id: OPUS_5_5_MODEL_ID,
		name: "Claude Opus 5.5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[OPUS_5_MODEL_ID]: {
		id: OPUS_5_MODEL_ID,
		name: "Claude Opus 5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[FABLE_FALLBACK_MODEL_ID]: {
		id: FABLE_FALLBACK_MODEL_ID,
		name: "Claude Opus 4.8",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[SONNET_5_MODEL_ID]: {
		id: SONNET_5_MODEL_ID,
		name: "Claude Sonnet 5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
};

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// keep MODEL_IDS_IN_ORDER ordering, and fill bridge-owned future IDs when pi-ai
// has not shipped metadata for them yet. Unknown missing IDs are still dropped.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER
		.map((id) => piAiModels.find((m) => m.id === id) ?? FALLBACK_MODELS[id])
		.filter((m) => m != null)
		// Forward thinkingLevelMap so per-model overrides (e.g. opus-4-7 mapping
		// xhigh→xhigh instead of xhigh→max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
			id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

export function resolveModelId(models: Array<{ id: string }>, input: string): string {
	const lower = input.toLowerCase();
	const match = models.find((m) => m.id === lower || m.id.includes(lower));
	return match ? match.id : input;
}
