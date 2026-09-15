import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import goalExtension from "../extensions/goal.ts";
import {
	LEGACY_MIGRATION_ENTRY,
	planLegacyMigration,
	writeLegacyMigration,
} from "../extensions/legacy-migration.ts";
import { GOAL_OBJECTIVE_MAX_LENGTH, parseGoalState } from "../extensions/goal-contract.ts";
import { TODO_MAX_TASKS, TODO_PLAN_MAX_BYTES, parseTodoState } from "../../todo/extensions/todo-contract.ts";
import { createHarness } from "./harness.ts";

const temporaryDirectories: string[] = [];
afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function legacyGoal(id: string, objective: string) {
	return {
		id,
		objective,
		status: "active",
		autoContinue: true,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		taskList: {
			tasks: [
				{
					id: "implement",
					title: "Implement the feature",
					status: "pending",
					verificationContract: "The behavior works end to end",
					subtasks: [
						{ id: "wire", title: "Wire the runtime", status: "complete" },
						{ id: "verify", title: "Verify the runtime", status: "pending" },
					],
				},
				{ id: "obsolete", title: "Old skipped work", status: "skipped" },
			],
		},
	};
}

test("focused legacy Goal and embedded tasks migrate once without deleting source", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-migration-"));
	temporaryDirectories.push(cwd);
	const directory = path.join(cwd, ".pi", "goals");
	mkdirSync(directory, { recursive: true });
	const sourcePath = path.join(directory, "active_goal_legacy.md");
	const source = `${JSON.stringify(legacyGoal("legacy", "Migrate this Goal"), null, 2)}\n\n# Goal Prompt\n\nMigrate this Goal\n`;
	writeFileSync(sourcePath, source);
	const harness = createHarness([
		{ type: "custom", customType: "pi-goal-focus", data: { version: 1, focusedGoalId: "legacy", reason: "selected" } },
	], cwd);
	const plan = planLegacyMigration(harness.ctx);
	assert.equal(plan.kind, "migrate");
	if (plan.kind !== "migrate") return;
	assert.equal(plan.goal.goal?.objective, "Migrate this Goal");
	assert.deepEqual(plan.todo?.tasks.map((task) => [task.key, task.status]), [
		["implement", "pending"],
		["wire", "completed"],
		["verify", "pending"],
	]);
	assert.match(plan.todo?.tasks[0]?.description ?? "", /Verification guidance/);
	assert.deepEqual(plan.todo?.tasks[2]?.dependsOn, ["wire"], "nested sibling ordering is preserved where valid");

	writeLegacyMigration(harness.pi, plan);
	assert.equal(existsSync(sourcePath), true);
	assert.equal(readFileSync(sourcePath, "utf8"), source, "migration never rewrites or deletes the legacy representation");
	const marker = harness.entries.find((entry) => entry.customType === LEGACY_MIGRATION_ENTRY);
	assert.equal((marker?.data as { sourcePreserved?: boolean }).sourcePreserved, true);
	assert.ok(parseGoalState(harness.entries.find((entry) => entry.customType === "pi-goal-state-v1")?.data));
	assert.ok(parseTodoState(harness.entries.find((entry) => entry.customType === "pi-todo-state-v1")?.data));
	assert.deepEqual(planLegacyMigration(harness.ctx), { kind: "none" }, "a new Goal state makes the one-time migration seam permanently inert on this branch");
	goalExtension(harness.pi);
	const markerCount = harness.entries.filter((entry) => entry.customType === LEGACY_MIGRATION_ENTRY).length;
	await harness.commands.get("goal-migrate")?.handler("", harness.ctx);
	assert.equal(harness.entries.filter((entry) => entry.customType === LEGACY_MIGRATION_ENTRY).length, markerCount, "manual migration cannot overwrite an already migrated Goal");
});

test("latest legacy null state wins and does not resurrect an abandoned Goal", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-migration-abandoned-"));
	temporaryDirectories.push(cwd);
	const harness = createHarness([
		{ type: "custom", customType: "pi-goal-state", data: { goal: legacyGoal("old", "Already abandoned") } },
		{ type: "custom", customType: "pi-goal-state", data: { goal: null } },
	], cwd);
	assert.deepEqual(planLegacyMigration(harness.ctx), { kind: "none" });
});

test("migration never overwrites an existing new Todo plan", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-migration-existing-todo-"));
	temporaryDirectories.push(cwd);
	const harness = createHarness([
		{ type: "custom", customType: "pi-goal-state", data: { goal: legacyGoal("legacy", "Migrate only the Goal") } },
		{ type: "custom", customType: "pi-todo-state-v1", data: { schemaVersion: 1, revision: 3, tasks: [{ key: "keep", subject: "Keep current plan", status: "pending" }] } },
	], cwd);
	const plan = planLegacyMigration(harness.ctx);
	assert.equal(plan.kind, "migrate");
	if (plan.kind === "migrate") assert.equal(plan.todo, null);
});

