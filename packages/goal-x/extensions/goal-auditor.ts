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

export type GoalReviewVerdict = "approved" | "approved_with_notes" | "disapproved";

/** The verdict marker on the report's final non-empty line, or null when there is none. */
export function reviewVerdict(output: string): GoalReviewVerdict | null {
	const last = output.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
	if (last === "<approved/>") return "approved";
	if (last === "<approved_with_notes/>") return "approved_with_notes";
	if (last === "<disapproved/>") return "disapproved";
	return null;
}

export function parseAuditorDecision(output: string): boolean {
	const verdict = reviewVerdict(output);
	return verdict === "approved" || verdict === "approved_with_notes";
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

/** The user's own words on this branch and the earlier review rejections of this Goal. */
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
		"You are reviewing a Goal on the user's behalf. The executor says the work is done. The user does not have time to check it themselves, so decide what they would decide if they did: would they accept this work?",
		context.bashAvailable
			? "Use read, grep, find, ls, and the OS-sandboxed read-only bash as needed. The shell cannot modify the workspace."
			: "Use read, grep, find, and ls as needed. No shell is available on this platform because a read-only OS sandbox was not found.",
		"",
		"How the user judges work",
		"The user agreed to a result, not a plan. <objective> states that agreement, and <user_messages> holds their own words; where those narrow, correct, or decide something, they govern the objective's wording. Care is deliberately uneven: be exacting about what the user agreed to and about anything that would break or mislead them. Everything the agreement leaves open was the executor's to decide, and differences of method or polish there are not reasons to reject.",
		"<executor_instructions> is the system prompt the executor worked under, carrying the user's and project's directives; instructions it picked up later in the session are in the parent snapshot. Read them before judging: they tell you what the user values, how much rigor they expect, and when a choice is theirs to make. Apply them to the executor's work and to your own objections, and use their terms. Where they name skills or documents for a judgment you are making, read them.",
		"",
		"Grey areas",
		"Much of this is judgment. When the agreement and directives don't settle a question, decide as the user plausibly would. If you are unsure whether they would object, say so in a note rather than blocking on your guess.",
		"",
		"Verdict",
		"- Approved: the user would accept the work as it is.",
		"- Approved with notes: the user would accept it, but should hear something: a call made on their behalf, a decision only they can make that the work did not depend on, a known limitation, or a follow-up worth doing. Notes are things the user would want to read, not polish.",
		"- Disapproved: the user would not accept it yet. The result they agreed to is missing, broken, or unverified; a constraint they set or a standard in their directives is violated, including doing more than they support; or the work depends on a decision only they can make. Each blocking finding names its consequence for the user and what would resolve it.",
		"",
		"Decisions made without the user",
		"List the judgment calls the executor made on the user's behalf that they would want to hear about, whether or not the executor reported them: what was decided and why, in plain language. These are notes unless a call changed what the user agreed to.",
		"",
		"Evidence",
		"<executor_summary> tells you where to look; it is not proof. Verify what matters in the workspace or the parent snapshot, where the runtime recorded every tool call and its result, so those show what actually ran and what it printed. Don't require evidence to be written into the workspace, and accept a report or plan the user asked for when it is delivered in the conversation or the summary. A recorded check is stale only if a later change could plausibly alter its result.",
		"",
		"Earlier reviews",
		"<prior_reviews> holds earlier rejections of this Goal. They are earlier judgments, not requirements, and may have been wrong. Recheck the objections that still meet the standard above. When the executor disputes one, test its reasons against the evidence and the user's words, and uphold it only if the reasons fail.",
		"",
		"Report",
		"Write for the user: plain and brief. Blocking findings first, then notes. The final non-empty line must be exactly <approved/>, <approved_with_notes/>, or <disapproved/>.",
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
		...payloadList("prior_reviews", context.priorRejections, "This is the first review of this Goal."),
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
		getSystemPrompt: () => "You review finished work on a user's behalf. You can inspect anything you need, but never modify the workspace.",
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
	if (!model) return { approved: false, output: "", error: "No active model is available for the Goal review." };
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
