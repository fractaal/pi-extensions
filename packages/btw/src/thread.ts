import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Message, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { blockedToolResults, branchBase, btwTurns, btwUserMessage, type BtwTurn } from "./branch.ts";

export type StreamSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

export interface BtwThreadOptions {
	model: Model<Api>;
	/** The main session's context (prompt, tool declarations, history) at the branch point. */
	mainMessages: Message[];
	streamSimple: StreamSimple;
	reasoning?: SimpleStreamOptions["reasoning"];
	/** This thread's conversation id, distinct from the main session's. */
	sessionId: string;
}

/** An ephemeral side conversation: the main context frozen at the branch point, plus everything said since. */
export class BtwThread {
	readonly model: Model<Api>;
	readonly branchedAt = new Date();
	private readonly base: Message[];
	private readonly messages: Message[] = [];
	private partial: AssistantMessage | undefined;
	private controller: AbortController | undefined;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly options: BtwThreadOptions) {
		this.model = options.model;
		this.base = branchBase(options.mainMessages);
	}

	get busy(): boolean {
		return this.controller !== undefined;
	}

	get turns(): BtwTurn[] {
		return btwTurns(this.partial ? [...this.messages, this.partial] : this.messages);
	}

	/** Prompt tokens of the latest reply and how many of them the provider served from cache. */
	get lastUsage(): { input: number; cached: number } | undefined {
		const reply = [...this.messages].reverse().find((m): m is AssistantMessage => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted");
		if (!reply) return undefined;
		const { input, cacheRead, cacheWrite } = reply.usage;
		return { input: input + cacheRead + cacheWrite, cached: cacheRead };
	}

	/** True while the in-flight reply has produced no visible text yet (thinking, or waiting on the provider). */
	get waiting(): boolean {
		return this.busy && !this.partial?.content.some((part) => part.type === "text" && part.text.trim());
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	abort(): void {
		this.controller?.abort();
	}

	/** Ask a question in the branch. Resolves when the reply is complete, failed, or aborted. */
	async ask(text: string): Promise<void> {
		if (this.busy) throw new Error("/btw is still answering");
		const first = !this.messages.some((m) => m.role === "user");
		this.messages.push(btwUserMessage(text, first));
		const controller = new AbortController();
		this.controller = controller;
		this.changed();
		try {
			// Tools stay declared (they are part of the cached prefix); calls are answered
			// with a "blocked" result and the model is asked again until it replies in text.
			// Ctrl+C in the panel aborts a model that keeps trying.
			for (;;) {
				const reply = await this.stream(controller.signal);
				this.messages.push(reply);
				if (reply.stopReason !== "toolUse") break;
				this.messages.push(...blockedToolResults(reply));
				this.changed();
			}
		} finally {
			this.partial = undefined;
			this.controller = undefined;
			this.changed();
		}
	}

	private async stream(signal: AbortSignal): Promise<AssistantMessage> {
		const { model, streamSimple, reasoning, sessionId } = this.options;
		const events = streamSimple(model, { messages: [...this.base, ...this.messages] }, { signal, reasoning, sessionId });
		for await (const event of events) {
			if ("partial" in event) {
				this.partial = event.partial;
				this.changed();
			}
		}
		this.partial = undefined;
		return events.result();
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}
}
