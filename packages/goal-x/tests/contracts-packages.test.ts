import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
	GOAL_AUDIT_REJECTION_REPORT_MAX_LENGTH,
	GOAL_BLOCKER_MAX_LENGTH,
	GOAL_BLOCK_EVIDENCE_MAX_LENGTH,
	GOAL_BLOCK_EVIDENCE_SEPARATOR,
	GOAL_BLOCK_NO_AUTONOMOUS_PATH_MAX_LENGTH,
	GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR,
	GOAL_COMPLETION_AUDITOR_REPORT_MAX_LENGTH,
	GOAL_COMPLETION_SUMMARY_MAX_LENGTH,
	GOAL_ID_MAX_LENGTH,
	GOAL_OBJECTIVE_MAX_LENGTH,
	GOAL_PAUSE_REASON_MAX_LENGTH,
	GOAL_PAUSE_SUGGESTED_ACTION_MAX_LENGTH,
	GOAL_TIMESTAMP_MAX_LENGTH,
	GOAL_UNBLOCK_CONDITION_MAX_LENGTH,
	GoalProposalSchema,
	GoalStateSchema,
	goalBlockedPause,
	isGoalBlockedPause,
	parseGoalBlockedPause,
	isGoalProposal,
	isGoalState,
} from "../extensions/goal-contract.ts";
import { createGoalTranscriptEvent, GOAL_TRANSCRIPT_DATA_MAX_BYTES, GOAL_TRANSCRIPT_EVENT_KINDS, isGoalTranscriptEvent, parseGoalTranscriptEvent } from "../extensions/goal-transcript-events.ts";
import {
	TODO_MAX_TASKS,
	TODO_PLAN_MAX_BYTES,
	TODO_TASK_DESCRIPTION_MAX_LENGTH,
	TODO_TASK_KEY_MAX_LENGTH,
	TODO_TASK_MAX_DEPENDENCIES,
	TODO_TASK_SUBJECT_MAX_LENGTH,
	TodoStateSchema,
	TodoTaskSchema,
	isTodoState,
	isTodoTask,
	todoPlanUtf8Bytes,
} from "../../todo/extensions/todo-contract.ts";

function sourceFiles(root: string): string[] {
	const result: string[] = [];
	for (const name of readdirSync(root)) {
		const file = path.join(root, name);
		if (statSync(file).isDirectory()) result.push(...sourceFiles(file));
		else if (file.endsWith(".ts")) result.push(file);
	}
	return result;
}

test("Goal and Todo runtime validators enforce exact versioned snapshots", () => {
	const goal = {
		schemaVersion: 1,
		revision: 2,
		goal: {
			id: "g",
			objective: "Do the work",
			status: "active",
			autoContinue: true,
			usage: { tokensUsed: 10, activeSeconds: 2 },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:01.000Z",
		},
	};
	assert.equal(isGoalState(goal), true);
	assert.equal(isGoalState({ ...goal, extra: true }), false);
	assert.equal(isGoalState({ ...goal, schemaVersion: 2 }), false);
	assert.equal(isGoalState({ ...goal, goal: { ...goal.goal, autoContinue: false } }), false, "active Goals must continue");
	assert.equal(isGoalState({ ...goal, goal: { ...goal.goal, status: "paused", autoContinue: true } }), false, "paused Goals cannot continue");
	assert.equal(isGoalState({ ...goal, goal: { ...goal.goal, status: "complete", autoContinue: true } }), false, "complete Goals cannot continue");

	const todo = { schemaVersion: 1, revision: 1, tasks: [{ key: "a", subject: "A", status: "pending" }] };
	assert.equal(isTodoState(todo), true);
	assert.equal(isTodoState({ ...todo, tasks: [{ ...todo.tasks[0], owner: "Aria" }] }), false);
	assert.equal(isTodoState({ ...todo, revision: -1 }), false);
});

