import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { isGoalBlockedPause, type GoalState } from "./goal-contract.ts";

export class GoalWidget implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly getState: () => GoalState;
	private readonly isAuditing: () => boolean;

	constructor(tui: TUI, theme: Theme, getState: () => GoalState, isAuditing: () => boolean) {
		this.tui = tui;
		this.theme = theme;
		this.getState = getState;
		this.isAuditing = isAuditing;
	}

	update(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const goal = this.getState().goal;
		if (!goal) return [];
		const blocked = goal.status === "paused" && isGoalBlockedPause(goal.pause);
		const status = this.isAuditing()
			? { icon: "◌", label: "auditing", color: "warning" as const }
			: goal.status === "complete"
				? { icon: "✓", label: "complete", color: "success" as const }
				: goal.status === "paused"
					? { icon: "◐", label: blocked ? "blocked" : "paused", color: "warning" as const }
					: { icon: "●", label: "running", color: "accent" as const };
		const lines = [
			`${this.theme.fg(status.color, status.icon)} ${this.theme.fg(status.color, this.theme.bold("Goal"))} ${this.theme.fg("muted", status.label)}`,
			`${this.theme.fg("dim", "└─")} ${this.theme.fg("text", goal.objective.replace(/\s+/g, " ").trim())}`,
		];
		if (goal.pause) {
			const reason = goal.pause.reason.replace(/\s+/g, " ").trim();
			lines.push(`${this.theme.fg("warning", blocked ? "block proof" : "pause")} ${this.theme.fg("warning", reason)}`);
			if (goal.pause.suggestedAction) lines.push(`${this.theme.fg("dim", blocked ? "unblock" : "next")} ${this.theme.fg("muted", goal.pause.suggestedAction)}`);
		}
		if (goal.lastAuditRejection) {
			lines.push(`${this.theme.fg("warning", "audit")} ${this.theme.fg("muted", goal.lastAuditRejection.report.replace(/\s+/g, " ").trim())}`);
		}
		return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
	}

	invalidate(): void {
		this.update();
	}
}
