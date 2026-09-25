// Open prompt stream for one Claude Code query.
//
// A query started with a string prompt closes stdin, so the only way to add a
// user message mid-turn is interrupt + resume. Claude Code's resume loader then
// inserts a synthetic "No response requested." assistant reply whenever the
// session ends on a user-role message, and the model apologises for it. Keeping
// the input open lets the bridge push a steering message into the running turn
// instead; Claude Code folds it in after the current tool results.

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export class PromptInput implements AsyncIterable<SDKUserMessage> {
	private readonly queue: SDKUserMessage[] = [];
	private wake: (() => void) | null = null;
	private closed = false;

	/** Queue a message for Claude Code. Returns false once the input has closed. */
	push(message: SDKUserMessage): boolean {
		if (this.closed) return false;
		this.queue.push(message);
		this.wake?.();
		return true;
	}

	/** End the input. Claude Code exits after it finishes the current turn. */
	close(): void {
		this.closed = true;
		this.wake?.();
	}

	get isClosed(): boolean {
		return this.closed;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		while (true) {
			const next = this.queue.shift();
			if (next) {
				yield next;
				continue;
			}
			if (this.closed) return;
			await new Promise<void>((resolve) => { this.wake = resolve; });
			this.wake = null;
		}
	}
}
