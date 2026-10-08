import type { AssistantMessage, Message, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

// Rides inside the first /btw user message rather than the system prompt, so the
// request keeps the main session's prefix (prompt, tool declarations, history)
// byte-for-byte and the provider's prompt cache still hits.
export const BTW_NOTICE =
	"<system-reminder>The user opened a temporary /btw side conversation branched from this session at this point. " +
	"The main session may still be working; nothing said here reaches it unless the user explicitly sends this discussion back. " +
	"Tool calls are blocked in this branch: they will not run, so answer from the conversation so far and your own knowledge. " +
	"If a proper answer needs tools, say so; the user can send this discussion back to the main session to act on it.</system-reminder>";

const BLOCKED_TOOL_TEXT =
	"Blocked: this is a /btw side conversation, so tools do not run here. Answer without tools; if tools are needed, tell the user they can send this discussion back to the main session.";

const PENDING_TOOL_TEXT =
	"This tool call was still running in the main session when the user branched into /btw; its result is not available here.";

function toolResult(call: ToolCall, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: true,
		timestamp: Date.now(),
	};
}

function toolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((part): part is ToolCall => part.type === "toolCall");
}

/**
 * The main session's context at the branch point. When /btw opens mid-run, the
 * last assistant message can hold tool calls whose results have not landed yet;
 * answer those explicitly instead of letting the provider layer insert an
 * unexplained "No result provided".
 */
export function branchBase(messages: Message[]): Message[] {
	const answered = new Set(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
	const base: Message[] = [];
	for (const message of messages) {
		base.push(message);
		if (message.role !== "assistant") continue;
		for (const call of toolCalls(message)) {
			if (!answered.has(call.id)) base.push(toolResult(call, PENDING_TOOL_TEXT));
		}
	}
	return base;
}

export function blockedToolResults(message: AssistantMessage): ToolResultMessage[] {
	return toolCalls(message).map((call) => toolResult(call, BLOCKED_TOOL_TEXT));
}

export function btwUserMessage(text: string, first: boolean): UserMessage {
	return {
		role: "user",
		content: first ? [{ type: "text", text: BTW_NOTICE }, { type: "text", text }] : [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

export type BtwTurn =
	| { role: "user"; text: string }
	| { role: "assistant"; text: string; blockedTools: string[]; error?: string };

/** What the user and the model said in the branch, without the notice or blocked-tool plumbing. */
export function btwTurns(messages: Message[]): BtwTurn[] {
	const turns: BtwTurn[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const parts = typeof message.content === "string" ? [message.content] : message.content.flatMap((part) => (part.type === "text" && part.text !== BTW_NOTICE ? [part.text] : []));
			turns.push({ role: "user", text: parts.join("\n") });
		} else if (message.role === "assistant") {
			const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
			const previous = turns.at(-1);
			const blockedTools = toolCalls(message).map((call) => call.name);
			const error = message.stopReason === "error" || message.stopReason === "aborted" ? (message.errorMessage ?? message.stopReason) : undefined;
			// A blocked tool call and the model's follow-up answer read as one reply.
			if (previous?.role === "assistant" && !previous.error) {
				previous.text = [previous.text, text].filter(Boolean).join("\n\n");
				previous.blockedTools.push(...blockedTools);
				previous.error = error;
			} else {
				turns.push({ role: "assistant", text, blockedTools, ...(error ? { error } : {}) });
			}
		}
	}
	return turns;
}

export function handoffText(turns: BtwTurn[]): string {
	const transcript = turns
		.map((turn) => {
			if (turn.role === "user") return `USER: ${turn.text}`;
			const blocked = turn.blockedTools.length > 0 ? `\n(tried to call ${turn.blockedTools.join(", ")}; blocked in /btw)` : "";
			return `ASSISTANT: ${turn.text || "(no text)"}${blocked}`;
		})
		.join("\n\n");
	return (
		"<system>The user branched this conversation temporarily out into an ephemeral /btw session and continued a discussion there, " +
		"where tool calls were blocked. The user then decided this is pertinent context to send back here. " +
		`Here is that discussion, from the branch point to the end:\n\n${transcript}\n</system>`
	);
}
