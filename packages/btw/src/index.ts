import { randomUUID } from "node:crypto";
import { convertToLlm, copyToClipboard, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type BtwTurn, handoffText } from "./branch.ts";
import { BtwPanel, type PanelResult } from "./panel.ts";
import { BtwThread } from "./thread.ts";

export default function btwExtension(pi: ExtensionAPI) {
	let thread: BtwThread | undefined;

	const startThread = (ctx: ExtensionCommandContext): BtwThread | undefined => {
		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("/btw needs a selected model", "error");
			return undefined;
		}
		const thinkingLevel = pi.getThinkingLevel();
		return new BtwThread({
			model,
			mainMessages: convertToLlm(ctx.sessionManager.buildSessionProjection().messages),
			streamSimple: (m, context, options) => ctx.modelRegistry.streamSimple(m, context, options),
			reasoning: model.reasoning && thinkingLevel !== "off" ? thinkingLevel : undefined,
			// Its own conversation id: providers that keep per-conversation state (Claude Bridge)
			// must not mix this thread into the main session.
			sessionId: `${ctx.sessionManager.getSessionId()}:btw:${randomUUID().slice(0, 8)}`,
		});
	};

	const reportError = (ctx: ExtensionCommandContext) => (error: unknown) =>
		ctx.ui.notify(`/btw: ${error instanceof Error ? error.message : String(error)}`, "error");

	pi.registerCommand("btw", {
		description: "Side conversation branched from here (tools blocked). /btw <question> starts one; /btw reopens it",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw needs the interactive terminal UI", "error");
				return;
			}
			const question = args.trim();
			if (question || !thread) {
				const next = startThread(ctx);
				if (!next) return;
				thread?.abort();
				thread = next;
			}
			const current = thread;
			if (question) current.ask(question).catch(reportError(ctx));

			const result = await ctx.ui.custom<PanelResult>(
				(tui, theme, _keybindings, done) => new BtwPanel(tui, theme, current, done, reportError(ctx)),
				{ overlay: true, overlayOptions: { anchor: "center", width: "85%", minWidth: 40, maxHeight: "85%" } },
			);

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
		},
	});

	pi.registerMessageRenderer<{ turns?: BtwTurn[] }>("btw", (message, options, theme) => {
		const turns = message.details?.turns ?? [];
		const header = theme.fg("accent", "↩ /btw discussion sent back") + theme.fg("dim", ` (${turns.length} turns)`);
		if (!options.expanded) return new Text(header, 0, 0);
		const body = turns.map((turn) => (turn.role === "user" ? `${theme.fg("accent", "you ›")} ${turn.text}` : turn.text)).join("\n\n");
		return new Text(`${header}\n\n${body}`, 0, 0);
	});

	pi.on("session_start", () => {
		// A new or resumed session has a different main context; the old branch no longer applies.
		thread?.abort();
		thread = undefined;
	});

	pi.on("session_shutdown", () => {
		thread?.abort();
		thread = undefined;
	});
}
