import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	GOAL_SCHEMA_VERSION,
	GOAL_STATE_ENTRY,
	isGoalState,
	type Goal,
	type GoalState,
} from "./goal-contract.ts";

export const LEGACY_MIGRATION_ENTRY = "pi-goal-todo-migration-v1";
export const LEGACY_MIGRATION_EVENT = "pi-goal-todo:migrated";
export const TODO_STATE_ENTRY = "pi-todo-state-v1";
// The migration package remains installable without Todo, so its one-time
// adapter mirrors the exported Todo producer bounds and is covered by parity tests.
const TODO_MAX_TASKS = 200;
const TODO_TASK_KEY_MAX_LENGTH = 256;
const TODO_TASK_SUBJECT_MAX_LENGTH = 2_048;
const TODO_TASK_DESCRIPTION_MAX_LENGTH = 16_384;
const TODO_TASK_MAX_DEPENDENCIES = 100;
const TODO_PLAN_MAX_BYTES = 16 * 1024;
const utf8Encoder = new TextEncoder();

interface LegacyTask {
	id: string;
	title: string;
	status: "pending" | "complete" | "skipped";
	verificationContract?: string;
	subtasks?: LegacyTask[];
}

export interface LegacyGoalCandidate {
	id: string;
	objective: string;
	status: "active" | "paused" | "complete";
	autoContinue: boolean;
	createdAt: string;
	updatedAt: string;
	pauseReason?: string;
	pauseSuggestedAction?: string;
	tasks: LegacyTask[];
	source: "session" | "file";
}

export interface LegacyTodoState {
	schemaVersion: 1;
	revision: number;
	tasks: Array<{
		key: string;
		subject: string;
		description?: string;
		status: "pending" | "completed";
		dependsOn?: string[];
	}>;
}

export type LegacyMigrationPlan =
	| { kind: "none" }
	| { kind: "ambiguous"; candidates: LegacyGoalCandidate[] }
	| { kind: "migrate"; candidate: LegacyGoalCandidate; goal: GoalState; todo: LegacyTodoState | null };

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function legacyTask(value: unknown): LegacyTask | null {
	const raw = record(value);
	const id = text(raw?.id);
	const title = text(raw?.title);
	if (!raw || !id || !title) return null;
	const subtasks = Array.isArray(raw.subtasks)
		? raw.subtasks.map(legacyTask).filter((task): task is LegacyTask => task !== null)
		: undefined;
	return {
		id,
		title,
		status: raw.status === "complete" ? "complete" : raw.status === "skipped" ? "skipped" : "pending",
		...(text(raw.verificationContract) ? { verificationContract: text(raw.verificationContract) } : {}),
		...(subtasks?.length ? { subtasks } : {}),
	};
}

function candidate(value: unknown, source: LegacyGoalCandidate["source"]): LegacyGoalCandidate | null {
	const raw = record(value);
	const id = text(raw?.id);
	const objective = text(raw?.objective);
	if (!raw || !id || !objective) return null;
	const taskList = record(raw.taskList);
	const tasks = Array.isArray(taskList?.tasks)
		? taskList.tasks.map(legacyTask).filter((task): task is LegacyTask => task !== null)
		: [];
	return {
		id,
		objective,
		status: raw.status === "complete" ? "complete" : raw.status === "paused" || raw.status === "blocked" || raw.status === "budget_limited" ? "paused" : "active",
		autoContinue: raw.autoContinue !== false,
		createdAt: text(raw.createdAt) ?? new Date().toISOString(),
		updatedAt: text(raw.updatedAt) ?? text(raw.createdAt) ?? new Date().toISOString(),
		...(text(raw.pauseReason) ? { pauseReason: text(raw.pauseReason) } : {}),
		...(text(raw.pauseSuggestedAction) ? { pauseSuggestedAction: text(raw.pauseSuggestedAction) } : {}),
		tasks,
		source,
	};
}

function jsonObjectEnd(content: string): number {
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < content.length; index += 1) {
		const character = content[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === "\"") quoted = false;
			continue;
		}
		if (character === "\"") quoted = true;
		else if (character === "{") depth += 1;
		else if (character === "}" && --depth === 0) return index;
	}
	return -1;
}

function readLegacyGoalFile(file: string): LegacyGoalCandidate | null {
	try {
		if (fs.lstatSync(file).isSymbolicLink()) return null;
		const content = fs.readFileSync(file, "utf8");
		const end = jsonObjectEnd(content);
		if (end < 0) return null;
		return candidate(JSON.parse(content.slice(0, end + 1)), "file");
	} catch {
		return null;
	}
}

