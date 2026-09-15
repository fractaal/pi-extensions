import {
	TODO_MAX_TASKS,
	TODO_PLAN_MAX_BYTES,
	TODO_TASK_DESCRIPTION_MAX_LENGTH,
	TODO_TASK_KEY_MAX_LENGTH,
	TODO_TASK_MAX_DEPENDENCIES,
	TODO_TASK_SUBJECT_MAX_LENGTH,
	isTodoState,
	todoPlanUtf8Bytes,
	type TodoRemoval,
	type TodoState,
	type TodoTask,
} from "./todo-contract.ts";

export interface TodoMutation {
	baseRevision?: number;
	tasks: TodoTask[];
	remove?: TodoRemoval[];
}

export type TodoMutationResult =
	| { ok: true; state: TodoState; changed: boolean }
	| { ok: false; error: string };

function cleanTask(task: TodoTask): TodoTask {
	return {
		key: task.key.trim(),
		subject: task.subject.trim(),
		...(task.description?.trim() ? { description: task.description.trim() } : {}),
		status: task.status,
		...(task.dependsOn?.length ? { dependsOn: task.dependsOn.map((key) => key.trim()) } : {}),
	};
}

function findCycle(tasks: readonly TodoTask[]): string[] | null {
	const byKey = new Map(tasks.map((task) => [task.key, task]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const path: string[] = [];

	function visit(key: string): string[] | null {
		if (visiting.has(key)) {
			const start = path.indexOf(key);
			return [...path.slice(start), key];
		}
		if (visited.has(key)) return null;
		visiting.add(key);
		path.push(key);
		for (const dependency of byKey.get(key)?.dependsOn ?? []) {
			const cycle = visit(dependency);
			if (cycle) return cycle;
		}
		path.pop();
		visiting.delete(key);
		visited.add(key);
		return null;
	}

	for (const task of tasks) {
		const cycle = visit(task.key);
		if (cycle) return cycle;
	}
	return null;
}

export function applyTodoMutation(current: TodoState, mutation: TodoMutation): TodoMutationResult {
	if (mutation.baseRevision !== undefined && mutation.baseRevision !== current.revision) {
		return { ok: false, error: `Stale Todo revision ${mutation.baseRevision}; current revision is ${current.revision}. Reload the current plan and retry.` };
	}
	if (mutation.tasks.length > TODO_MAX_TASKS) {
		return { ok: false, error: `Todo plans may contain at most ${TODO_MAX_TASKS} tasks.` };
	}

	const tasks = mutation.tasks.map(cleanTask);
	const removals = new Map<string, string>();
	for (const removal of mutation.remove ?? []) {
		const key = removal.key.trim();
		const reason = removal.reason.trim();
		if (!key || !reason) return { ok: false, error: "Every removed Todo requires a non-empty key and reason." };
		if (key.length > TODO_TASK_KEY_MAX_LENGTH) return { ok: false, error: `Removed Todo key exceeds the ${TODO_TASK_KEY_MAX_LENGTH}-character producer state bound.` };
		if (removals.has(key)) return { ok: false, error: `Todo "${key}" appears more than once in remove.` };
		removals.set(key, reason);
	}

	const byKey = new Map<string, TodoTask>();
	for (const task of tasks) {
		if (!task.key) return { ok: false, error: "Every Todo requires a non-empty key." };
		if (task.key.length > TODO_TASK_KEY_MAX_LENGTH) return { ok: false, error: `Todo key exceeds the ${TODO_TASK_KEY_MAX_LENGTH}-character producer state bound.` };
		if (!task.subject) return { ok: false, error: `Todo "${task.key}" requires a non-empty subject.` };
		if (task.subject.length > TODO_TASK_SUBJECT_MAX_LENGTH) return { ok: false, error: `Todo "${task.key}" subject exceeds the ${TODO_TASK_SUBJECT_MAX_LENGTH}-character producer state bound.` };
		if (task.description && task.description.length > TODO_TASK_DESCRIPTION_MAX_LENGTH) return { ok: false, error: `Todo "${task.key}" description exceeds the ${TODO_TASK_DESCRIPTION_MAX_LENGTH}-character producer state bound.` };
		const dependencies = task.dependsOn ?? [];
		if (dependencies.length > TODO_TASK_MAX_DEPENDENCIES) return { ok: false, error: `Todo "${task.key}" has more than ${TODO_TASK_MAX_DEPENDENCIES} dependencies.` };
		if (dependencies.some((dependency) => dependency.length > TODO_TASK_KEY_MAX_LENGTH)) return { ok: false, error: `Todo "${task.key}" dependency key exceeds the ${TODO_TASK_KEY_MAX_LENGTH}-character producer state bound.` };
		if (byKey.has(task.key)) return { ok: false, error: `Duplicate Todo key: "${task.key}".` };
		if (removals.has(task.key)) return { ok: false, error: `Todo "${task.key}" cannot be retained and removed in the same mutation.` };
		byKey.set(task.key, task);
	}

	for (const previous of current.tasks) {
		if (previous.status !== "completed" && !byKey.has(previous.key) && !removals.has(previous.key)) {
			return { ok: false, error: `Existing unfinished Todo "${previous.key}" was omitted without an explicit removal reason.` };
		}
	}
	for (const key of removals.keys()) {
		if (!current.tasks.some((task) => task.key === key)) {
			return { ok: false, error: `Cannot remove unknown Todo "${key}".` };
		}
	}

	for (const task of tasks) {
		const dependencies = task.dependsOn ?? [];
		if (new Set(dependencies).size !== dependencies.length) {
			return { ok: false, error: `Todo "${task.key}" has a duplicate dependency after normalization.` };
		}
		for (const dependency of dependencies) {
			if (dependency === task.key) return { ok: false, error: `Todo "${task.key}" cannot depend on itself.` };
			if (!byKey.has(dependency)) return { ok: false, error: `Todo "${task.key}" depends on missing Todo "${dependency}".` };
		}
	}
	const cycle = findCycle(tasks);
	if (cycle) return { ok: false, error: `Todo dependencies contain a cycle: ${cycle.join(" -> ")}.` };

	for (const task of tasks) {
		if (task.status === "pending") continue;
		for (const dependency of task.dependsOn ?? []) {
			if (byKey.get(dependency)?.status !== "completed") {
				return { ok: false, error: `Todo "${task.key}" cannot be ${task.status} until dependency "${dependency}" is completed.` };
			}
		}
	}

	if ((mutation.remove?.length ?? 0) === 0 && JSON.stringify(current.tasks.map(cleanTask)) === JSON.stringify(tasks)) {
		return { ok: true, state: structuredClone(current), changed: false };
	}

	const next: TodoState = {
		schemaVersion: 1,
		revision: current.revision + 1,
		tasks,
	};
	if (todoPlanUtf8Bytes(next) > TODO_PLAN_MAX_BYTES) {
		return { ok: false, error: `Todo plan exceeds the ${TODO_PLAN_MAX_BYTES}-byte serialized UTF-8 byte budget.` };
	}
	if (!isTodoState(next)) return { ok: false, error: "Todo mutation exceeds the exported producer state contract." };
	return { ok: true, state: next, changed: true };
}

export function renderTodoPlan(state: TodoState): string {
	const lines = ["Your todo list, as you authored:", `Revision: ${state.revision}`];
	for (const task of state.tasks) {
		const marker = task.status === "completed" ? "[x]" : task.status === "in_progress" ? "[>]" : "[ ]";
		const dependencies = task.dependsOn?.length ? ` (after: ${task.dependsOn.join(", ")})` : "";
		lines.push(`${marker} ${task.key}: ${task.subject}${dependencies}`);
		if (task.description) lines.push(`    ${task.description}`);
	}
	return lines.join("\n");
}

export function renderTodoContext(state: TodoState): string {
	return state.tasks.some((task) => task.status !== "completed") ? renderTodoPlan(state) : "";
}
