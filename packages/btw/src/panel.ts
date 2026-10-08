import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, Markdown, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { BtwThread } from "./thread.ts";

export type PanelResult = "close" | "send" | "copy";

const HINTS = "enter ask · esc close/stop · ctrl+s send to main · ctrl+y copy · pgup/pgdn scroll";

/** Height of the bordered chrome around the transcript: top border, divider, input, hints, bottom border. */
const CHROME_ROWS = 5;

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

export class BtwPanel implements Component, Focusable {
	private readonly input = new Input({ prompt: "› " });
	private readonly markdown: Markdown[] = [];
	/** Rows scrolled up from the end of the transcript; 0 follows new output. */
	private scrollUp = 0;
	private lastBodyHeight = 0;
	private readonly unsubscribe: () => void;
	private _focused = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly thread: BtwThread,
		private readonly done: (result: PanelResult) => void,
		private readonly onError: (error: unknown) => void,
	) {
		this.input.onSubmit = (value) => this.submit(value);
		this.unsubscribe = thread.onChange(() => this.tui.requestRender());
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	dispose(): void {
		this.unsubscribe();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.thread.busy) this.thread.abort();
			else this.done("close");
		} else if (matchesKey(data, "ctrl+s")) {
			if (!this.thread.busy && this.thread.turns.length > 0) this.done("send");
		} else if (matchesKey(data, "ctrl+y")) {
			if (this.thread.turns.length > 0) this.done("copy");
		} else if (matchesKey(data, "pageUp")) {
			this.scrollUp += Math.max(1, this.lastBodyHeight - 2);
		} else if (matchesKey(data, "pageDown")) {
			this.scrollUp = Math.max(0, this.scrollUp - Math.max(1, this.lastBodyHeight - 2));
		} else {
			this.input.handleInput(data);
		}
		this.tui.requestRender();
	}

	invalidate(): void {
		this.input.invalidate();
		for (const markdown of this.markdown) markdown.invalidate();
	}

	render(width: number): string[] {
		const th = this.theme;
		const inner = Math.max(10, width - 4);
		const border = (s: string) => th.fg("border", s);
		const row = (content: string) => `${border("│")} ${truncateToWidth(content, inner, "", true)} ${border("│")}`;

		const usage = this.thread.lastUsage;
		const cache = usage && usage.input > 0 ? ` · cache ${Math.round((100 * usage.cached) / usage.input)}% of ${formatTokens(usage.input)}` : "";
		const title = ` btw · ${this.thread.model.id} · branched ${this.thread.branchedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${cache} · tools blocked `;
		const top = border("╭─") + th.fg("accent", truncateToWidth(title, inner)) + border(`${"─".repeat(Math.max(0, inner - visibleWidth(title)))}─╮`);

		const body = this.transcript(inner);
		const bodyHeight = Math.max(3, Math.floor(this.tui.terminal.rows * 0.85) - CHROME_ROWS);
		this.lastBodyHeight = bodyHeight;
		this.scrollUp = Math.min(this.scrollUp, Math.max(0, body.length - bodyHeight));
		const end = body.length - this.scrollUp;
		const visible = body.slice(Math.max(0, end - bodyHeight), end);
		while (visible.length < bodyHeight) visible.push("");

		const scrolled = this.scrollUp > 0 ? th.fg("warning", ` ↑ ${this.scrollUp} more below `) : "";
		const divider = border("├") + scrolled + border(`${"─".repeat(Math.max(0, inner + 2 - visibleWidth(scrolled)))}┤`);

		return [
			top,
			...visible.map(row),
			divider,
			row(this.input.render(inner)[0] ?? ""),
			row(th.fg("dim", HINTS)),
			border(`╰${"─".repeat(inner + 2)}╯`),
		];
	}

	private transcript(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const turns = this.thread.turns;
		turns.forEach((turn, index) => {
			if (index > 0) lines.push("");
			if (turn.role === "user") {
				lines.push(...wrapTextWithAnsi(th.fg("accent", "you › ") + turn.text, width));
				return;
			}
			if (turn.text) {
				const markdown = (this.markdown[index] ??= new Markdown("", 0, 0, getMarkdownTheme()));
				markdown.setText(turn.text);
				lines.push(...markdown.render(width));
			}
			for (const name of turn.blockedTools) lines.push(th.fg("dim", `⊘ ${name} blocked (tools don't run in /btw)`));
			if (turn.error) lines.push(...wrapTextWithAnsi(th.fg("error", turn.error), width));
		});
		if (this.thread.waiting) lines.push(th.fg("dim", "thinking…"));
		if (turns.length === 0) lines.push(th.fg("dim", "Ask anything about the session so far. Tool calls are blocked here."));
		return lines;
	}

	private submit(value: string): void {
		const text = value.trim();
		if (!text || this.thread.busy) return;
		this.input.setValue("");
		this.scrollUp = 0;
		this.thread.ask(text).catch(this.onError);
	}
}
