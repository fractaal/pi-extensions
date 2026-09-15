import { Type, type Static } from "typebox";

export const TODO_SCHEMA_VERSION = 1 as const;
export const TODO_STATE_ENTRY = "pi-todo-state-v1";
export const TODO_STATE_EVENT = "pi-todo:state";
export const TODO_STATE_REQUEST_EVENT = "pi-todo:request-state";
export const LEGACY_MIGRATION_EVENT = "pi-goal-todo:migrated";
export const TODO_MAX_TASKS = 200;
export const TODO_TASK_KEY_MAX_LENGTH = 256;
export const TODO_TASK_SUBJECT_MAX_LENGTH = 2_048;
export const TODO_TASK_DESCRIPTION_MAX_LENGTH = 16_384;
export const TODO_TASK_MAX_DEPENDENCIES = 100;
export const TODO_PLAN_MAX_BYTES = 16 * 1024;
const utf8Encoder = new TextEncoder();

export const TodoTaskSchema = Type.Object({
	key: Type.String({ minLength: 1, maxLength: TODO_TASK_KEY_MAX_LENGTH }),
	subject: Type.String({ minLength: 1, maxLength: TODO_TASK_SUBJECT_MAX_LENGTH }),
	description: Type.Optional(Type.String({ minLength: 1, maxLength: TODO_TASK_DESCRIPTION_MAX_LENGTH })),
	status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
	dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: TODO_TASK_KEY_MAX_LENGTH }), { maxItems: TODO_TASK_MAX_DEPENDENCIES, uniqueItems: true })),
}, { additionalProperties: false });

export const TodoStateSchema = Type.Object({
	schemaVersion: Type.Literal(TODO_SCHEMA_VERSION),
	revision: Type.Integer({ minimum: 0 }),
	tasks: Type.Array(TodoTaskSchema, { maxItems: TODO_MAX_TASKS }),
}, { additionalProperties: false });

export const TodoRemovalSchema = Type.Object({
	key: Type.String({ minLength: 1, maxLength: TODO_TASK_KEY_MAX_LENGTH }),
	reason: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export type TodoTask = Static<typeof TodoTaskSchema>;
export type TodoState = Static<typeof TodoStateSchema>;
export type TodoRemoval = Static<typeof TodoRemovalSchema>;

export function todoPlanUtf8Bytes(state: TodoState): number {
	return utf8Encoder.encode(JSON.stringify(state)).byteLength;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function nonEmptyString(value: unknown, maxLength = Number.POSITIVE_INFINITY): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function hasOnlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
	const keys = new Set(allowed);
	return Object.keys(raw).every((key) => keys.has(key));
}

export function isTodoTask(value: unknown): value is TodoTask {
	const raw = record(value);
	if (!raw || !hasOnlyKeys(raw, ["key", "subject", "description", "status", "dependsOn"]) || !nonEmptyString(raw.key, TODO_TASK_KEY_MAX_LENGTH) || !nonEmptyString(raw.subject, TODO_TASK_SUBJECT_MAX_LENGTH)) return false;
	if (raw.description !== undefined && !nonEmptyString(raw.description, TODO_TASK_DESCRIPTION_MAX_LENGTH)) return false;
	if (raw.status !== "pending" && raw.status !== "in_progress" && raw.status !== "completed") return false;
	if (raw.dependsOn !== undefined) {
		if (!Array.isArray(raw.dependsOn) || raw.dependsOn.length > TODO_TASK_MAX_DEPENDENCIES || !raw.dependsOn.every((dependency) => nonEmptyString(dependency, TODO_TASK_KEY_MAX_LENGTH))) return false;
		const dependencies = raw.dependsOn as string[];
		if (dependencies.some((dependency) => dependency !== dependency.trim())) return false;
		if (new Set(dependencies).size !== dependencies.length) return false;
	}
	return true;
}

export function isTodoState(value: unknown): value is TodoState {
	const raw = record(value);
	return !!raw && hasOnlyKeys(raw, ["schemaVersion", "revision", "tasks"])
		&& raw.schemaVersion === TODO_SCHEMA_VERSION
		&& typeof raw.revision === "number" && Number.isSafeInteger(raw.revision) && raw.revision >= 0
		&& Array.isArray(raw.tasks) && raw.tasks.length <= TODO_MAX_TASKS && raw.tasks.every(isTodoTask)
		&& todoPlanUtf8Bytes(raw as TodoState) <= TODO_PLAN_MAX_BYTES;
}

export function parseTodoState(value: unknown): TodoState | null {
	return isTodoState(value) ? structuredClone(value) : null;
}