test("Goal state and proposal bounds are a strict Protocol 6 subset", () => {
	assert.deepEqual({
		id: GOAL_ID_MAX_LENGTH,
		objective: GOAL_OBJECTIVE_MAX_LENGTH,
		timestamp: GOAL_TIMESTAMP_MAX_LENGTH,
		pauseReason: GOAL_PAUSE_REASON_MAX_LENGTH,
		pauseSuggestedAction: GOAL_PAUSE_SUGGESTED_ACTION_MAX_LENGTH,
		auditRejectionReport: GOAL_AUDIT_REJECTION_REPORT_MAX_LENGTH,
		completionSummary: GOAL_COMPLETION_SUMMARY_MAX_LENGTH,
		completionAuditorReport: GOAL_COMPLETION_AUDITOR_REPORT_MAX_LENGTH,
	}, {
		id: 256,
		objective: 128 * 1024,
		timestamp: 64,
		pauseReason: 2_048,
		pauseSuggestedAction: 2_048,
		auditRejectionReport: 12_000,
		completionSummary: 4_000,
		completionAuditorReport: 12_000,
	});
	const text = (length: number) => "x".repeat(length);
	const baseGoal = {
		id: "g",
		objective: "o",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		createdAt: "t",
		updatedAt: "t",
		pause: { reason: "r", suggestedAction: "s" },
		lastAuditRejection: { rejectedAt: "t", report: "r" },
		completion: { approvedAt: "t", summary: "s", auditorReport: "r" },
	};
	const state = (goal: Record<string, unknown>) => ({ schemaVersion: 1, revision: 1, goal });
	const cases = [
		["id", state({ ...baseGoal, id: text(GOAL_ID_MAX_LENGTH) }), state({ ...baseGoal, id: text(GOAL_ID_MAX_LENGTH + 1) })],
		["objective", state({ ...baseGoal, objective: text(GOAL_OBJECTIVE_MAX_LENGTH) }), state({ ...baseGoal, objective: text(GOAL_OBJECTIVE_MAX_LENGTH + 1) })],
		["createdAt", state({ ...baseGoal, createdAt: text(GOAL_TIMESTAMP_MAX_LENGTH) }), state({ ...baseGoal, createdAt: text(GOAL_TIMESTAMP_MAX_LENGTH + 1) })],
		["updatedAt", state({ ...baseGoal, updatedAt: text(GOAL_TIMESTAMP_MAX_LENGTH) }), state({ ...baseGoal, updatedAt: text(GOAL_TIMESTAMP_MAX_LENGTH + 1) })],
		["pause reason", state({ ...baseGoal, pause: { ...baseGoal.pause, reason: text(GOAL_PAUSE_REASON_MAX_LENGTH) } }), state({ ...baseGoal, pause: { ...baseGoal.pause, reason: text(GOAL_PAUSE_REASON_MAX_LENGTH + 1) } })],
		["pause suggested action", state({ ...baseGoal, pause: { ...baseGoal.pause, suggestedAction: text(GOAL_PAUSE_SUGGESTED_ACTION_MAX_LENGTH) } }), state({ ...baseGoal, pause: { ...baseGoal.pause, suggestedAction: text(GOAL_PAUSE_SUGGESTED_ACTION_MAX_LENGTH + 1) } })],
		["audit rejectedAt", state({ ...baseGoal, lastAuditRejection: { ...baseGoal.lastAuditRejection, rejectedAt: text(GOAL_TIMESTAMP_MAX_LENGTH) } }), state({ ...baseGoal, lastAuditRejection: { ...baseGoal.lastAuditRejection, rejectedAt: text(GOAL_TIMESTAMP_MAX_LENGTH + 1) } })],
		["audit rejection report", state({ ...baseGoal, lastAuditRejection: { ...baseGoal.lastAuditRejection, report: text(GOAL_AUDIT_REJECTION_REPORT_MAX_LENGTH) } }), state({ ...baseGoal, lastAuditRejection: { ...baseGoal.lastAuditRejection, report: text(GOAL_AUDIT_REJECTION_REPORT_MAX_LENGTH + 1) } })],
		["completion approvedAt", state({ ...baseGoal, completion: { ...baseGoal.completion, approvedAt: text(GOAL_TIMESTAMP_MAX_LENGTH) } }), state({ ...baseGoal, completion: { ...baseGoal.completion, approvedAt: text(GOAL_TIMESTAMP_MAX_LENGTH + 1) } })],
		["completion summary", state({ ...baseGoal, completion: { ...baseGoal.completion, summary: text(GOAL_COMPLETION_SUMMARY_MAX_LENGTH) } }), state({ ...baseGoal, completion: { ...baseGoal.completion, summary: text(GOAL_COMPLETION_SUMMARY_MAX_LENGTH + 1) } })],
		["completion auditor report", state({ ...baseGoal, completion: { ...baseGoal.completion, auditorReport: text(GOAL_COMPLETION_AUDITOR_REPORT_MAX_LENGTH) } }), state({ ...baseGoal, completion: { ...baseGoal.completion, auditorReport: text(GOAL_COMPLETION_AUDITOR_REPORT_MAX_LENGTH + 1) } })],
	] as const;
	for (const [label, atMax, overMax] of cases) {
		assert.equal(Value.Check(GoalStateSchema, atMax), true, `${label} schema accepts max`);
		assert.equal(isGoalState(atMax), true, `${label} validator accepts max`);
		assert.equal(Value.Check(GoalStateSchema, overMax), false, `${label} schema rejects max+1`);
		assert.equal(isGoalState(overMax), false, `${label} validator rejects max+1`);
	}

	const proposal = (objective: string, currentObjective: string) => ({ schemaVersion: 1, revision: 1, proposal: { kind: "tweak", objective, currentObjective } });
	for (const [label, atMax, overMax] of [
		["proposal objective", proposal(text(GOAL_OBJECTIVE_MAX_LENGTH), "current"), proposal(text(GOAL_OBJECTIVE_MAX_LENGTH + 1), "current")],
		["proposal current objective", proposal("next", text(GOAL_OBJECTIVE_MAX_LENGTH)), proposal("next", text(GOAL_OBJECTIVE_MAX_LENGTH + 1))],
	] as const) {
		assert.equal(Value.Check(GoalProposalSchema, atMax), true, `${label} schema accepts max`);
		assert.equal(isGoalProposal(atMax), true, `${label} validator accepts max`);
		assert.equal(Value.Check(GoalProposalSchema, overMax), false, `${label} schema rejects max+1`);
		assert.equal(isGoalProposal(overMax), false, `${label} validator rejects max+1`);
	}
});

