import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	LEGACY_MIGRATION_EVENT,
	TODO_MAX_TASKS,
	TODO_SCHEMA_VERSION,
	TODO_TASK_DESCRIPTION_MAX_LENGTH,
	TODO_TASK_KEY_MAX_LENGTH,
	TODO_TASK_MAX_DEPENDENCIES,
	TODO_TASK_SUBJECT_MAX_LENGTH,
	TODO_STATE_ENTRY,
	TODO_STATE_EVENT,
	TODO_STATE_REQUEST_EVENT,
	parseTodoState,
	type TodoState,
} from "./todo-contract.ts";
import { applyTodoMutation, renderTodoContext, renderTodoPlan } from "./todo-state.ts";

export * from "./todo-contract.ts";
export * from "./todo-state.ts";

const TODO_CONTEXT_GROWTH_TOKENS = 64 * 1024;
const TODO_CHECKPOINT_TYPE = "pi-todo-checkpoint-v1";
const TODO_CHECKPOINT_TEXT = "Todo checkpoint: unfinished items exist. Call get_todo to reconcile the current plan, then use todo only if the plan has meaningfully changed.";
const TODO_PROMPT_GUIDELINE = "Todo state is not repeated automatically. Use get_todo after compaction or handoff, before reporting progress or completion, or whenever current plan state is uncertain; update with todo only after meaningful changes, not every turn.";

const TodoToolParameters = Type.Object({
	baseRevision: Type.Optional(Type.Integer({ minimum: 0, description: "Current Todo revision. Stale revisions are rejected." })),
	tasks: Type.Array(Type.Object({
		key: Type.String({ minLength: 1, maxLength: TODO_TASK_KEY_MAX_LENGTH, description: "Stable string key retained across plan revisions." }),
		subject: Type.String({ minLength: 1, maxLength: TODO_TASK_SUBJECT_MAX_LENGTH, description: "Short description of the work." }),
		description: Type.Optional(Type.String({ minLength: 1, maxLength: TODO_TASK_DESCRIPTION_MAX_LENGTH, description: "Optional implementation or verification guidance." })),
		status: StringEnum(["pending", "in_progress", "completed"] as const),
		dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: TODO_TASK_KEY_MAX_LENGTH }), { maxItems: TODO_TASK_MAX_DEPENDENCIES, uniqueItems: true })),
	}), { maxItems: TODO_MAX_TASKS, description: "The complete retained Todo plan after this update." }),
	remove: Type.Optional(Type.Array(Type.Object({
		key: Type.String({ minLength: 1, maxLength: TODO_TASK_KEY_MAX_LENGTH }),
		reason: Type.String({ minLength: 1, description: "Why this existing Todo is intentionally removed." }),
	}), { description: "Existing unfinished Todos intentionally omitted from tasks, each with a reason." })),
}, { additionalProperties: false });

class TodoWidget implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly getState: () => TodoState;

	constructor(tui: TUI, theme: Theme, getState: () => TodoState) {
		this.tui = tui;
		this.theme = theme;
		this.getState = getState;
	}

	update(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const state = this.getState();
		if (state.tasks.length === 0) return [];
		const completed = state.tasks.filter((task) => task.status === "completed").length;
		const lines = [this.theme.fg("accent", this.theme.bold(`Todos ${completed}/${state.tasks.length}`))];
		for (const task of state.tasks.filter((item) => item.status !== "completed").slice(0, 4)) {
			const marker = task.status === "in_progress" ? this.theme.fg("accent", "●") : this.theme.fg("dim", "○");
			lines.push(`${marker} ${this.theme.fg("muted", task.key)} ${this.theme.fg("text", task.subject)}`);
		}
		const remaining = state.tasks.filter((item) => item.status !== "completed").length - Math.min(4, state.tasks.filter((item) => item.status !== "completed").length);
		if (remaining > 0) lines.push(this.theme.fg("dim", `… ${remaining} more`));
		return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
	}

	invalidate(): void {
		this.update();
	}
}

function emptyState(): TodoState {
	return { schemaVersion: TODO_SCHEMA_VERSION, revision: 0, tasks: [] };
}

function loadState(ctx: ExtensionContext): TodoState {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== TODO_STATE_ENTRY) continue;
		const parsed = parseTodoState(entry.data);
		if (!parsed) throw new Error(`Invalid ${TODO_STATE_ENTRY} snapshot at the active branch leaf; refusing to fall back to older Todo state.`);
		return parsed;
	}
	return emptyState();
}

