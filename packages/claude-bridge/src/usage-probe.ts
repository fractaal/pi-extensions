// Steady Claude plan-usage sampling for hosts (e.g. Symphony Desktop pacing).
//
// Usage is a Claude Code control request, so it needs a live Claude Code
// process. The probe keeps one idle process (no prompt, no tools, no MCP
// servers, no user settings — so no model calls) while the host keeps reading,
// and shuts it down once reads stop. Claude Code caches usage for well under a
// minute, so one read a minute is fresh.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeCodeExecutable } from "./executable-resolution.js";
import { PromptInput } from "./prompt-input.js";
import { createClaudeUsageGuard, type ClaudeUsageReport } from "./usage.js";

export type { ClaudeUsageReport, ClaudeUsageWindow } from "./usage.js";
export { CLAUDE_USAGE_EVENT, CLAUDE_USAGE_PROVIDER } from "./usage.js";

export interface ClaudeUsageProbe {
	/** Fresh usage, or null when there is nothing to show or reads are switched off. Never rejects. */
	read(): Promise<ClaudeUsageReport | null>;
	/** Stop the idle Claude Code process now. */
	close(): void;
	/** True once the usage API looked changed or kept failing; the probe then stays off. */
	readonly disabled: boolean;
}

interface ProbeQuery {
	close(): void;
	[Symbol.asyncIterator](): AsyncIterator<unknown>;
}

export interface ProbeQueryOptions {
	prompt: AsyncIterable<unknown>;
	pathToClaudeCodeExecutable: string;
	env: Record<string, string | undefined>;
	tools: string[];
	mcpServers: Record<string, never>;
	settingSources: [];
	persistSession: false;
}

export interface ClaudeUsageProbeOptions {
	/** Environment for Claude Code (e.g. the host's login-shell PATH). */
	env?: NodeJS.ProcessEnv;
	/** Claude Code executable; resolved from `env.PATH` when omitted. */
	executablePath?: string;
	/** Close the idle process this long after the last read. Default 2 minutes. */
	idleShutdownMs?: number;
	/** Per-read timeout. Default 15 seconds. */
	readTimeoutMs?: number;
	onDisabled?: (reason: string) => void;
	/** Test seam: start the idle Claude Code query. */
	startQuery?: (options: ProbeQueryOptions) => ProbeQuery;
}

const DEFAULT_IDLE_SHUTDOWN_MS = 2 * 60_000;
const DEFAULT_READ_TIMEOUT_MS = 15_000;

export function createClaudeUsageProbe(options: ClaudeUsageProbeOptions = {}): ClaudeUsageProbe {
	const guard = createClaudeUsageGuard(options.onDisabled);
	const idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
	const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
	const startQuery = options.startQuery
		?? (({ prompt, ...queryOptions }) => query({ prompt: prompt as AsyncIterable<never>, options: queryOptions }) as unknown as ProbeQuery);
	let live: { query: ProbeQuery; input: PromptInput } | null = null;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;

	const stop = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = null;
		const current = live;
		live = null;
		if (!current) return;
		current.input.close();
		try { current.query.close(); } catch { /* already gone */ }
	};

	const ensureQuery = (): ProbeQuery | null => {
		if (live) return live.query;
		const env = { ...process.env, ...options.env };
		const executablePath = options.executablePath ?? resolveClaudeCodeExecutable({ env })?.executablePath;
		if (!executablePath) return null; // Claude Code is not installed: nothing to read.
		const input = new PromptInput(); // Never written to: the process stays idle.
		const probeQuery = startQuery({
			prompt: input,
			pathToClaudeCodeExecutable: executablePath,
			env: { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
			tools: [],
			mcpServers: {},
			settingSources: [],
			persistSession: false,
		});
		const current = { query: probeQuery, input };
		live = current;
		// Drain the message stream; when the process ends, the next read starts a new one.
		void (async () => {
			try {
				const iterator = probeQuery[Symbol.asyncIterator]();
				while (!(await iterator.next()).done) { /* idle process emits only housekeeping */ }
			} catch { /* process ended */ }
			if (live === current) live = null;
		})();
		return probeQuery;
	};

	return {
		get disabled() { return guard.disabled; },
		async read() {
			if (guard.disabled) return null;
			let probeQuery: ProbeQuery | null;
			try {
				probeQuery = ensureQuery();
			} catch {
				return null;
			}
			if (!probeQuery) return null;
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(stop, idleShutdownMs);
			(idleTimer as { unref?: () => void }).unref?.();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), readTimeoutMs); });
			try {
				return await Promise.race([guard.read(probeQuery), timeout]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
		close: stop,
	};
}
