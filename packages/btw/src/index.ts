import { randomUUID } from "node:crypto";
import { convertToLlm, copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type AgentMessage, type BtwTurn, handoffText, mainContext } from "./branch.ts";
import { BtwPanel, type PanelResult } from "./panel.ts";
import { BtwThread } from "./thread.ts";

/** A side conversation and whether it has a reply the user has not seen. */
interface Btw {
	thread: BtwThread;
	unseen: boolean;
}

export default function btwExtension(pi: ExtensionAPI) {
	/** This session's side conversations, most recently used first. */
	let btws: Btw[] = [];
	/** The transcript of the main session's latest provider request. */
	let lastRequest: AgentMessage[] | undefined;
	let open: Btw | undefined;

	const showStatus = (ctx: ExtensionContext) => {
		const replying = btws.filter((b) => b !== open && b.thread.busy).length;
		const ready = btws.filter((b) => b !== open && !b.thread.busy && b.unseen).length;
		const parts = [replying ? `${replying} replying…` : "", ready ? `${ready} ${ready === 1 ? "reply" : "replies"} ready` : ""].filter(Boolean);
		ctx.ui.setStatus("btw", parts.length > 0 ? `btw: ${parts.join(" · ")} (/btw)` : undefined);
	};

	const startBtw = (ctx: ExtensionContext): Btw | undefined => {
		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("/btw needs a selected model", "error");
			return undefined;
		}
		const thinkingLevel = pi.getThinkingLevel();
		const thread = new BtwThread({
			model,
			mainMessages: convertToLlm(mainContext(lastRequest, ctx.sessionManager.buildSessionProjection().messages)),
			streamSimple: (m, context, options) => ctx.modelRegistry.streamSimple(m, context, options),
			reasoning: model.reasoning && thinkingLevel !== "off" ? thinkingLevel : undefined,
			// Its own conversation id: providers that keep per-conversation state (Claude Bridge)
			// must not mix this thread into the main session.
			sessionId: `${ctx.sessionManager.getSessionId()}:btw:${randomUUID().slice(0, 8)}`,
		});
		const btw: Btw = { thread, unseen: false };
		let wasBusy = false;
		thread.onChange(() => {
			if (wasBusy && !thread.busy && open !== btw) btw.unseen = true;
			wasBusy = thread.busy;
			showStatus(ctx);
		});
		return btw;
	};

	const reportError = (ctx: ExtensionContext) => (error: unknown) =>
		ctx.ui.notify(`/btw: ${error instanceof Error ? error.message : String(error)}`, "error");

	/** Shows the panel until the user hides it; the conversation carries on either way. */
	const openPanel = async (ctx: ExtensionContext, btw: Btw) => {
		btws = [btw, ...btws.filter((b) => b !== btw)];
		open = btw;
		btw.unseen = false;
		showStatus(ctx);
		const { thread } = btw;
		let result: PanelResult;
		try {
			result = await ctx.ui.custom<PanelResult>(
				(tui, theme, _keybindings, done) => new BtwPanel(tui, theme, thread, done, reportError(ctx)),
				{ overlay: true, overlayOptions: { anchor: "center", width: "85%", minWidth: 40, maxHeight: "85%" } },
			);
		} finally {
			open = undefined;
			// Opened and hidden without asking anything: nothing to resume.
			if (thread.turns.length === 0 && !thread.busy) btws = btws.filter((b) => b !== btw);
			showStatus(ctx);
		}

		if (result === "copy") {
			await copyToClipboard(handoffText(thread.turns)).then(
				() => ctx.ui.notify("/btw conversation copied", "info"),
				reportError(ctx),
			);
		} else if (result === "send") {
			const turns = thread.turns;
			// Mid-run, steer so the main agent sees it after its current tool batch; idle, start a turn on it.
			pi.sendMessage(
				{ customType: "btw", content: handoffText(turns), display: true, details: { turns } },
				ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" },
			);
		}
	};

	const label = ({ thread, unseen }: Btw): string => {
		const first = thread.turns.find((turn) => turn.role === "user")?.text.replace(/\s+/g, " ") ?? "(nothing asked yet)";
		const state = thread.busy ? "replying…" : unseen ? "reply ready" : `${thread.turns.length} messages`;
		const time = thread.branchedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		return `${first.length > 60 ? `${first.slice(0, 59)}…` : first}  ·  ${time}  ·  ${state}`;
	};

	/** Without earlier side conversations, open a new one; otherwise let the user pick one or start fresh. */
	const pickBtw = async (ctx: ExtensionContext): Promise<Btw | undefined> => {
		if (btws.length === 0) return startBtw(ctx);
		const fresh = "+ New side conversation from here";
		const labels = btws.map(label);
		const choice = await ctx.ui.select("/btw", [fresh, ...labels]);
		if (choice === undefined) return undefined;
		if (choice === fresh) return startBtw(ctx);
		return btws[labels.indexOf(choice)];
	};

	pi.registerCommand("btw", {
		description: "Side conversation branched from here, tools blocked. /btw <question> starts one; /btw resumes one",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw needs the interactive terminal UI", "error");
				return;
			}
			const question = args.trim();
			const btw = question ? startBtw(ctx) : await pickBtw(ctx);
			if (!btw) return;
			if (question) btw.thread.ask(question).catch(reportError(ctx));
			await openPanel(ctx, btw);
		},
	});

	pi.registerMessageRenderer<{ turns?: BtwTurn[] }>("btw", (message, options, theme) => {
		const turns = message.details?.turns ?? [];
		const header = theme.fg("accent", "↩ /btw discussion sent back") + theme.fg("dim", ` (${turns.length} turns)`);
		if (!options.expanded) return new Text(header, 0, 0);
		const body = turns.map((turn) => (turn.role === "user" ? `${theme.fg("accent", "you ›")} ${turn.text}` : turn.text)).join("\n\n");
		return new Text(`${header}\n\n${body}`, 0, 0);
	});

	// Observe only: returning nothing leaves the request as other handlers made it.
	pi.on("context_with_system", (event) => {
		lastRequest = [...event.messages];
	});
	// The captured request no longer describes the history the next request will extend.
	pi.on("session_compact", () => {
		lastRequest = undefined;
	});
	pi.on("session_tree", () => {
		lastRequest = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		// A new or resumed session has a different main context; earlier branches no longer apply.
		lastRequest = undefined;
		for (const btw of btws) btw.thread.abort();
		btws = [];
		showStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		for (const btw of btws) btw.thread.abort();
		btws = [];
	});
}
