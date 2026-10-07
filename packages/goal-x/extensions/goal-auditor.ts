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
import { GOAL_RECEIPT_ENTRY, type Goal } from "./goal-contract.ts";

export interface GoalAuditorResult {
	approved: boolean;
	output: string;
	model?: string;
	error?: string;
}

/** What the auditor judges against, beyond the objective and the executor's claim. */
export interface GoalAuditContext {
	/** The system prompt the executor worked under, which carries the user's and project's directives. */
	executorInstructions?: string;
	userMessages: string[];
	priorRejections: string[];
	bashAvailable?: boolean;
	snapshotPath?: string;
}

const GOAL_AUDIT_SNAPSHOT_MARKER = "pi-goal-audit-snapshot-v1";
// Keeps a pasted log from crowding out the rest; the full message stays in the snapshot.
const AUDIT_USER_MESSAGE_MAX_LENGTH = 4_000;

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

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

/** The user's own words on this branch and the earlier audit rejections of this Goal. */
export function collectGoalAuditHistory(branch: readonly unknown[], goalId: string): Pick<GoalAuditContext, "userMessages" | "priorRejections"> {
	const userMessages: string[] = [];
	const priorRejections: string[] = [];
	for (const item of branch) {
		const entry = item as {
			type?: string;
			customType?: string;
			message?: { role?: string; content?: unknown };
			data?: { kind?: string; goalId?: string; auditorReport?: string };
		};
		if (entry.type === "message" && entry.message?.role === "user") {
			const text = messageText(entry.message.content).trim();
			if (!text) continue;
			userMessages.push(text.length > AUDIT_USER_MESSAGE_MAX_LENGTH
				? `${text.slice(0, AUDIT_USER_MESSAGE_MAX_LENGTH)}\n[Truncated. The full message is in the parent snapshot.]`
				: text);
		} else if (
			entry.type === "custom"
			&& entry.customType === GOAL_RECEIPT_ENTRY
			&& entry.data?.kind === "goal_completion_rejected"
			&& entry.data.goalId === goalId
			&& entry.data.auditorReport
		) {
			priorRejections.push(entry.data.auditorReport);
		}
	}
	return { userMessages, priorRejections };
}

function payloadList(tag: string, items: string[], empty: string): string[] {
	if (items.length === 0) return [`<${tag}>`, empty, `</${tag}>`];
	return [`<${tag}>`, ...items.map((item, index) => `[${index + 1}]\n${escapePromptPayload(item)}`), `</${tag}>`];
}

export function buildGoalAuditorPrompt(goal: Goal, completionSummary: string, context: GoalAuditContext = { userMessages: [], priorRejections: [] }): string {
	return [
		"You are the independent completion auditor for a Pi Goal. The executor says the Goal is complete. Decide whether the user would agree, and report what you found.",
		context.bashAvailable
			? "Use read, grep, find, ls, and the OS-sandboxed read-only bash as needed. The shell cannot modify the workspace."
			: "Use read, grep, find, and ls as needed. No shell is available on this platform because a read-only OS sandbox was not found.",
		"",
		"The user's standards",
		"<executor_instructions> is the system prompt the executor worked under. It contains the user's and project's directives; instructions the executor picked up later in the session are in the parent snapshot. Read those directives before judging. They are the standard for this work and for your audit: apply them to what the executor did, apply them to your own objections, and report in their terms. Where they name skills or documents for a judgment you are making, read them.",
		"",
		"What the user asked for",
		"<objective> is the executor's statement of the Goal, confirmed by the user. <user_messages> holds what the user wrote on this branch. Where the user narrowed, corrected, or decided something, their words govern the objective's wording. Do not add requirements that neither the user nor their directives support.",
		"",
		"Verdict",
		"Disapprove when the requested result is missing, broken, or unverified, or when the work falls short of the user's request or directives, including by doing more than they support. A finding blocks only if you can name its consequence for the user: what they lose, risk, or must do if it stays as it is. Each blocking finding asks for more work, so first hold it to whatever standard the directives set for proposing work. Report anything else as a non-blocking note; notes do not prevent approval.",
		"",
		"Evidence",
		"<executor_summary> is a claim, not evidence. Verify what matters in the workspace or the parent snapshot. The runtime recorded the snapshot's tool calls and results, so they show what ran and what it printed. Do not require evidence to be written into the workspace. When the user asked for a report, plan, or record, the executor may deliver it in the conversation or its summary; check its content against the evidence rather than requiring a file the user did not ask for. A recorded check is stale only if a later change could plausibly alter its result.",
		"",
		"Earlier audits",
		"<prior_audits> holds earlier rejections of this Goal. They are earlier auditors' judgments, not requirements, and they may have been wrong. Check whether the objections that meet the standard above were resolved. Where the executor disputes one, test its reasons against the evidence and the user's words, and uphold the objection only if those reasons fail. Hold new findings to the same standard as old ones.",
		"",
		"Report blocking findings first, each with its evidence and what would resolve it, then notes. The final non-empty line must be exactly <approved/> or <disapproved/>.",
		"",
		"<executor_instructions>",
		context.executorInstructions?.trim()
			? escapePromptPayload(context.executorInstructions)
			: "The executor's instructions are unavailable. Judge against the objective and the user's messages.",
		"</executor_instructions>",
		"",
		"<objective>",
		escapePromptPayload(goal.objective),
		"</objective>",
		"",
		...payloadList("user_messages", context.userMessages, "No user messages are recorded on this branch."),
		"",
		...payloadList("prior_audits", context.priorRejections, "This is the first audit of this Goal."),
		"",
		"<parent_snapshot>",
		context.snapshotPath
			? [
				`Inspect the immutable runtime-captured current parent branch JSONL at: ${escapePromptPayload(context.snapshotPath)}`,
				"Each line is one entry. Tool calls appear as toolCall parts in assistant messages; their results are messages with role toolResult.",
			].join("\n")
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
			await session.prompt(buildGoalAuditorPrompt(args.goal, args.completionSummary, {
				executorInstructions: args.ctx.getSystemPrompt(),
				...collectGoalAuditHistory(args.ctx.sessionManager.getBranch(), args.goal.id),
				bashAvailable: auditorBash !== null,
				snapshotPath: snapshot.path,
			}));
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