test("explicit null focus prevents session state from selecting among multiple open Goals", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-migration-null-focus-"));
	temporaryDirectories.push(cwd);
	const directory = path.join(cwd, ".pi", "goals");
	mkdirSync(directory, { recursive: true });
	writeFileSync(path.join(directory, "active_goal_other.md"), JSON.stringify(legacyGoal("other", "Other open Goal")));
	const harness = createHarness([
		{ type: "custom", customType: "pi-goal-state", data: { goal: legacyGoal("session", "Session open Goal") } },
		{ type: "custom", customType: "pi-goal-focus", data: { version: 1, focusedGoalId: null, reason: "explicitly unfocused" } },
	], cwd);
	const plan = planLegacyMigration(harness.ctx);
	assert.equal(plan.kind, "ambiguous");
	if (plan.kind === "ambiguous") assert.deepEqual(plan.candidates.map((item) => item.id).sort(), ["other", "session"]);
});

test("legacy manual-active Goals migrate paused with an honest reason", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-migration-manual-active-"));
	temporaryDirectories.push(cwd);
	const manual = { ...legacyGoal("manual", "Do not surprise me"), autoContinue: false };
	const harness = createHarness([{ type: "custom", customType: "pi-goal-state", data: { goal: manual } }], cwd);
	const plan = planLegacyMigration(harness.ctx);
	assert.equal(plan.kind, "migrate");
	if (plan.kind !== "migrate") return;
	assert.equal(plan.goal.goal?.status, "paused");
	assert.equal(plan.goal.goal?.autoContinue, false);
	assert.match(plan.goal.goal?.pause?.reason ?? "", /continuation was disabled|migrated paused/i);
	assert.ok(parseGoalState(plan.goal));
});

test("over-budget legacy Todo migration rejects before writing either new snapshot", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-migration-budget-"));
	temporaryDirectories.push(cwd);
	const oversized = legacyGoal("oversized", "Oversized embedded plan");
	oversized.taskList.tasks[0]!.title = "🚀".repeat(TODO_PLAN_MAX_BYTES);
	const harness = createHarness([{ type: "custom", customType: "pi-goal-state", data: { goal: oversized } }], cwd);
	assert.throws(() => planLegacyMigration(harness.ctx), /Todo plan exceeds.*UTF-8 byte budget/i);
	assert.equal(harness.entries.some((entry) => entry.customType === "pi-goal-state-v1" || entry.customType === "pi-todo-state-v1"), false);
});

test("legacy migration refuses Goal and Todo producer-bound overflow before writing", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-migration-bounds-"));
	temporaryDirectories.push(cwd);
	const oversizedGoalHarness = createHarness([
		{ type: "custom", customType: "pi-goal-state", data: { goal: legacyGoal("oversized", "x".repeat(GOAL_OBJECTIVE_MAX_LENGTH + 1)) } },
	], cwd);
	assert.throws(() => planLegacyMigration(oversizedGoalHarness.ctx), /Migrated Goal exceeds.*producer state bounds/i);
	assert.equal(oversizedGoalHarness.entries.some((entry) => entry.customType === "pi-goal-state-v1" || entry.customType === "pi-todo-state-v1"), false);

	const tooManyTasks = legacyGoal("too-many", "Too many migrated tasks");
	tooManyTasks.taskList.tasks = Array.from({ length: TODO_MAX_TASKS + 1 }, (_, index) => ({
		id: `task-${index}`,
		title: "x",
		status: "pending" as const,
		verificationContract: "",
		subtasks: [],
	}));
	const oversizedTodoHarness = createHarness([{ type: "custom", customType: "pi-goal-state", data: { goal: tooManyTasks } }], cwd);
	assert.throws(() => planLegacyMigration(oversizedTodoHarness.ctx), /Migrated Todo plan exceeds.*producer state bounds/i);
	assert.equal(oversizedTodoHarness.entries.some((entry) => entry.customType === "pi-goal-state-v1" || entry.customType === "pi-todo-state-v1"), false);
});

test("a stale focus does not defeat an otherwise unambiguous legacy Goal", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-migration-stale-focus-"));
	temporaryDirectories.push(cwd);
	const directory = path.join(cwd, ".pi", "goals");
	mkdirSync(directory, { recursive: true });
	writeFileSync(path.join(directory, "active_goal_only.md"), JSON.stringify(legacyGoal("only", "Only open Goal")));
	const harness = createHarness([{ type: "custom", customType: "pi-goal-focus", data: { focusedGoalId: "missing" } }], cwd);
	const plan = planLegacyMigration(harness.ctx);
	assert.equal(plan.kind, "migrate");
	if (plan.kind === "migrate") assert.equal(plan.candidate.id, "only");
});

test("ambiguous multi-goal legacy state is surfaced rather than guessed", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-migration-ambiguous-"));
	temporaryDirectories.push(cwd);
	const directory = path.join(cwd, ".pi", "goals");
	mkdirSync(directory, { recursive: true });
	writeFileSync(path.join(directory, "active_goal_a.md"), JSON.stringify(legacyGoal("a", "Goal A")));
	writeFileSync(path.join(directory, "active_goal_b.md"), JSON.stringify(legacyGoal("b", "Goal B")));
	const harness = createHarness([], cwd);
	const plan = planLegacyMigration(harness.ctx);
	assert.equal(plan.kind, "ambiguous");
	if (plan.kind === "ambiguous") assert.deepEqual(plan.candidates.map((item) => item.id).sort(), ["a", "b"]);
	assert.equal(harness.entries.some((entry) => entry.customType === "pi-goal-state-v1"), false);
});