test("strict blocked proof maps into the unchanged paused-state contract", () => {
	assert.deepEqual({
		blocker: GOAL_BLOCKER_MAX_LENGTH,
		evidence: GOAL_BLOCK_EVIDENCE_MAX_LENGTH,
		whyNoAutonomousPathRemains: GOAL_BLOCK_NO_AUTONOMOUS_PATH_MAX_LENGTH,
		unblockCondition: GOAL_UNBLOCK_CONDITION_MAX_LENGTH,
	}, { blocker: 600, evidence: 600, whyNoAutonomousPathRemains: 600, unblockCondition: 2_000 });
	const proof = {
		blocker: "b".repeat(GOAL_BLOCKER_MAX_LENGTH),
		evidence: "e".repeat(GOAL_BLOCK_EVIDENCE_MAX_LENGTH),
		whyNoAutonomousPathRemains: "w".repeat(GOAL_BLOCK_NO_AUTONOMOUS_PATH_MAX_LENGTH),
		unblockCondition: "u".repeat(GOAL_UNBLOCK_CONDITION_MAX_LENGTH),
	};
	const pause = goalBlockedPause(proof);
	assert.deepEqual(Object.keys(pause).sort(), ["reason", "suggestedAction"]);
	assert.ok(pause.reason.length <= GOAL_PAUSE_REASON_MAX_LENGTH);
	assert.ok((pause.suggestedAction?.length ?? 0) <= GOAL_PAUSE_SUGGESTED_ACTION_MAX_LENGTH);
	assert.equal(isGoalBlockedPause(pause), true);
	assert.deepEqual(parseGoalBlockedPause(pause), pause, "the parser returns exact validated pause bytes rather than claiming a unique field partition");
	assert.equal(isGoalBlockedPause({ reason: "Paused by user." }), false);
	const malformedLegacyPauses = [
		["empty sections", { reason: "Blocker: \nEvidence: \nWhy no autonomous path remains: ", suggestedAction: "Resume after the decision." }],
		["whitespace sections", { reason: "Blocker:   \nEvidence: evidence\nWhy no autonomous path remains: why", suggestedAction: "resume" }],
		["misordered sections", { reason: "Blocker: blocker\nWhy no autonomous path remains: why\nEvidence: evidence", suggestedAction: "resume" }],
		["missing evidence section", { reason: "Blocker: blocker\nWhy no autonomous path remains: why", suggestedAction: "resume" }],
		["missing no-path section", { reason: "Blocker: blocker\nEvidence: evidence", suggestedAction: "resume" }],
		["empty unblock condition", { reason: "Blocker: blocker\nEvidence: evidence\nWhy no autonomous path remains: why", suggestedAction: "   " }],
	] as const;
	const markerTokens = [
		"plain",
		`left${GOAL_BLOCK_EVIDENCE_SEPARATOR}right`,
		`left${GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR}right`,
		`left${GOAL_BLOCK_EVIDENCE_SEPARATOR}middle${GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR}right`,
		`left${GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR}middle${GOAL_BLOCK_EVIDENCE_SEPARATOR}right`,
		`left${GOAL_BLOCK_EVIDENCE_SEPARATOR}a${GOAL_BLOCK_EVIDENCE_SEPARATOR}right`,
		`left${GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR}a${GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR}right`,
	];
	let canonicalCases = 0;
	for (const blocker of markerTokens) {
		for (const evidence of markerTokens) {
			for (const whyNoAutonomousPathRemains of markerTokens) {
				const markerPause = goalBlockedPause({ blocker, evidence, whyNoAutonomousPathRemains, unblockCondition: "resume" });
				assert.deepEqual(parseGoalBlockedPause(markerPause), markerPause, "valid 0.28.7 proof bytes survive without a field-partition claim");
				canonicalCases += 1;
			}
		}
	}
	assert.equal(canonicalCases, 343, "the complete marker-placement matrix is covered");
	for (const [label, malformedPause] of malformedLegacyPauses) {
		assert.equal(parseGoalBlockedPause(malformedPause), null, `${label} has no complete producer proof`);
		assert.equal(isGoalBlockedPause(malformedPause), false, `${label} remains a human or legacy pause`);
		const malformedState = {
			schemaVersion: 1,
			revision: 1,
			goal: {
				id: "legacy",
				objective: "Preserve the historical pause",
				status: "paused",
				autoContinue: false,
				usage: { tokensUsed: 0, activeSeconds: 0 },
				createdAt: "t",
				updatedAt: "t",
				pause: malformedPause,
			},
		};
		assert.equal(isGoalState(malformedState), label !== "empty unblock condition", `${label} keeps its existing state validity`);
	}
	assert.equal(isGoalState({
		schemaVersion: 1,
		revision: 1,
		goal: {
			id: "g",
			objective: "o",
			status: "paused",
			autoContinue: false,
			usage: { tokensUsed: 0, activeSeconds: 0 },
			createdAt: "t",
			updatedAt: "t",
			pause,
		},
	}), true);
	for (const [field, maxLength] of [
		["blocker", GOAL_BLOCKER_MAX_LENGTH],
		["evidence", GOAL_BLOCK_EVIDENCE_MAX_LENGTH],
		["whyNoAutonomousPathRemains", GOAL_BLOCK_NO_AUTONOMOUS_PATH_MAX_LENGTH],
		["unblockCondition", GOAL_UNBLOCK_CONDITION_MAX_LENGTH],
	] as const) {
		assert.throws(() => goalBlockedPause({ ...proof, [field]: "x".repeat(maxLength + 1) }), new RegExp(`${field} exceeds`, "i"));
		assert.throws(() => goalBlockedPause({ ...proof, [field]: "   " }), new RegExp(`requires non-empty ${field}`, "i"));
	}
});