export default function todoExtension(pi: ExtensionAPI): void {
	let state = emptyState();
	let widget: TodoWidget | null = null;
	let widgetContext: ExtensionContext | null = null;
	let lastExposureTokens: number | null = null;
	let nextTurnCheckpointPending = false;

	function hasUnfinishedTasks(): boolean {
		return state.tasks.some((task) => task.status !== "completed");
	}

	function contextTokens(ctx: ExtensionContext): number | null {
		const tokens = ctx.getContextUsage()?.tokens;
		return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? Math.trunc(tokens) : null;
	}

	function markExposed(ctx: ExtensionContext): void {
		lastExposureTokens = hasUnfinishedTasks() ? contextTokens(ctx) : null;
		nextTurnCheckpointPending = false;
	}

	function queueCheckpoint(ctx: ExtensionContext, deliverAs: "steer" | "nextTurn"): void {
		if (!hasUnfinishedTasks()) return;
		if (deliverAs === "nextTurn" && nextTurnCheckpointPending) {
			lastExposureTokens = contextTokens(ctx);
			return;
		}
		pi.sendMessage({
			customType: TODO_CHECKPOINT_TYPE,
			content: TODO_CHECKPOINT_TEXT,
			display: false,
		}, { deliverAs });
		lastExposureTokens = contextTokens(ctx);
		nextTurnCheckpointPending = deliverAs === "nextTurn";
	}

	function maybeQueueCheckpoint(toolResultsRequireContinuation: boolean, ctx: ExtensionContext): void {
		if (!hasUnfinishedTasks()) {
			lastExposureTokens = null;
			return;
		}
		const currentTokens = contextTokens(ctx);
		if (currentTokens === null) return;
		if (lastExposureTokens === null || currentTokens < lastExposureTokens) {
			lastExposureTokens = currentTokens;
			return;
		}
		if (currentTokens - lastExposureTokens < TODO_CONTEXT_GROWTH_TOKENS) return;
		queueCheckpoint(ctx, toolResultsRequireContinuation ? "steer" : "nextTurn");
	}

	function emitState(): void {
		pi.events.emit(TODO_STATE_EVENT, structuredClone(state));
	}

	function updateWidget(ctx: ExtensionContext): void {
		widgetContext = ctx;
		if (!ctx.hasUI || state.tasks.length === 0) {
			ctx.ui.setWidget("pi-todo", undefined);
			widget = null;
			return;
		}
		if (widget) {
			widget.update();
			return;
		}
		ctx.ui.setWidget("pi-todo", (tui, theme) => {
			widget = new TodoWidget(tui, theme, () => state);
			return widget;
		}, { placement: "aboveEditor" });
	}

	function publish(next: TodoState, ctx: ExtensionContext, persist: boolean): void {
		state = structuredClone(next);
		if (persist) pi.appendEntry(TODO_STATE_ENTRY, state);
		emitState();
		updateWidget(ctx);
	}

	pi.events.on(TODO_STATE_REQUEST_EVENT, () => emitState());
	pi.events.on(LEGACY_MIGRATION_EVENT, (payload) => {
		const raw = payload as { todo?: unknown };
		const migrated = parseTodoState(raw.todo);
		if (!migrated || state.revision !== 0 || state.tasks.length !== 0) return;
		state = migrated;
		emitState();
		if (widgetContext) updateWidget(widgetContext);
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Replace the current branch-local Todo plan with one complete revision. Existing unfinished work must be retained or explicitly removed with a reason.",
		promptSnippet: "Maintain one revisioned, branch-local Todo plan.",
		promptGuidelines: [
			"Use todo when work has several meaningful steps; pass the complete retained plan, not a patch.",
			"Use todo with the current baseRevision and explicitly remove omitted unfinished work with a non-empty reason.",
			TODO_PROMPT_GUIDELINE,
		],
		parameters: TodoToolParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = applyTodoMutation(state, params);
			if (!result.ok) throw new Error(result.error);
			if (!result.changed) {
				markExposed(ctx);
				return {
					content: [{ type: "text", text: `Todo plan unchanged at revision ${state.revision}.` }],
					details: structuredClone(state),
				};
			}
			publish(result.state, ctx, true);
			markExposed(ctx);
			return {
				content: [{ type: "text", text: `Todo plan updated to revision ${state.revision}: ${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"}.` }],
				details: structuredClone(state),
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "todo ") + theme.fg("muted", `${args.tasks?.length ?? 0} tasks`), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = parseTodoState(result.details);
			if (!details) return new Text(theme.fg("error", "Todo update rejected"), 0, 0);
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `revision ${details.revision} · ${details.tasks.length} tasks`), 0, 0);
		},
	});

	pi.registerTool({
		name: "get_todo",
		label: "Get Todo",
		description: "Read the exact current branch-local Todo revision and task list without changing it.",
		promptSnippet: "Read the current branch-local Todo plan when its state is not already clear.",
		promptGuidelines: [TODO_PROMPT_GUIDELINE],
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			markExposed(ctx);
			return {
				content: [{ type: "text", text: renderTodoPlan(state) }],
				details: structuredClone(state),
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", "get_todo"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = parseTodoState(result.details);
			if (!details) return new Text(theme.fg("error", "Todo read failed"), 0, 0);
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `revision ${details.revision} · ${details.tasks.length} tasks`), 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current branch-local Todo plan.",
		handler: async (_args, ctx) => {
			ctx.ui.notify(renderTodoContext(state) || "No Todos.", "info");
		},
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "custom" || event.message.customType !== TODO_CHECKPOINT_TYPE) return;
		markExposed(ctx);
	});

	pi.on("turn_end", (event, ctx) => {
		const continuationEvent = event as typeof event & { toolResultsRequireContinuation?: boolean };
		maybeQueueCheckpoint(continuationEvent.toolResultsRequireContinuation === true, ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		nextTurnCheckpointPending = false;
		state = loadState(ctx);
		emitState();
		updateWidget(ctx);
		queueCheckpoint(ctx, "nextTurn");
	});
	pi.on("session_tree", (_event, ctx) => {
		nextTurnCheckpointPending = false;
		state = loadState(ctx);
		emitState();
		updateWidget(ctx);
		queueCheckpoint(ctx, "nextTurn");
	});
	pi.on("session_compact", (event, ctx) => {
		pi.appendEntry(TODO_STATE_ENTRY, state);
		emitState();
		updateWidget(ctx);
		queueCheckpoint(ctx, event.willRetry ? "steer" : "nextTurn");
	});
}
