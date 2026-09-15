import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
	TODO_MAX_TASKS,
	TODO_PLAN_MAX_BYTES,
	TODO_STATE_ENTRY,
	TODO_TASK_DESCRIPTION_MAX_LENGTH,
	TODO_TASK_KEY_MAX_LENGTH,
	TODO_TASK_MAX_DEPENDENCIES,
	TODO_TASK_SUBJECT_MAX_LENGTH,
	TODO_STATE_EVENT,
	TODO_STATE_REQUEST_EVENT,
	parseTodoState,
	todoPlanUtf8Bytes,
	type TodoState,
	type TodoTask,
} from "../../todo/extensions/todo-contract.ts";
import { applyTodoMutation, renderTodoContext } from "../../todo/extensions/todo-state.ts";
import todoExtension from "../../todo/extensions/todo.ts";
import { createHarness, executeTool } from "./harness.ts";

const temporaryDirectories: string[] = [];
afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function baseState(): TodoState {
	return {
		schemaVersion: 1,
		revision: 4,
		tasks: [
			{ key: "implement", subject: "Implement it", status: "in_progress" },
			{ key: "verify", subject: "Verify it", status: "pending", dependsOn: ["implement"] },
		],
	};
}

test("unfinished Todos cannot disappear and stale revisions leave state unchanged", () => {
	const current = baseState();
	const omitted = applyTodoMutation(current, {
		baseRevision: 4,
		tasks: [{ key: "implement", subject: "Implement it", status: "in_progress" }],
	});
	assert.equal(omitted.ok, false);
	if (!omitted.ok) assert.match(omitted.error, /verify.*omitted/i);
	assert.deepEqual(current, baseState(), "rejected mutation does not alter current state");

	const stale = applyTodoMutation(current, { baseRevision: 3, tasks: current.tasks });
	assert.equal(stale.ok, false);
	if (!stale.ok) assert.match(stale.error, /Stale Todo revision 3/);
	assert.deepEqual(current, baseState());
});

test("explicit removals work while dependency cycles and premature progress are rejected", () => {
	const current = baseState();
	const removed = applyTodoMutation(current, {
		baseRevision: 4,
		tasks: [{ key: "implement", subject: "Implement it", status: "in_progress" }],
		remove: [{ key: "verify", reason: "The user removed the verification step" }],
	});
	assert.equal(removed.ok, true);
	if (removed.ok) assert.equal(removed.state.revision, 5);

	const prunedCompleted = applyTodoMutation({ schemaVersion: 1, revision: 2, tasks: [{ key: "done", subject: "Already done", status: "completed" }] }, {
		baseRevision: 2,
		tasks: [],
	});
	assert.equal(prunedCompleted.ok, true, "completed history may leave the current working plan without a removal ceremony");

	const cycle = applyTodoMutation({ schemaVersion: 1, revision: 0, tasks: [] }, {
		tasks: [
			{ key: "a", subject: "A", status: "pending", dependsOn: ["b"] },
			{ key: "b", subject: "B", status: "pending", dependsOn: ["a"] },
		],
	});
	assert.equal(cycle.ok, false);
	if (!cycle.ok) assert.match(cycle.error, /cycle/i);

	const premature = applyTodoMutation({ schemaVersion: 1, revision: 0, tasks: [] }, {
		tasks: [
			{ key: "a", subject: "A", status: "pending" },
			{ key: "b", subject: "B", status: "in_progress", dependsOn: ["a"] },
		],
	});
	assert.equal(premature.ok, false);
	if (!premature.ok) assert.match(premature.error, /until dependency "a" is completed/);
});

function latestTodoState(entries: Array<Record<string, unknown>>): TodoState {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.customType !== TODO_STATE_ENTRY) continue;
		const state = parseTodoState(entry.data);
		if (state) return state;
	}
	throw new Error("No Todo state entry");
}