test("Todo task, count, and byte bounds are a strict Protocol 6 subset", () => {
	assert.deepEqual({
		tasks: TODO_MAX_TASKS,
		key: TODO_TASK_KEY_MAX_LENGTH,
		subject: TODO_TASK_SUBJECT_MAX_LENGTH,
		description: TODO_TASK_DESCRIPTION_MAX_LENGTH,
		dependencies: TODO_TASK_MAX_DEPENDENCIES,
		planBytes: TODO_PLAN_MAX_BYTES,
	}, { tasks: 200, key: 256, subject: 2_048, description: 16_384, dependencies: 100, planBytes: 16 * 1024 });
	const text = (length: number) => "x".repeat(length);
	const baseTask = { key: "a", subject: "A", status: "pending" as const };
	const dependencies = (count: number) => Array.from({ length: count }, (_, index) => `d${index}`);
	const cases = [
		["key", { ...baseTask, key: text(TODO_TASK_KEY_MAX_LENGTH) }, { ...baseTask, key: text(TODO_TASK_KEY_MAX_LENGTH + 1) }],
		["subject", { ...baseTask, subject: text(TODO_TASK_SUBJECT_MAX_LENGTH) }, { ...baseTask, subject: text(TODO_TASK_SUBJECT_MAX_LENGTH + 1) }],
		["description", { ...baseTask, description: text(TODO_TASK_DESCRIPTION_MAX_LENGTH) }, { ...baseTask, description: text(TODO_TASK_DESCRIPTION_MAX_LENGTH + 1) }],
		["dependency key", { ...baseTask, dependsOn: [text(TODO_TASK_KEY_MAX_LENGTH)] }, { ...baseTask, dependsOn: [text(TODO_TASK_KEY_MAX_LENGTH + 1)] }],
		["dependency count", { ...baseTask, dependsOn: dependencies(TODO_TASK_MAX_DEPENDENCIES) }, { ...baseTask, dependsOn: dependencies(TODO_TASK_MAX_DEPENDENCIES + 1) }],
	] as const;
	for (const [label, atMax, overMax] of cases) {
		assert.equal(Value.Check(TodoTaskSchema, atMax), true, `${label} schema accepts max`);
		assert.equal(isTodoTask(atMax), true, `${label} validator accepts max`);
		assert.equal(Value.Check(TodoTaskSchema, overMax), false, `${label} schema rejects max+1`);
		assert.equal(isTodoTask(overMax), false, `${label} validator rejects max+1`);
	}

	const minimalTasks = (count: number) => Array.from({ length: count }, (_, index) => ({ key: `t${index}`, subject: "x", status: "pending" as const }));
	const atTaskMax = { schemaVersion: 1 as const, revision: 1, tasks: minimalTasks(TODO_MAX_TASKS) };
	const overTaskMax = { schemaVersion: 1 as const, revision: 1, tasks: minimalTasks(TODO_MAX_TASKS + 1) };
	assert.ok(todoPlanUtf8Bytes(atTaskMax) <= TODO_PLAN_MAX_BYTES, "200 minimal tasks remain below the independent byte cap");
	assert.equal(Value.Check(TodoStateSchema, atTaskMax), true);
	assert.equal(isTodoState(atTaskMax), true);
	assert.equal(Value.Check(TodoStateSchema, overTaskMax), false, "201 minimal tasks fail the schema count bound");
	assert.equal(isTodoState(overTaskMax), false, "201 minimal tasks fail the manual count bound");

	const shell = { schemaVersion: 1 as const, revision: 1, tasks: [{ ...baseTask, description: "" }] };
	const exactDescription = text(TODO_PLAN_MAX_BYTES - todoPlanUtf8Bytes(shell));
	const atByteMax = { ...shell, tasks: [{ ...baseTask, description: exactDescription }] };
	const overByteMax = { ...shell, tasks: [{ ...baseTask, description: `${exactDescription}x` }] };
	assert.equal(todoPlanUtf8Bytes(atByteMax), TODO_PLAN_MAX_BYTES);
	assert.equal(isTodoState(atByteMax), true, "manual validator accepts the exact serialized byte cap");
	assert.equal(todoPlanUtf8Bytes(overByteMax), TODO_PLAN_MAX_BYTES + 1);
	assert.equal(isTodoState(overByteMax), false, "manual validator rejects one byte over the serialized cap");
});

