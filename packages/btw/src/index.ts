import { randomUUID } from "node:crypto";
import { convertToLlm, copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type AgentMessage, asSent, type BtwTurn, handoffText, mainContext } from "./branch.ts";
import { BtwPanel, type PanelResult, TOGGLE_KEY } from "./panel.ts";
import { BtwThread } from "./thread.ts";

export default function btwExtension(pi: ExtensionAPI) {
	let thread: BtwThread | undefined;
	/** The transcript of the main session's latest provider request. */
	let lastRequest: AgentMessage[] | undefined;
	let panelOpen = false;
	/** A reply finished while the panel was hidden. */
	let replyReady = false;

	const showStatus = (ctx: ExtensionContext) => {
		const text = !thread || panelOpen ? undefined : thread.busy ? `btw: replying… (${TOGGLE_KEY})` : replyReady ? `btw: reply ready (${TOGGLE_KEY})` : undefined;
		ctx.ui.setStatus("btw", text);
	};

	const startThread = (ctx: ExtensionContext): BtwThread | undefined => {
		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("/btw needs a selected model", "error");
			return undefined;
		}
		const thinkingLevel = pi.getThinkingLevel();
		return new BtwThread({
			model,
			mainMessages: convertToLlm(mainContext(lastRequest, ctx.sessionManager.buildSessionProjection().messages)),
			streamSimple: (m, context, options) => ctx.modelRegistry.streamSimple(m, context, options),
			reasoning: model.reasoning && thinkingLevel !== "off" ? thinkingLevel : undefined,
			// Its own conversation id: providers that keep per-conversation state (Claude Bridge)
			// must not mix this thread into the main session.
			sessionId: `${ctx.sessionManager.getSessionId()}:btw:${randomUUID().slice(0, 8)}`,
		});
	};

	const reportError = (ctx: ExtensionContext) => (error: unknown) =>
		ctx.ui.notify(`/btw: ${error instanceof Error ? error.message : String(error)}`, "error");

	const replaceThread = (ctx: ExtensionContext, next: BtwThread) => {
		thread?.abort();
		thread = next;
		replyReady = false;
		let wasBusy = false;
		next.onChange(() => {
			if (thread !== next) return;
			if (wasBusy && !next.busy && !panelOpen) replyReady = true;
			wasBusy = next.busy;
			showStatus(ctx);
		});
	};

	/** Shows the panel until the user hides it; the thread carries on either way. */
	const openPanel = async (ctx: ExtensionContext, current: BtwThread) => {
		panelOpen = true;
		replyReady = false;
		showStatus(ctx);
		let result: PanelResult;
		try {
			result = await ctx.ui.custom<PanelResult>(
				(tui, theme, _keybindings, done) => new BtwPanel(tui, theme, current, done, reportError(ctx)),
				{ overlay: true, overlayOptions: { anchor: "center", width: "85%", minWidth: 40, maxHeight: "85%" } },
			);
		} finally {
			panelOpen = false;
			showStatus(ctx);
		}

		if (result === "copy") {
			await copyToClipboard(handoffText(current.turns)).then(
				() => ctx.ui.notify("/btw conversation copied", "info"),
				reportError(ctx),
			);
		} else if (result === "send") {
			const turns = current.turns;
			// Mid-run, steer so the main agent sees it after its current tool batch; idle, start a turn on it.
			pi.sendMessage(
				{ customType: "btw", content: handoffText(turns), display: true, details: { turns } },
				ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" },
			);
		}
	};

	/** `question` starts a new branch from the current point; without one, reopen the current branch. */
	const btw = async (ctx: ExtensionContext, question: string) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/btw needs the interactive terminal UI", "error");
			return;
		}
		if (panelOpen) return;
		if (question || !thread) {
			const next = startThread(ctx);
			if (!next) return;
			replaceThread(ctx, next);
		}
		const current = thread!;
		if (question) current.ask(question).catch(reportError(ctx));
		await openPanel(ctx, current);
	};

	pi.registerCommand("btw", {
		description: `Side conversation branched from here (tools blocked). /btw <question> starts one; /btw or ${TOGGLE_KEY} reopens it`,
		handler: (args, ctx) => btw(ctx, args.trim()),
	});

	pi.registerShortcut(TOGGLE_KEY, {
		description: "Show the /btw side conversation",
		handler: (ctx) => btw(ctx, ""),
	});

	pi.registerMessageRenderer<{ turns?: BtwTurn[] }>("btw", (message, options, theme) => {
		const turns = message.details?.turns ?? [];
		const header = theme.fg("accent", "↩ /btw discussion sent back") + theme.fg("dim", ` (${turns.length} turns)`);
		if (!options.expanded) return new Text(header, 0, 0);
		const body = turns.map((turn) => (turn.role === "user" ? `${theme.fg("accent", "you ›")} ${turn.text}` : turn.text)).join("\n\n");
		return new Text(`${header}\n\n${body}`, 0, 0);
	});

	// Observe only: returning nothing leaves the request as other handlers made it.
	pi.on("context_with_system", (event, ctx) => {
		lastRequest = asSent([...event.messages], ctx.getSystemPrompt());
	});
	// The captured request no longer describes the history the next request will extend.
	pi.on("session_compact", () => {
		lastRequest = undefined;
	});
	pi.on("session_tree", () => {
		lastRequest = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		// A new or resumed session has a different main context; the old branch no longer applies.
		lastRequest = undefined;
		thread?.abort();
		thread = undefined;
		showStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		thread?.abort();
		thread = undefined;
	});
}
