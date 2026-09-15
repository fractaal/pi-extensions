import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import goalExtension from "../extensions/goal.ts";
import { goalBlockedPause } from "../extensions/goal-contract.ts";
import todoExtension from "../../todo/extensions/todo.ts";
import { createHarness } from "./harness.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
const tui = { requestRender: () => {} } as unknown as TUI;

function widgetFactory(harness: ReturnType<typeof createHarness>, key: string): (tui: TUI, theme: Theme) => Component {
	let value: unknown;
	for (let index = harness.widgets.length - 1; index >= 0; index -= 1) {
		if (harness.widgets[index]?.key !== key) continue;
		value = harness.widgets[index]?.value;
		break;
	}
	assert.equal(typeof value, "function", `${key} registered a native component factory`);
	return value as (tui: TUI, theme: Theme) => Component;
}

test("native Goal widget keeps one restrained status hierarchy at narrow widths", async () => {
	const harness = createHarness([{
		type: "custom",
		customType: "pi-goal-state-v1",
		data: {
			schemaVersion: 1,
			revision: 3,
			goal: {
				id: "goal",
				objective: "Ship the deliberately long portable Goal objective without losing hierarchy",
				status: "paused",
				autoContinue: false,
				usage: { tokensUsed: 0, activeSeconds: 0 },
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:01.000Z",
				pause: { reason: "Need user input", suggestedAction: "Provide the missing value" },
			},
		},
	}]);
	goalExtension(harness.pi);
	await harness.run("session_start", {});
	const lines = widgetFactory(harness, "pi-goal")(tui, theme).render(32);
	assert.ok(lines.length <= 4);
	assert.match(lines[0] ?? "", /Goal paused/);
	assert.match(lines[1] ?? "", /Ship the deliberately/);
	assert.match(lines[2] ?? "", /pause Need user input/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 32));
});

test("native Goal widget labels model-owned blocking without changing persisted paused status", async () => {
	const harness = createHarness([{
		type: "custom",
		customType: "pi-goal-state-v1",
		data: {
			schemaVersion: 1,
			revision: 4,
			goal: {
				id: "blocked-goal",
				objective: "Wait only when autonomous work is impossible",
				status: "paused",
				autoContinue: false,
				usage: { tokensUsed: 0, activeSeconds: 0 },
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:01.000Z",
				pause: goalBlockedPause({
					blocker: "The external approval is absent.",
					evidence: "The approval system reports pending.",
					whyNoAutonomousPathRemains: "All remaining steps require approval.",
					unblockCondition: "Approval is granted.",
				}),
			},
		},
	}]);
	goalExtension(harness.pi);
	await harness.run("session_start", {});
	const lines = widgetFactory(harness, "pi-goal")(tui, theme).render(48);
	assert.match(lines[0] ?? "", /Goal blocked/);
	assert.match(lines[2] ?? "", /block proof Blocker:/);
	assert.match(lines[3] ?? "", /unblock Approval is granted/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 48));
});

test("native Goal widget keeps malformed block-like legacy snapshots paused", async (t) => {
	for (const [label, pause] of [
		["empty sections", { reason: "Blocker: \nEvidence: \nWhy no autonomous path remains: ", suggestedAction: "Resume after the decision." }],
		["misordered sections", { reason: "Blocker: blocker\nWhy no autonomous path remains: why\nEvidence: evidence", suggestedAction: "resume" }],
		["incomplete sections", { reason: "Blocker: blocker\nEvidence: evidence", suggestedAction: "resume" }],
	] as const) {
		await t.test(label, async () => {
			const harness = createHarness([{
				type: "custom",
				customType: "pi-goal-state-v1",
				data: {
					schemaVersion: 1,
					revision: 1,
					goal: {
						id: `legacy-${label}`,
						objective: "Preserve the legacy pause",
						status: "paused",
						autoContinue: false,
						usage: { tokensUsed: 0, activeSeconds: 0 },
						createdAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:01.000Z",
						pause,
					},
				},
			}]);
			goalExtension(harness.pi);
			await harness.run("session_start", {});
			const lines = widgetFactory(harness, "pi-goal")(tui, theme).render(80);
			assert.match(lines[0] ?? "", /Goal paused/);
			assert.match(lines[2] ?? "", /pause Blocker:/);
			assert.doesNotMatch(lines.join("\n"), /Goal blocked|block proof|unblock/);
		});
	}
});

test("native Todo widget spends emphasis only on current unfinished work", async () => {
	const tasks = Array.from({ length: 7 }, (_, index) => ({
		key: `t${index + 1}`,
		subject: `Task ${index + 1} with enough text to require truncation`,
		status: index === 0 ? "in_progress" : index === 6 ? "completed" : "pending",
	}));
	const harness = createHarness([{
		type: "custom",
		customType: "pi-todo-state-v1",
		data: { schemaVersion: 1, revision: 2, tasks },
	}]);
	todoExtension(harness.pi);
	await harness.run("session_start", {});
	const lines = widgetFactory(harness, "pi-todo")(tui, theme).render(30);
	assert.ok(lines.length <= 6);
	assert.match(lines[0] ?? "", /Todos 1\/7/);
	assert.match(lines[1] ?? "", /● t1 Task 1/);
	assert.match(lines.at(-1) ?? "", /more/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 30));
});