test("Goal transcript payload remains bounded at the producer boundary", () => {
	const event = createGoalTranscriptEvent({
		kind: "goal_completion_rejected",
		level: "warning",
		goalId: "goal",
		objective: "目标🚀".repeat(20_000),
		auditorReport: "audit".repeat(20_000),
		message: "Completion rejected.",
		tuiMessage: "Completion rejected.",
	});
	const { tuiMessage: _tuiMessage, ...goal } = event;
	assert.ok(new TextEncoder().encode(JSON.stringify({ goal })).byteLength <= GOAL_TRANSCRIPT_DATA_MAX_BYTES);
	assert.equal(event.message, "Completion rejected.");
	assert.equal(isGoalTranscriptEvent(event), true);
	assert.deepEqual(parseGoalTranscriptEvent(event), event);
	assert.equal(isGoalTranscriptEvent({ ...event, mode: "sisyphus" }), false);
	assert.equal(isGoalTranscriptEvent({ ...event, kind: "goal_drafting_started" }), false);
	assert.ok(GOAL_TRANSCRIPT_EVENT_KINDS.includes("goal_blocked"));
	const blockedPause = goalBlockedPause({
		blocker: "The required API is unavailable.",
		evidence: "The configured endpoints were checked.",
		whyNoAutonomousPathRemains: "Every remaining step requires that API.",
		unblockCondition: "The API becomes available.",
	});
	const blockedEvent = createGoalTranscriptEvent({
		kind: "goal_blocked",
		level: "warning",
		reason: blockedPause.reason,
		suggestedAction: blockedPause.suggestedAction,
		message: `${blockedPause.reason}\nUnblock condition: ${blockedPause.suggestedAction}`,
		tuiMessage: "Goal blocked: The required API is unavailable.",
	});
	assert.equal(isGoalTranscriptEvent(blockedEvent), true);
	assert.deepEqual(parseGoalTranscriptEvent(blockedEvent), blockedEvent);
	for (const [label, malformedPause] of [
		["empty sections", { reason: "Blocker: \nEvidence: \nWhy no autonomous path remains: ", suggestedAction: "resume" }],
		["misordered sections", { reason: "Blocker: blocker\nWhy no autonomous path remains: why\nEvidence: evidence", suggestedAction: "resume" }],
		["incomplete sections", { reason: "Blocker: blocker\nEvidence: evidence", suggestedAction: "resume" }],
		["empty unblock", { reason: "Blocker: blocker\nEvidence: evidence\nWhy no autonomous path remains: why", suggestedAction: "   " }],
	] as const) {
		const malformedEvent = { ...blockedEvent, ...malformedPause };
		assert.equal(isGoalTranscriptEvent(malformedEvent), false, `${label} cannot validate as goal_blocked`);
		assert.equal(parseGoalTranscriptEvent(malformedEvent), null, `${label} cannot parse as goal_blocked`);
		assert.throws(() => createGoalTranscriptEvent({
			kind: "goal_blocked",
			level: "warning",
			...malformedPause,
			message: "Malformed blocked receipt.",
			tuiMessage: "Goal blocked",
		}), /complete block proof/i, `${label} cannot be produced as goal_blocked`);
	}
	assert.equal(isGoalTranscriptEvent({ ...event, kind: "goal_notice", message: undefined }), false);
	assert.equal(isGoalTranscriptEvent({ ...event, kind: "goal_error", message: "   " }), false);
	assert.equal(isGoalTranscriptEvent({ ...event, kind: "goal_notice", message: "Safe native notice." }), true);
	assert.throws(() => createGoalTranscriptEvent({ kind: "goal_error", level: "error", message: "", tuiMessage: "Error" }), /non-empty message/i);
	for (const kind of ["goal_notice", "goal_error"] as const) {
		const normalized = createGoalTranscriptEvent({ kind, level: kind === "goal_error" ? "error" : "info", message: `${" ".repeat(4_000)}x`, tuiMessage: "Bounded message" });
		assert.equal(normalized.message, "x", `${kind} normalizes required message text before bounding`);
		assert.equal(isGoalTranscriptEvent(normalized), true, `${kind} producer output validates against its public contract`);
	}
});