function readLegacyGoalDirectories(ctx: ExtensionContext): LegacyGoalCandidate[] {
	const sessionId = ctx.sessionManager.getSessionId();
	const directories = [
		path.join(ctx.cwd, ".pi", "goals", "sessions", sessionId),
		path.join(ctx.cwd, ".pi", "goals"),
	];
	const candidates: LegacyGoalCandidate[] = [];
	for (const directory of directories) {
		try {
			if (fs.lstatSync(directory).isSymbolicLink()) continue;
			for (const name of fs.readdirSync(directory).sort()) {
				if (!/^active_goal_.*\.md$/.test(name)) continue;
				const parsed = readLegacyGoalFile(path.join(directory, name));
				if (parsed && parsed.status !== "complete") candidates.push(parsed);
			}
		} catch {
			// Missing legacy directories are normal.
		}
	}
	return candidates;
}

export function findLegacyGoalCandidates(ctx: ExtensionContext): { focusedId: string | null; candidates: LegacyGoalCandidate[] } {
	const branch = ctx.sessionManager.getBranch();
	let focusedId: string | null = null;
	let sessionCandidate: LegacyGoalCandidate | null = null;
	let sawFocusEntry = false;
	let sawStateEntry = false;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom") continue;
		if (!sawFocusEntry && entry.customType === "pi-goal-focus") {
			sawFocusEntry = true;
			focusedId = text(record(entry.data)?.focusedGoalId) ?? null;
		}
		if (!sawStateEntry && entry.customType === "pi-goal-state") {
			sawStateEntry = true;
			sessionCandidate = candidate(record(entry.data)?.goal, "session");
			if (sessionCandidate?.status === "complete") sessionCandidate = null;
		}
		if (sawFocusEntry && sawStateEntry) break;
	}
	if (!sawFocusEntry && sessionCandidate) focusedId = sessionCandidate.id;

	const byId = new Map<string, LegacyGoalCandidate>();
	for (const item of readLegacyGoalDirectories(ctx)) byId.set(item.id, item);
	if (sessionCandidate) byId.set(sessionCandidate.id, sessionCandidate);
	return { focusedId, candidates: [...byId.values()] };
}

function uniqueKey(raw: string, used: Set<string>): string {
	const base = raw.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
	let key = base;
	let suffix = 2;
	while (used.has(key)) key = `${base}-${suffix++}`;
	used.add(key);
	return key;
}

function validLegacyTodoState(state: LegacyTodoState): boolean {
	return state.tasks.length <= TODO_MAX_TASKS
		&& state.tasks.every((task) => task.key.trim().length > 0 && task.key.length <= TODO_TASK_KEY_MAX_LENGTH
			&& task.subject.trim().length > 0 && task.subject.length <= TODO_TASK_SUBJECT_MAX_LENGTH
			&& (task.description === undefined || (task.description.trim().length > 0 && task.description.length <= TODO_TASK_DESCRIPTION_MAX_LENGTH))
			&& (task.status === "pending" || task.status === "completed")
			&& (task.dependsOn === undefined || (task.dependsOn.length <= TODO_TASK_MAX_DEPENDENCIES
				&& task.dependsOn.every((dependency) => dependency.trim().length > 0 && dependency.length <= TODO_TASK_KEY_MAX_LENGTH)))
		)
		&& utf8Encoder.encode(JSON.stringify(state)).byteLength <= TODO_PLAN_MAX_BYTES;
}

export function migrateLegacyTasks(tasks: readonly LegacyTask[]): LegacyTodoState | null {
	const migrated: LegacyTodoState["tasks"] = [];
	const used = new Set<string>();

	function addSiblings(items: readonly LegacyTask[], parentPath: string[]): void {
		let previous: LegacyTodoState["tasks"][number] | null = null;
		for (const item of items) {
			if (item.status === "skipped") continue;
			const key = uniqueKey(item.id, used);
			const status = item.status === "complete" ? "completed" as const : "pending" as const;
			const safeDependency = previous && (status === "pending" || previous.status === "completed") ? [previous.key] : undefined;
			const descriptionParts = [
				parentPath.length ? `Legacy path: ${[...parentPath, item.title].join(" > ")}.` : undefined,
				item.verificationContract ? `Verification guidance: ${item.verificationContract}` : undefined,
			].filter((part): part is string => !!part);
			const migratedTask: LegacyTodoState["tasks"][number] = {
				key,
				subject: item.title,
				status,
				...(descriptionParts.length ? { description: descriptionParts.join(" ") } : {}),
				...(safeDependency ? { dependsOn: safeDependency } : {}),
			};
			migrated.push(migratedTask);
			previous = migratedTask;
			if (item.subtasks?.length) addSiblings(item.subtasks, [...parentPath, item.title]);
		}
	}

	addSiblings(tasks, []);
	if (migrated.length === 0) return null;
	const state: LegacyTodoState = { schemaVersion: 1, revision: 1, tasks: migrated };
	if (utf8Encoder.encode(JSON.stringify(state)).byteLength > TODO_PLAN_MAX_BYTES) {
		throw new Error(`Migrated Todo plan exceeds the ${TODO_PLAN_MAX_BYTES}-byte serialized UTF-8 byte budget; migration refused without writing new state.`);
	}
	if (!validLegacyTodoState(state)) {
		throw new Error("Migrated Todo plan exceeds the exported producer state bounds; migration refused without writing new state.");
	}
	return state;
}

