import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BashTaskManager,
	type BashTaskSnapshot,
	registerBashBackgrounding,
} from "./bash-backgrounding.ts";
import {
	type MonitorManager,
	type MonitorSnapshot,
	registerMonitorExtension,
} from "./monitor.ts";

export const AGENTIC_PROCESS_MANAGEMENT_API_REQUEST = "pi-agentic-processes:management-api-request";

export type AgenticProcessKind = "bash" | "monitor";
export type AgenticProcessStatus = "running" | "completed" | "failed" | "killed";

export interface AgenticProcessSnapshot {
	id: string;
	kind: AgenticProcessKind;
	label: string;
	command: string;
	cwd: string;
	status: AgenticProcessStatus;
	startedAt: string;
	startedAtMs: number;
	updatedAt: string;
	updatedAtMs: number;
	exitCode: number | null;
	reason?: string;
	hasOutput: boolean;
	hasResult: boolean;
	outputTail: string;
}

export interface AgenticProcessOutput {
	process: AgenticProcessSnapshot;
	output: string;
}

export interface AgenticProcessManagementApi {
	list(): AgenticProcessSnapshot[];
	readOutput(id: string, tailBytes?: number): Promise<AgenticProcessOutput>;
	stop(id: string, reason?: string): Promise<void>;
	subscribe(listener: (snapshot: AgenticProcessSnapshot) => void): () => void;
}

interface AgenticProcessEventBus {
	emit(channel: string, data: unknown): void;
}

interface ManagementApiRequest {
	accept(api: AgenticProcessManagementApi): void;
}

export function requestAgenticProcessManagementApi(events: AgenticProcessEventBus): AgenticProcessManagementApi | undefined {
	let api: AgenticProcessManagementApi | undefined;
	events.emit(AGENTIC_PROCESS_MANAGEMENT_API_REQUEST, {
		accept(candidate) {
			api = candidate;
		},
	} satisfies ManagementApiRequest);
	return api;
}

function bashSnapshot(snapshot: BashTaskSnapshot): AgenticProcessSnapshot {
	return {
		id: snapshot.taskId,
		kind: "bash",
		label: snapshot.description,
		command: snapshot.command,
		cwd: snapshot.cwd,
		status: snapshot.status,
		startedAt: snapshot.startedAt,
		startedAtMs: snapshot.startedAtMs,
		updatedAt: snapshot.updatedAt,
		updatedAtMs: snapshot.updatedAtMs,
		exitCode: snapshot.exitCode,
		reason: snapshot.reason,
		hasOutput: snapshot.hasOutput,
		hasResult: snapshot.hasResult,
		outputTail: snapshot.outputTail,
	};
}

function monitorStatus(snapshot: MonitorSnapshot): AgenticProcessStatus {
	if (snapshot.liveTaskStatus === "completed") return "completed";
	if (snapshot.liveTaskStatus === "failed") return "failed";
	if (snapshot.liveTaskStatus === "killed") return "killed";
	return "running";
}

function monitorSnapshot(snapshot: MonitorSnapshot): AgenticProcessSnapshot {
	return {
		id: snapshot.id,
		kind: "monitor",
		label: snapshot.name,
		command: snapshot.command,
		cwd: snapshot.cwd,
		status: monitorStatus(snapshot),
		startedAt: snapshot.startedAt,
		startedAtMs: snapshot.startedAtMs,
		updatedAt: snapshot.updatedAt,
		updatedAtMs: snapshot.updatedAtMs,
		exitCode: snapshot.exitCode ?? null,
		reason: snapshot.stopReason,
		hasOutput: snapshot.hasOutput,
		hasResult: snapshot.hasResult,
		outputTail: snapshot.outputTail,
	};
}

function createManagementApi(
	bash: BashTaskManager,
	monitors: MonitorManager,
): { api: AgenticProcessManagementApi; dispose(): void } {
	const listeners = new Set<(snapshot: AgenticProcessSnapshot) => void>();
	let available = true;

	const publish = (snapshot: AgenticProcessSnapshot) => {
		for (const listener of listeners) listener(snapshot);
	};
	const unsubscribeBash = bash.subscribe((snapshot) => publish(bashSnapshot(snapshot)));
	const unsubscribeMonitors = monitors.subscribe((snapshot) => publish(monitorSnapshot(snapshot)));
	const requireAvailable = () => {
		if (!available) throw new Error("Agentic process management is unavailable after Pi session shutdown.");
	};
	const find = (id: string): AgenticProcessSnapshot => {
		const task = bash.getSnapshot(id);
		if (task) return bashSnapshot(task);
		const monitor = monitors.get(id);
		if (monitor) return monitorSnapshot(monitor);
		throw new Error(`Unknown agentic process id: ${id}.`);
	};

	return {
		api: {
			list() {
				requireAvailable();
				return [
					...bash.listSnapshots().map(bashSnapshot),
					...monitors.listSnapshots().map(monitorSnapshot),
				].sort((a, b) => {
					if (a.status === "running" && b.status !== "running") return -1;
					if (a.status !== "running" && b.status === "running") return 1;
					return b.startedAtMs - a.startedAtMs;
				});
			},
			async readOutput(id, tailBytes) {
				requireAvailable();
				const process = find(id);
				if (process.kind === "bash") {
					const result = await bash.readOutput({ taskId: id, tailBytes });
					return { process: find(id), output: result.output };
				}
				const result = await monitors.readOutput(id, tailBytes);
				return { process: monitorSnapshot(result.snapshot), output: result.output };
			},
			async stop(id, reason = "stopped by headless process manager") {
				requireAvailable();
				const process = find(id);
				if (process.status !== "running") throw new Error(`Agentic process ${id} is already ${process.status}.`);
				if (process.kind === "bash") {
					await bash.stop(id, reason);
					return;
				}
				await monitors.stop({ id, reason });
			},
			subscribe(listener) {
				requireAvailable();
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		dispose() {
			available = false;
			listeners.clear();
			unsubscribeBash();
			unsubscribeMonitors();
		},
	};
}

export default function agenticProcessesExtension(pi: ExtensionAPI): void {
	const bash = registerBashBackgrounding(pi);
	const monitors = registerMonitorExtension(pi);
	const management = createManagementApi(bash, monitors);
	const unsubscribeRequest = pi.events?.on?.(AGENTIC_PROCESS_MANAGEMENT_API_REQUEST, (data) => {
		const request = data as Partial<ManagementApiRequest>;
		request.accept?.(management.api);
	}) ?? (() => undefined);

	pi.on("session_shutdown", () => {
		unsubscribeRequest();
		management.dispose();
	});
}

export type {
	BashTaskManager,
	BashTaskSnapshot,
	BashTaskStatus,
	BashTaskUpdateListener,
} from "./bash-backgrounding.ts";
export { createBashTaskManager, default as bashBackgroundingExtension } from "./bash-backgrounding.ts";
export type { MonitorManager, MonitorSnapshot, MonitorUpdateListener } from "./monitor.ts";
export { createMonitorManager, default as monitorExtension } from "./monitor.ts";