test("the three packages are independently installable and product-agnostic", () => {
	type PackageManifest = {
		name: string;
		main?: string;
		types?: string;
		exports?: Record<string, { types?: string; default?: string }>;
		dependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
		pi?: { extensions?: string[] };
	};
	const goalPackage = JSON.parse(readFileSync("package.json", "utf8")) as PackageManifest;
	const todoPackage = JSON.parse(readFileSync("../todo/package.json", "utf8")) as PackageManifest;
	const contextWindowPackage = JSON.parse(readFileSync("../context-window/package.json", "utf8")) as PackageManifest;
	assert.equal(goalPackage.name, "@fractaal/pi-goal-x");
	assert.equal(todoPackage.name, "@fractaal/pi-todo");
	assert.deepEqual(goalPackage.pi?.extensions, ["extensions/goal.ts"]);
	assert.deepEqual(todoPackage.pi?.extensions, ["extensions/todo.ts"]);
	assert.equal(todoPackage.main, "./dist/todo.js");
	assert.equal(todoPackage.types, "./dist/todo.d.ts");
	assert.equal(contextWindowPackage.name, "@fractaal/pi-context-window");
	assert.deepEqual(contextWindowPackage.pi?.extensions, ["extensions/context-window.ts"]);
	assert.equal(contextWindowPackage.main, "./dist/context-window.js");
	assert.equal(contextWindowPackage.types, "./dist/context-window.d.ts");
	assert.deepEqual(todoPackage.exports, {
		".": { types: "./dist/todo.d.ts", default: "./dist/todo.js" },
		"./contracts": { types: "./dist/todo-contract.d.ts", default: "./dist/todo-contract.js" },
	});
	assert.deepEqual(contextWindowPackage.exports, {
		".": { types: "./dist/context-window.d.ts", default: "./dist/context-window.js" },
		"./contracts": { types: "./dist/context-window-contract.d.ts", default: "./dist/context-window-contract.js" },
	});
	assert.equal(goalPackage.dependencies, undefined);
	assert.equal(todoPackage.dependencies, undefined);
	assert.deepEqual(contextWindowPackage.dependencies, { "proper-lockfile": "4.1.2" });
	assert.deepEqual(goalPackage.peerDependencies, {
		"@earendil-works/pi-ai": "*",
		"@earendil-works/pi-coding-agent": ">=0.84.1",
		"@earendil-works/pi-tui": "*",
		typebox: "*",
	});
	assert.deepEqual(contextWindowPackage.peerDependencies, {
		"@earendil-works/pi-ai": "*",
		"@earendil-works/pi-coding-agent": ">=0.84.1",
	});
	assert.deepEqual(todoPackage.peerDependencies, {
		"@earendil-works/pi-ai": "*",
		"@earendil-works/pi-coding-agent": "*",
		"@earendil-works/pi-tui": "*",
		typebox: "*",
	});
	const lockfile = JSON.parse(readFileSync("../../package-lock.json", "utf8")) as { packages?: Record<string, PackageManifest> };
	assert.deepEqual(lockfile.packages?.["packages/goal-x"]?.peerDependencies, goalPackage.peerDependencies, "workspace lockfile mirrors Goal peer metadata");

	const forbiddenImport = /from\s+["'][^"']*(?:symphony|aria-chat|aria-local|gateway|rtdb|react|ipc)[^"']*["']/i;
	for (const file of [...sourceFiles("extensions"), ...sourceFiles("../todo/extensions"), ...sourceFiles("../context-window/extensions")]) {
		assert.doesNotMatch(readFileSync(file, "utf8"), forbiddenImport, `${file} must stay product-agnostic`);
	}
	for (const file of sourceFiles("../todo/extensions")) {
		assert.doesNotMatch(readFileSync(file, "utf8"), /from\s+["'][^"']*goal[^"']*["']/i, `${file} must not depend on Goal runtime code`);
	}
	for (const file of sourceFiles("extensions")) {
		if (file.endsWith("legacy-migration.ts")) continue;
		assert.doesNotMatch(readFileSync(file, "utf8"), /from\s+["'][^"']*todo[^"']*["']/i, `${file} must not depend on Todo runtime code`);
	}
});

test("obsolete Goal-owned task, focus, questionnaire, drafting, and Sisyphus machinery is gone", () => {
	assert.equal(GOAL_TRANSCRIPT_EVENT_KINDS.some((kind) => kind.includes("draft") || kind.includes("focus")), false);
	const names = sourceFiles("extensions").map((file) => path.basename(file));
	for (const obsolete of ["goal-questionnaire.ts", "goal-draft.ts", "goal-pool.ts", "goal-task-tools.ts", "goal-runtime.ts", "goal-service.ts"]) {
		assert.equal(names.includes(obsolete), false, obsolete);
	}
});