test("normalized identical Todo replacements are factual and side-effect free", async () => {
	const current = baseState();
	const pure = applyTodoMutation(current, {
		baseRevision: current.revision,
		tasks: [
			{ key: " implement ", subject: " Implement it ", status: "in_progress" },
			{ key: "verify", subject: "Verify it", status: "pending", dependsOn: [" implement "] },
		],
	});
	assert.equal(pure.ok, true);
	if (pure.ok) {
		assert.equal(pure.changed, false);
		assert.deepEqual(pure.state, current);
	}

	const cwd = mkdtempSync(path.join(tmpdir(), "portable-todo-idempotent-"));
	temporaryDirectories.push(cwd);
	const harness = createHarness([{ type: "custom", customType: TODO_STATE_ENTRY, data: current }], cwd);
	todoExtension(harness.pi);
	await harness.run("session_start", { reason: "startup" });
	const beforeEntries = harness.entries.length;
	const beforeEvents = harness.events.emitted.length;
	const result = await executeTool(harness, "todo", {
		baseRevision: current.revision,
		tasks: [
			{ key: " implement ", subject: " Implement it ", status: "in_progress" },
			{ key: "verify", subject: "Verify it", status: "pending", dependsOn: [" implement "] },
		],
	});
	assert.deepEqual(result.content, [{ type: "text", text: `Todo plan unchanged at revision ${current.revision}.` }]);
	assert.equal(harness.entries.length, beforeEntries);
	assert.equal(harness.events.emitted.length, beforeEvents);
	assert.deepEqual(latestTodoState(harness.entries), current);
});

test("Todo context is passive, exact-framed, revisioned, and complete when unfinished work exists", async () => {
	const rendered = renderTodoContext({
		schemaVersion: 1,
		revision: 9,
		tasks: [
			{ key: "done", subject: "Completed task", description: "Keep completed context available", status: "completed" },
			{ key: "next", subject: "Next task", description: "Current work detail", status: "in_progress", dependsOn: ["done"] },
		],
	});
	assert.match(rendered, /^Your todo list, as you authored:\nRevision: 9/);
	assert.ok(rendered.includes("[x] done: Completed task"));
	assert.match(rendered, /Keep completed context available/);
	assert.ok(rendered.includes("[>] next: Next task (after: done)"));
	assert.match(rendered, /Current work detail/);
	assert.doesNotMatch(rendered, /Use the todo tool|Never omit|update this complete plan/);
});

test("Todo extension persists exact snapshots and exposes a read-only retrieval tool without a context transform", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "portable-todo-"));
	temporaryDirectories.push(cwd);
	const harness = createHarness([], cwd);
	todoExtension(harness.pi);
	await harness.run("session_start", { reason: "startup" });
	assert.equal(harness.handlers.has("context"), false, "Todo registers no per-provider context transform");
	await executeTool(harness, "todo", {
		baseRevision: 0,
		tasks: [
			{ key: "implement", subject: "Implement the runtime", status: "in_progress" },
			{ key: "verify", subject: "Verify native replay", status: "pending", dependsOn: ["implement"] },
		],
	});
	const revisionOne = structuredClone(latestTodoState(harness.entries));
	assert.equal(revisionOne.revision, 1);
	const revisionOneEnd = harness.entries.length;
	const eventsBeforeRead = harness.events.emitted.length;
	const read = await executeTool(harness, "get_todo", {});
	assert.match(read.content?.[0]?.text ?? "", /Your todo list, as you authored:/);
	assert.match(read.content?.[0]?.text ?? "", /Revision: 1/);
	assert.match(read.content?.[0]?.text ?? "", /verify: Verify native replay/);
	assert.deepEqual(read.details, revisionOne);
	assert.equal(harness.entries.length, revisionOneEnd, "read appends no producer state");
	assert.equal(harness.events.emitted.length, eventsBeforeRead, "read emits no producer state event");

	await executeTool(harness, "todo", {
		baseRevision: 1,
		tasks: [
			{ key: "implement", subject: "Implement the runtime", status: "completed" },
			{ key: "verify", subject: "Verify native replay", status: "in_progress", dependsOn: ["implement"] },
		],
	});
	assert.equal(latestTodoState(harness.entries).revision, 2);

	harness.entries.splice(revisionOneEnd);
	await harness.run("session_tree", {});
	assert.equal(latestTodoState(harness.entries).revision, 1, "tree navigation restores the branch's exact latest snapshot");

	const beforeCompact = harness.entries.length;
	await harness.run("session_compact", { willRetry: false });
	assert.equal(harness.entries.length, beforeCompact + 1);
	assert.equal(latestTodoState(harness.entries).revision, 1, "compaction checkpoint does not invent a revision");

	const received: unknown[] = [];
	harness.events.on(TODO_STATE_EVENT, (data) => received.push(structuredClone(data)));
	harness.events.emit(TODO_STATE_REQUEST_EVENT, {});
	assert.equal(parseTodoState(received.at(-1))?.revision, 1);
});

