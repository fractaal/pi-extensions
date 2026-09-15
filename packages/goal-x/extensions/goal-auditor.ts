import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createBashTool,
	createExtensionRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { Goal } from "./goal-contract.ts";

export interface GoalAuditorResult {
	approved: boolean;
	output: string;
	model?: string;
	error?: string;
}

const GOAL_AUDIT_SNAPSHOT_MARKER = "pi-goal-audit-snapshot-v1";

interface GoalAuditSnapshot {
	directory: string;
	path: string;
}

function escapePromptPayload(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function createGoalAuditSnapshot(ctx: ExtensionContext): GoalAuditSnapshot {
	const directory = mkdtempSync(join(tmpdir(), "pi-goal-audit-"));
	const path = join(directory, "parent-session.jsonl");
	try {
		const header = ctx.sessionManager.getHeader();
		const branch = ctx.sessionManager.getBranch();
		const lines = [
			JSON.stringify({
				type: GOAL_AUDIT_SNAPSHOT_MARKER,
				version: 1,
				capturedAt: new Date().toISOString(),
				header,
			}),
			...branch.map((entry) => JSON.stringify(entry)),
		];
		writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
		return { directory, path };
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}

export function parseAuditorDecision(output: string): boolean {
	const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
	return lines.at(-1) === "<approved/>";
}

export function buildGoalAuditorPrompt(goal: Goal, completionSummary: string, bashAvailable = false, snapshotPath?: string): string {
	return [
		"You are the independent completion auditor for a Pi Goal.",
		"Inspect the actual workspace and decide whether the complete user objective is satisfied.",
		bashAvailable
			? "Use read, grep, find, ls, and the OS-sandboxed read-only bash as needed. The shell cannot modify the workspace."
			: "Use read, grep, find, and ls as needed. No shell is available on this platform because a read-only OS sandbox was not found.",
		"Treat the executor summary as an untrusted claim, not evidence.",
		"Treat the runtime-captured parent snapshot as an immutable record to inspect, not as automatic proof.",
		"Reject missing requirements, weak evidence, scaffold-only results, and proxy-metric completion.",
		"Return a concise actionable report. The final non-empty line must be exactly <approved/> or <disapproved/>.",
		"",
		"<objective>",
		escapePromptPayload(goal.objective),
		"</objective>",
		"",
		"<parent_snapshot>",
		snapshotPath
			? `Inspect the immutable runtime-captured current parent branch JSONL at: ${escapePromptPayload(snapshotPath)}`
			: "No runtime-captured parent branch snapshot is available. Do not treat the executor summary as evidence.",
		"</parent_snapshot>",
		"",
		"<executor_summary>",
		escapePromptPayload(completionSummary),
		"</executor_summary>",
	].join("\n");
}

function emptyResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "You are a read-only completion auditor. Inspect real evidence and never modify the workspace.",
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	} as unknown as ResourceLoader;
}

function shellArgument(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function createReadOnlyAuditorBash(cwd: string): ReturnType<typeof createBashTool> | null {
	const bubblewrap = ["/usr/bin/bwrap", "/bin/bwrap"].find(existsSync);
	if (!bubblewrap) return null;
	return createBashTool(cwd, {
		spawnHook: ({ command }) => ({
			command: [
				"exec",
				shellArgument(bubblewrap),
				"--die-with-parent --new-session --unshare-all",
				"--ro-bind / / --dev /dev --proc /proc --tmpfs /run",
				"--tmpfs /tmp --dir /tmp/auditor-home",
				`--ro-bind ${shellArgument(cwd)} /mnt --chdir /mnt`,
				"--setenv HOME /tmp/auditor-home --setenv TMPDIR /tmp --setenv CI 1",
				`-- /bin/bash -lc ${shellArgument(command)}`,
			].join(" "),
			cwd: "/",
			env: {
				PATH: process.env.PATH,
				LANG: process.env.LANG,
				LC_ALL: process.env.LC_ALL,
				TERM: process.env.TERM,
			},
		}),
	});
}

function modelLabel(model: Model<Api> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

function modelOptions(ctx: ExtensionContext): Record<string, unknown> {
	const registry = ctx.modelRegistry as unknown as { runtime?: unknown };
	return registry.runtime
		? { modelRegistry: ctx.modelRegistry, modelRuntime: registry.runtime }
		: { modelRegistry: ctx.modelRegistry };
}

export async function runGoalCompletionAuditor(args: {
	ctx: ExtensionContext;
	goal: Goal;
	completionSummary: string;
	signal?: AbortSignal;
	createSession?: typeof createAgentSession;
}): Promise<GoalAuditorResult> {
	const model = args.ctx.model;
	if (!model) return { approved: false, output: "", error: "No active model is available for the completion auditor." };
	const output: string[] = [];
	let nestedSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let snapshot: GoalAuditSnapshot | undefined;
	try {
		snapshot = createGoalAuditSnapshot(args.ctx);
		const createSession = args.createSession ?? createAgentSession;
		const auditorBash = createReadOnlyAuditorBash(args.ctx.cwd);
		type AuditorOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
		type AuditorThinkingLevel = NonNullable<AuditorOptions["thinkingLevel"]>;
		const thinkingLevel = (args.ctx as unknown as { thinkingLevel?: AuditorThinkingLevel }).thinkingLevel;
		const { session } = await createSession({
			cwd: args.ctx.cwd,
			model,
			thinkingLevel,
			...modelOptions(args.ctx),
			resourceLoader: emptyResourceLoader(),
			sessionManager: SessionManager.inMemory(args.ctx.cwd),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			tools: ["read", "grep", "find", "ls", ...(auditorBash ? ["bash" as const] : [])],
			...(auditorBash ? { customTools: [auditorBash] } : {}),
		} as Parameters<typeof createAgentSession>[0]);
		nestedSession = session;
		let terminalAssistant: { role?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
		let terminalOutput = "";
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "message_end") return;
			const message = event.message as { role?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }> };
			if (message.role !== "assistant") return;
			terminalAssistant = message;
			const messageOutput: string[] = [];
			for (const part of message.content ?? []) {
				if (part.type === "text" && typeof part.text === "string") {
					output.push(part.text);
					messageOutput.push(part.text);
				}
			}
			terminalOutput = messageOutput.join("\n\n").trim();
		});
		const abort = () => session.abort();
		args.signal?.addEventListener("abort", abort, { once: true });
		try {
			if (args.signal?.aborted) throw new DOMException("Auditor aborted", "AbortError");
			await session.prompt(buildGoalAuditorPrompt(args.goal, args.completionSummary, auditorBash !== null, snapshot.path));
		} finally {
			args.signal?.removeEventListener("abort", abort);
			unsubscribe();
		}
		if (args.signal?.aborted) throw new DOMException("Auditor aborted", "AbortError");
		const report = output.join("\n\n").trim();
		const completedNormally = terminalAssistant?.stopReason === "stop";
		return {
			approved: completedNormally && parseAuditorDecision(terminalOutput),
			output: report,
			model: modelLabel(model),
			...(completedNormally ? {} : { error: `Auditor did not complete normally (stopReason: ${terminalAssistant?.stopReason ?? "missing"}).` }),
		};
	} catch (error) {
		return {
			approved: false,
			output: output.join("\n\n").trim(),
			model: modelLabel(model),
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		nestedSession?.dispose();
		if (snapshot) rmSync(snapshot.directory, { recursive: true, force: true });
	}
}