function branchHasGoalState(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getBranch().some((item) => {
		const entry = item as { type?: string; customType?: string; data?: unknown };
		const data = record(entry.data);
		return entry.type === "custom"
			&& entry.customType === GOAL_STATE_ENTRY
			&& data?.schemaVersion === GOAL_SCHEMA_VERSION
			&& typeof data.revision === "number"
			&& Object.hasOwn(data, "goal");
	});
}

function branchHasTodoState(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getBranch().some((item) => {
		const entry = item as { type?: string; customType?: string; data?: unknown };
		const data = record(entry.data);
		return entry.type === "custom"
			&& entry.customType === TODO_STATE_ENTRY
			&& data?.schemaVersion === 1
			&& Array.isArray(data.tasks);
	});
}

export function planLegacyMigration(ctx: ExtensionContext, selectedGoalId?: string): LegacyMigrationPlan {
	if (branchHasGoalState(ctx)) return { kind: "none" };
	const { focusedId, candidates } = findLegacyGoalCandidates(ctx);
	if (candidates.length === 0) return { kind: "none" };
	let selected = selectedGoalId ? candidates.find((item) => item.id === selectedGoalId) : undefined;
	if (!selected && !selectedGoalId && focusedId) selected = candidates.find((item) => item.id === focusedId);
	if (!selected && !selectedGoalId && candidates.length === 1) selected = candidates[0];
	if (!selected) return { kind: "ambiguous", candidates };

	const migratePaused = selected.status === "paused" || !selected.autoContinue;
	const common = {
		id: selected.id,
		objective: selected.objective,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		createdAt: selected.createdAt,
		updatedAt: selected.updatedAt,
	};
	const goal: Goal = migratePaused
		? {
			...common,
			status: "paused",
			autoContinue: false,
			pause: {
				reason: selected.status === "paused"
					? selected.pauseReason ?? "Paused in the legacy Goal runtime."
					: "Legacy autonomous continuation was disabled; migrated paused to avoid surprising work.",
				...(selected.pauseSuggestedAction ? { suggestedAction: selected.pauseSuggestedAction } : {}),
			},
		}
		: { ...common, status: "active", autoContinue: true };
	const goalState: GoalState = { schemaVersion: GOAL_SCHEMA_VERSION, revision: 1, goal };
	if (!isGoalState(goalState)) {
		throw new Error("Migrated Goal exceeds the exported producer state bounds; migration refused without writing new state.");
	}
	return {
		kind: "migrate",
		candidate: selected,
		goal: goalState,
		todo: branchHasTodoState(ctx) ? null : migrateLegacyTasks(selected.tasks),
	};
}

export function writeLegacyMigration(pi: { appendEntry: (type: string, data: unknown) => void; events: { emit: (channel: string, data: unknown) => void } }, plan: Extract<LegacyMigrationPlan, { kind: "migrate" }>): void {
	if (!isGoalState(plan.goal)) {
		throw new Error("Migrated Goal exceeds the exported producer state bounds; migration refused without writing new state.");
	}
	if (plan.todo && utf8Encoder.encode(JSON.stringify(plan.todo)).byteLength > TODO_PLAN_MAX_BYTES) {
		throw new Error(`Migrated Todo plan exceeds the ${TODO_PLAN_MAX_BYTES}-byte serialized UTF-8 byte budget; migration refused without writing new state.`);
	}
	if (plan.todo && !validLegacyTodoState(plan.todo)) {
		throw new Error("Migrated Todo plan exceeds the exported producer state bounds; migration refused without writing new state.");
	}
	pi.appendEntry(GOAL_STATE_ENTRY, plan.goal);
	if (plan.todo) pi.appendEntry(TODO_STATE_ENTRY, plan.todo);
	pi.appendEntry(LEGACY_MIGRATION_ENTRY, {
		schemaVersion: 1,
		status: "complete",
		selectedLegacyGoalId: plan.candidate.id,
		migratedAt: new Date().toISOString(),
		sourcePreserved: true,
	});
	pi.events.emit(LEGACY_MIGRATION_EVENT, { goal: plan.goal, todo: plan.todo });
}