test("unfinished Todo checkpoints follow context distance without waking an otherwise idle model", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "portable-todo-checkpoint-"));
	temporaryDirectories.push(cwd);
	const initial = baseState();
	const harness = createHarness([{ type: "custom", customType: TODO_STATE_ENTRY, data: initial }], cwd);
	harness.setContextUsage(10_000);
	todoExtension(harness.pi);
	await harness.run("session_start", { reason: "resume" });
	assert.deepEqual(harness.sent, [{
		message: {
			customType: "pi-todo-checkpoint-v1",
			content: "Todo checkpoint: unfinished items exist. Call get_todo to reconcile the current plan, then use todo only if the plan has meaningfully changed.",
			display: false,
		},
		options: { deliverAs: "nextTurn" },
	}], "resume queues one durable checkpoint for the next external turn without waking the model");
	assert.match((harness.tools.get("todo")?.promptGuidelines ?? []).join("\n"), /get_todo.*compaction.*handoff/i);

	harness.setContextUsage(75_535);
	await harness.run("turn_end", { message: { role: "assistant", stopReason: "toolUse", content: [] }, toolResults: [] });
	assert.equal(harness.sent.length, 1, "less than 64 Ki context growth adds no checkpoint");
	harness.setContextUsage(75_536);
	await harness.run("turn_end", { message: { role: "assistant", stopReason: "toolUse", content: [] }, toolResults: [], toolResultsRequireContinuation: true });
	assert.deepEqual(harness.sent.at(-1)?.options, { deliverAs: "steer" }, "tool-loop checkpoint joins the provider call already required by tool use");
	assert.equal(harness.sent.length, 2);

	harness.setContextUsage(80_000);
	await harness.run("turn_end", { message: { role: "assistant", stopReason: "toolUse", content: [] }, toolResults: [], toolResultsRequireContinuation: true });
	assert.equal(harness.sent.length, 2, "checkpoint resets the context-distance baseline and does not nag every turn");

	harness.setContextUsage(141_072);
	await executeTool(harness, "get_todo", {});
	harness.setContextUsage(150_000);
	await harness.run("turn_end", { message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] });
	assert.equal(harness.sent.length, 2, "Todo read resets salience distance without mutating state");

	harness.setContextUsage(206_608);
	await harness.run("turn_end", { message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [], toolResultsRequireContinuation: false });
	assert.deepEqual(harness.sent.at(-1)?.options, { deliverAs: "nextTurn" }, "a stopping turn defers the checkpoint rather than creating another provider call");
	assert.equal(harness.sent.length, 3);
	await harness.run("message_start", {
		message: {
			role: "custom",
			customType: "pi-todo-checkpoint-v1",
			content: "Todo checkpoint",
			display: false,
			timestamp: Date.now(),
		},
	});

	harness.setContextUsage(272_144);
	await harness.run("turn_end", { message: { role: "assistant", stopReason: "toolUse", content: [] }, toolResults: [] });
	assert.deepEqual(harness.sent.at(-1)?.options, { deliverAs: "nextTurn" }, "older Pi versions without continuation truth fail safely without steering");
	assert.equal(harness.sent.length, 4);
	harness.setContextUsage(337_680);
	await harness.run("turn_end", { message: { role: "assistant", stopReason: "toolUse", content: [] }, toolResults: [] });
	assert.equal(harness.sent.length, 4, "rolling fallback queues only one checkpoint before the next external turn");
	await harness.run("message_start", {
		message: {
			role: "custom",
			customType: "pi-todo-checkpoint-v1",
			content: "Todo checkpoint",
			display: false,
			timestamp: Date.now(),
		},
	});
	harness.setContextUsage(403_216);
	await harness.run("turn_end", { message: { role: "assistant", stopReason: "toolUse", content: [] }, toolResults: [] });
	assert.equal(harness.sent.length, 5, "delivery clears the fallback latch for a later context-distance checkpoint");
});

test("compaction checkpoints unfinished Todo state only into an inevitable retry or next external turn", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "portable-todo-compaction-checkpoint-"));
	temporaryDirectories.push(cwd);
	const harness = createHarness([{ type: "custom", customType: TODO_STATE_ENTRY, data: baseState() }], cwd);
	harness.setContextUsage(90_000);
	todoExtension(harness.pi);
	await harness.run("session_start", { reason: "startup" });
	harness.sent.length = 0;

	await harness.run("session_compact", { willRetry: true });
	assert.deepEqual(harness.sent.at(-1)?.options, { deliverAs: "steer" });
	assert.equal(latestTodoState(harness.entries).revision, 4);
	await harness.run("session_compact", { willRetry: false });
	assert.deepEqual(harness.sent.at(-1)?.options, { deliverAs: "nextTurn" });
	assert.equal(latestTodoState(harness.entries).revision, 4, "compaction salience does not mutate Todo revision");
});

