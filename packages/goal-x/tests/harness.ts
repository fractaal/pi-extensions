import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type IdleCallback = () => void;

export interface ToolResult {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
	terminate?: boolean;
}

export interface RegisteredTool {
	name: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: unknown;
	execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, update: undefined, ctx: ExtensionContext) => Promise<ToolResult>;
}

export interface RegisteredCommand {
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

class FakeEventBus {
	readonly emitted: Array<{ channel: string; data: unknown }> = [];
	private readonly listeners = new Map<string, Array<(data: unknown) => void>>();

	emit(channel: string, data: unknown): void {
		this.emitted.push({ channel, data: structuredClone(data) });
		for (const listener of this.listeners.get(channel) ?? []) listener(data);
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		const current = this.listeners.get(channel) ?? [];
		current.push(handler);
		this.listeners.set(channel, current);
		return () => this.listeners.set(channel, (this.listeners.get(channel) ?? []).filter((item) => item !== handler));
	}
}

export interface Harness {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	entries: Array<Record<string, unknown>>;
	handlers: Map<string, Handler[]>;
	tools: Map<string, RegisteredTool>;
	commands: Map<string, RegisteredCommand>;
	events: FakeEventBus;
	sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
	notifications: Array<{ message: string; level: string }>;
	widgets: Array<{ key: string; value: unknown }>;
	runIdle: () => void;
	setContextUsage: (tokens: number | null, contextWindow?: number) => void;
	confirmations: boolean[];
	confirmationForms: Array<{ confirmed: boolean; input?: string }>;
	confirmationRequests: Array<Record<string, unknown>>;
	selections: Array<string | undefined>;
	run(event: string, payload?: unknown): Promise<unknown[]>;
}

export function createHarness(initialEntries: Array<Record<string, unknown>> = [], cwd = process.cwd()): Harness {
	const entries = [...initialEntries];
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	const events = new FakeEventBus();
	const sent: Harness["sent"] = [];
	const notifications: Harness["notifications"] = [];
	const widgets: Harness["widgets"] = [];
	const confirmations: boolean[] = [];
	const confirmationForms: Array<{ confirmed: boolean; input?: string }> = [];
	const confirmationRequests: Array<Record<string, unknown>> = [];
	const selections: Array<string | undefined> = [];
	const idleCallbacks = new Set<IdleCallback>();
	let contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } = {
		tokens: 0,
		contextWindow: 872_000,
		percent: 0,
	};

	const onIdle = (callback: IdleCallback): (() => void) => {
		const unsubscribe = () => idleCallbacks.delete(callback);
		if (idleCallbacks.has(callback)) return unsubscribe;
		idleCallbacks.add(callback);
		return unsubscribe;
	};

	const piShape = {
		on: (event: string, handler: Handler) => {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		registerTool: (tool: unknown) => {
			const registered = tool as RegisteredTool;
			tools.set(registered.name, registered);
		},
		registerCommand: (name: string, command: unknown) => commands.set(name, command as RegisteredCommand),
		registerEntryRenderer: () => {},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => sent.push({ message: structuredClone(message), options: options ? structuredClone(options) : undefined }),
		sendUserMessage: (content: unknown) => sent.push({ message: { role: "user", content: structuredClone(content) } }),
		events,
	} as unknown as ExtensionAPI;

	const ctxShape = {
		cwd,
		hasUI: true,
		mode: "tui",
		model: { provider: "fixture", id: "model" },
		thinkingLevel: "medium",
		sessionManager: {
			getBranch: () => entries,
			getHeader: () => null,
			getSessionId: () => "test-session",
		},
		ui: {
			confirm: async () => confirmations.shift() ?? false,
			confirmWithInput: async (options: Record<string, unknown>) => {
				confirmationRequests.push(structuredClone(options));
				return confirmationForms.shift() ?? { confirmed: confirmations.shift() ?? false };
			},
			select: async () => selections.shift(),
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setWidget: (key: string, value: unknown) => widgets.push({ key, value }),
			setEditorText: () => {},
		},
		abort: () => {},
		onIdle,
		getContextUsage: () => contextUsage,
		modelRegistry: { getAvailable: () => [] },
	} as unknown as ExtensionContext;

	return {
		pi: piShape,
		ctx: ctxShape,
		entries,
		handlers,
		tools,
		commands,
		events,
		sent,
		notifications,
		widgets,
		runIdle: () => {
			const callbacks = [...idleCallbacks];
			idleCallbacks.clear();
			for (const callback of callbacks) callback();
		},
		setContextUsage: (tokens, contextWindow = contextUsage.contextWindow) => {
			contextUsage = {
				tokens,
				contextWindow,
				percent: tokens === null ? null : tokens / contextWindow * 100,
			};
		},
		confirmations,
		confirmationForms,
		confirmationRequests,
		selections,
		async run(event, payload = {}) {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctxShape));
			return results;
		},
	};
}

export async function executeTool(harness: Harness, name: string, params: Record<string, unknown>): Promise<ToolResult> {
	const tool = harness.tools.get(name);
	if (!tool) throw new Error(`Missing tool: ${name}`);
	return tool.execute(`${name}-call`, params, new AbortController().signal, undefined, harness.ctx);
}