test("an invalid newest Todo snapshot fails loud instead of resurrecting older work", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "portable-todo-corrupt-"));
	temporaryDirectories.push(cwd);
	const harness = createHarness([
		{ type: "custom", customType: TODO_STATE_ENTRY, data: { schemaVersion: 1, revision: 1, tasks: [{ key: "old", subject: "Must not be resurrected", status: "pending" }] } },
		{ type: "custom", customType: TODO_STATE_ENTRY, data: { schemaVersion: 1, revision: 2, tasks: [{ broken: true }] } },
	], cwd);
	todoExtension(harness.pi);
	await assert.rejects(() => harness.run("session_start", {}), /refusing to fall back to older Todo state/);
});

test("Todo tool rejects dependencies that collide after normalization and preserves reloadable state", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "portable-todo-normalized-deps-"));
	temporaryDirectories.push(cwd);
	const initial: TodoState = { schemaVersion: 1, revision: 1, tasks: [{ key: "keep", subject: "Keep me", status: "pending" }] };
	const harness = createHarness([{ type: "custom", customType: TODO_STATE_ENTRY, data: initial }], cwd);
	todoExtension(harness.pi);
	await harness.run("session_start", { reason: "startup" });
	const before = harness.entries.length;
	await assert.rejects(() => executeTool(harness, "todo", {
		baseRevision: 1,
		tasks: [
			{ key: "keep", subject: "Keep me", status: "pending" },
			{ key: "next", subject: "Next", status: "pending", dependsOn: ["keep", " keep "] },
		],
	}), /duplicate dependenc/i);
	assert.equal(harness.entries.length, before);
	await harness.run("session_tree", {});
	assert.deepEqual(latestTodoState(harness.entries), initial);
});

test("Todo mutations accept exact bounds and reject max+1 atomically", async () => {
	const empty: TodoState = { schemaVersion: 1, revision: 0, tasks: [] };
	const minimalTasks = (count: number) => Array.from({ length: count }, (_, index) => ({ key: `t${index}`, subject: "x", status: "pending" as const }));
	const atTaskMax = applyTodoMutation(empty, { tasks: minimalTasks(TODO_MAX_TASKS) });
	assert.equal(atTaskMax.ok, true);
	if (atTaskMax.ok) assert.equal(atTaskMax.state.tasks.length, TODO_MAX_TASKS);
	const overTaskMax = applyTodoMutation(empty, { tasks: minimalTasks(TODO_MAX_TASKS + 1) });
	assert.equal(overTaskMax.ok, false);
	if (!overTaskMax.ok) assert.match(overTaskMax.error, /at most 200 tasks/i);

	const overBoundCases: Array<[string, TodoTask, RegExp]> = [
		["key", { key: "k".repeat(TODO_TASK_KEY_MAX_LENGTH + 1), subject: "x", status: "pending" as const }, /key exceeds/i],
		["subject", { key: "k", subject: "x".repeat(TODO_TASK_SUBJECT_MAX_LENGTH + 1), status: "pending" as const }, /subject exceeds/i],
		["description", { key: "k", subject: "x", description: "x".repeat(TODO_TASK_DESCRIPTION_MAX_LENGTH + 1), status: "pending" as const }, /description exceeds/i],
		["dependency key", { key: "k", subject: "x", status: "pending" as const, dependsOn: ["d".repeat(TODO_TASK_KEY_MAX_LENGTH + 1)] }, /dependency key exceeds/i],
		["dependency count", { key: "k", subject: "x", status: "pending" as const, dependsOn: Array.from({ length: TODO_TASK_MAX_DEPENDENCIES + 1 }, (_, index) => `d${index}`) }, /more than 100 dependencies/i],
	];
	for (const [label, task, pattern] of overBoundCases) {
		const result = applyTodoMutation(empty, { tasks: [task] });
		assert.equal(result.ok, false, `${label} max+1 rejects`);
		if (!result.ok) assert.match(result.error, pattern);
	}

	const cwd = mkdtempSync(path.join(tmpdir(), "portable-todo-count-bound-"));
	temporaryDirectories.push(cwd);
	const initial: TodoState = { schemaVersion: 1, revision: 1, tasks: [{ key: "keep", subject: "Keep me", status: "pending" }] };
	const harness = createHarness([{ type: "custom", customType: TODO_STATE_ENTRY, data: initial }], cwd);
	todoExtension(harness.pi);
	await harness.run("session_start", { reason: "startup" });
	const beforeEntries = harness.entries.length;
	const beforeEvents = harness.events.emitted.length;
	await assert.rejects(() => executeTool(harness, "todo", {
		baseRevision: 1,
		tasks: [{ key: "keep", subject: "Keep me", status: "pending" }, ...minimalTasks(TODO_MAX_TASKS)],
	}), /at most 200 tasks/i);
	assert.equal(harness.entries.length, beforeEntries, "over-bound update appends no state");
	assert.equal(harness.events.emitted.length, beforeEvents, "over-bound update emits no state");
	assert.deepEqual(latestTodoState(harness.entries), initial, "over-bound update leaves current state exact");
});

test("Todo plan budget rejects atomically while context compacts completed work", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "portable-todo-budget-"));
	temporaryDirectories.push(cwd);
	const initial: TodoState = { schemaVersion: 1, revision: 1, tasks: [{ key: "keep", subject: "Keep me", status: "pending" }] };
	const harness = createHarness([{ type: "custom", customType: TODO_STATE_ENTRY, data: initial }], cwd);
	todoExtension(harness.pi);
	await harness.run("session_start", { reason: "startup" });
	const before = harness.entries.length;
	const oversizedDescription = "x".repeat(TODO_TASK_DESCRIPTION_MAX_LENGTH);
	await assert.rejects(() => executeTool(harness, "todo", {
		baseRevision: 1,
		tasks: [{ key: "keep", subject: "Keep me", description: oversizedDescription, status: "pending" }],
	}), /plan exceeds.*UTF-8 byte budget/i);
	assert.equal(harness.entries.length, before);
	assert.deepEqual(latestTodoState(harness.entries), initial);
	assert.ok(todoPlanUtf8Bytes({ ...initial, tasks: [{ ...initial.tasks[0]!, description: oversizedDescription }] }) > TODO_PLAN_MAX_BYTES);

	const rendered = renderTodoContext({
		schemaVersion: 1,
		revision: 2,
		tasks: [
			{ key: "done", subject: "Long completed subject", description: "Completed detail should not recur", status: "completed" },
			{ key: "next", subject: "Legible unfinished subject", description: "Keep this actionable detail", status: "in_progress", dependsOn: ["done"] },
		],
	});
	assert.match(rendered, /Your todo list, as you authored:/);
	assert.match(rendered, /Revision: 2/);
	assert.match(rendered, /next: Legible unfinished subject/);
	assert.match(rendered, /Keep this actionable detail/);
	assert.match(rendered, /done: Long completed subject/);
	assert.match(rendered, /Completed detail should not recur/);
	assert.doesNotMatch(rendered, /Use the todo tool|Never omit unfinished work/);
});

test("complete-only Todo plans queue no checkpoint while remaining readable", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "portable-todo-complete-context-"));
	temporaryDirectories.push(cwd);
	const complete: TodoState = { schemaVersion: 1, revision: 3, tasks: [{ key: "done", subject: "Done", description: "Historical detail", status: "completed" }] };
	const harness = createHarness([{ type: "custom", customType: TODO_STATE_ENTRY, data: complete }], cwd);
	todoExtension(harness.pi);
	await harness.run("session_start", { reason: "startup" });
	assert.equal(harness.sent.length, 0);
	await harness.run("session_tree", {});
	assert.equal(harness.sent.length, 0, "restoring a complete-only branch queues no checkpoint");
	assert.equal(renderTodoContext(complete), "");
	const read = await executeTool(harness, "get_todo", {});
	assert.match(read.content?.[0]?.text ?? "", /\[x\] done: Done/);
	assert.deepEqual(read.details, complete);
});

test("Todo tool rejects unexplained omission without appending state", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "portable-todo-reject-"));
	temporaryDirectories.push(cwd);
	const initial: TodoState = { schemaVersion: 1, revision: 1, tasks: [{ key: "keep", subject: "Keep me", status: "pending" }] };
	const harness = createHarness([{ type: "custom", customType: TODO_STATE_ENTRY, data: initial }], cwd);
	todoExtension(harness.pi);
	await harness.run("session_start", { reason: "startup" });
	harness.events.emit("pi-goal-todo:migrated", { todo: { schemaVersion: 1, revision: 99, tasks: [{ key: "overwrite", subject: "Must not replace current work", status: "pending" }] } });
	const read = await executeTool(harness, "get_todo", {});
	assert.match(read.content?.[0]?.text ?? "", /keep: Keep me/);
	const before = harness.entries.length;
	await assert.rejects(() => executeTool(harness, "todo", { baseRevision: 1, tasks: [] }), /omitted without an explicit removal reason/);
	assert.equal(harness.entries.length, before);
	assert.deepEqual(latestTodoState(harness.entries), initial);
});
