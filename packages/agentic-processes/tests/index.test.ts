import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionApiMock, type ExtensionApiMock } from "../../../tests/mock-extension-api.ts";
import { createBashTaskManager } from "../src/bash-backgrounding.ts";
import agenticProcessesExtension, {
	bashBackgroundingExtension,
	monitorExtension,
	requestAgenticProcessManagementApi,
} from "../src/index.ts";
import { createMonitorManager } from "../src/monitor.ts";
import { killChildProcessTree, killProcessTree, resolveBashShell, windowsBashCandidates } from "../src/shell.ts";

type TextToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
};

type EventBusMock = {
	emits: Array<{ name: string; data: unknown }>;
	emit(name: string, data: unknown): void;
	on(name: string, listener: (data: unknown) => void): () => void;
};

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	vi.restoreAllMocks();
});

async function tempCwd(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-agentic-processes-test-"));
	tempRoots.push(root);
	return root;
}

function installEventBus(apiMock: ExtensionApiMock): EventBusMock {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const eventBus: EventBusMock = {
		emits: [],
		emit(name, data) {
			eventBus.emits.push({ name, data });
			for (const listener of listeners.get(name) ?? []) listener(data);
		},
		on(name, listener) {
			const channel = listeners.get(name) ?? new Set();
			channel.add(listener);
			listeners.set(name, channel);
			return () => channel.delete(listener);
		},
	};
	Object.assign(apiMock.api, { events: eventBus });
	return eventBus;
}

function ctx(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
	} as unknown as ExtensionContext;
}

function text(result: unknown): string {
	const toolResult = result as TextToolResult;
	return toolResult.content.map((part) => part.text).join("\n");
}

function taskIdFrom(result: unknown): string {
	const match = text(result).match(/task_id: (bash-[a-f0-9-]+)/);
	const taskId = match?.[1];
	if (!taskId) throw new Error(`No task_id in result:\n${text(result)}`);
	return taskId;
}

function monitorIdFrom(result: unknown): string {
	const match = text(result).match(/\(([a-f0-9]{8})\)/);
	const monitorId = match?.[1];
	if (!monitorId) throw new Error(`No monitor id in result:\n${text(result)}`);
	return monitorId;
}

describe("shell resolution and process termination", () => {
	function existsOnly(paths: string[]) {
		const existing = new Set(paths);
		return (candidate: string) => existing.has(candidate);
	}

	it("resolves an explicit Windows Bash override", () => {
		const bashPath = String.raw`C:\Custom\Git\bin\bash.exe`;
		expect(
			resolveBashShell({
				platform: "win32",
				env: { ARIA_LOCAL_BASH_PATH: bashPath },
				existsSync: existsOnly([bashPath]),
			}),
		).toEqual({ command: bashPath, args: ["-lc"] });
	});

	it("uses Windows PATH entries with the Windows delimiter", () => {
		const bashPath = String.raw`C:\Tools\Git\bin\bash.exe`;
		expect(
			resolveBashShell({
				platform: "win32",
				env: { Path: String.raw`C:\Other;C:\Tools\Git\bin` },
				existsSync: existsOnly([bashPath]),
			}),
		).toEqual({ command: bashPath, args: ["-lc"] });
	});

	it("falls back to Git Bash's default Program Files locations on Windows", () => {
		const candidates = windowsBashCandidates({ ProgramFiles: String.raw`C:\Program Files`, PATH: "" });
		const bashPath = String.raw`C:\Program Files\Git\usr\bin\bash.exe`;
		expect(candidates).toContain(bashPath);
		expect(
			resolveBashShell({
				platform: "win32",
				env: { ProgramFiles: String.raw`C:\Program Files`, PATH: "" },
				existsSync: existsOnly([bashPath]),
			}),
		).toEqual({ command: bashPath, args: ["-lc"] });
	});

	it("fails with an actionable Windows Bash setup message when no Bash is available", () => {
		expect(() =>
			resolveBashShell({
				platform: "win32",
				env: { PATH: "" },
				existsSync: () => false,
			}),
		).toThrow(/Install Git for Windows/);
	});

	it("keeps POSIX Bash behavior on non-Windows platforms", () => {
		expect(
			resolveBashShell({
				platform: "linux",
				env: {},
				existsSync: existsOnly(["/bin/bash"]),
			}),
		).toEqual({ command: "/bin/bash", args: ["-lc"] });
	});

	it("preserves the Bash contract instead of falling back to POSIX sh", () => {
		expect(
			resolveBashShell({
				platform: "linux",
				env: { PATH: "/usr/local/bin:/usr/bin" },
				existsSync: existsOnly(["/bin/sh"]),
			}),
		).toEqual({ command: "bash", args: ["-lc"] });
	});

	it("uses taskkill for Windows process-tree termination and waits for successful dispatch", async () => {
		const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
		const killer = new EventEmitter();
		const fakeSpawn = ((command: string, args: string[], options: unknown) => {
			calls.push({ command, args, options });
			return killer;
		}) as never;

		const dispatched = killProcessTree(1234, "SIGKILL", { platform: "win32", spawn: fakeSpawn });
		expect(calls).toEqual([
			{
				command: "taskkill",
				args: ["/PID", "1234", "/T", "/F"],
				options: { stdio: "ignore", windowsHide: true },
			},
		]);
		killer.emit("close", 0);
		await expect(dispatched).resolves.toBeUndefined();
	});

	it("rejects Windows process-tree termination when taskkill fails", async () => {
		const killer = new EventEmitter();
		const fakeSpawn = (() => killer) as never;
		const dispatched = killProcessTree(1234, "SIGTERM", { platform: "win32", spawn: fakeSpawn });

		killer.emit("close", 1);
		await expect(dispatched).rejects.toThrow("taskkill exited with code 1");
	});

	it("falls back to ChildProcess.kill if Windows taskkill cannot start", () => {
		const killer = new EventEmitter();
		const fakeSpawn = (() => killer) as never;
		const child = { pid: 4321, kill: vi.fn() };

		killChildProcessTree(child, "SIGTERM", { platform: "win32", spawn: fakeSpawn });
		killer.emit("error", new Error("taskkill missing"));

		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	});
});

describe("agentic processes extension", () => {
	it("registers the background bash and monitor tool surfaces", () => {
		const apiMock = createExtensionApiMock();
		agenticProcessesExtension(apiMock.api);

		expect([...apiMock.tools.keys()].sort()).toEqual(
			[
				"bash",
				"bash_output",
				"bash_tasks",
				"kill_bash",
				"monitor_list",
				"monitor_start",
				"monitor_status",
				"monitor_stop",
			].sort(),
		);
	});

	it("also exports the individual extension factories", () => {
		const bashMock = createExtensionApiMock();
		bashBackgroundingExtension(bashMock.api);
		expect([...bashMock.tools.keys()].sort()).toEqual(["bash", "bash_output", "bash_tasks", "kill_bash"].sort());

		const monitorMock = createExtensionApiMock();
		monitorExtension(monitorMock.api);
		expect([...monitorMock.tools.keys()].sort()).toEqual(
			["monitor_list", "monitor_start", "monitor_status", "monitor_stop"].sort(),
		);
	});

	it("manages the same Bash and monitor records created through the LLM tools", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		const events = installEventBus(apiMock);
		agenticProcessesExtension(apiMock.api);
		const management = requestAgenticProcessManagementApi(events);
		if (!management) throw new Error("agentic process management API missing");
		const subscriberError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		management.subscribe(() => {
			throw new Error("broken management observer");
		});
		const updates: string[] = [];
		management.subscribe((snapshot) => updates.push(`${snapshot.kind}:${snapshot.id}:${snapshot.status}`));

		const bash = apiMock.getTool("bash").execute;
		const monitorStart = apiMock.getTool("monitor_start").execute;
		if (!bash || !monitorStart) throw new Error("process tools missing");
		const bashStart = await bash(
			"call-managed-bash",
			{ command: "printf 'bash-live\\n'; sleep 30", run_in_background: true },
			undefined,
			undefined,
			ctx(cwd),
		);
		const monitorStartResult = await monitorStart(
			"call-managed-monitor",
			{ command: "printf 'monitor-live\\n'; sleep 30", name: "managed monitor", inject: false },
			undefined,
			undefined,
			ctx(cwd),
		);
		const bashId = taskIdFrom(bashStart);
		const monitorId = monitorIdFrom(monitorStartResult);

		expect(management.list().map(({ id, kind }) => ({ id, kind }))).toEqual(
			expect.arrayContaining([
				{ id: bashId, kind: "bash" },
				{ id: monitorId, kind: "monitor" },
			]),
		);
		await vi.waitFor(async () => {
			expect((await management.readOutput(bashId, 4096)).output).toContain("bash-live");
			expect((await management.readOutput(monitorId, 4096)).output).toContain("monitor-live");
		});

		await management.stop(bashId, "headless test cleanup");
		await management.stop(monitorId, "headless test cleanup");
		await vi.waitFor(() => {
			const statuses = new Map(management.list().map((process) => [process.id, process.status]));
			expect(statuses.get(bashId)).toBe("killed");
			expect(statuses.get(monitorId)).toBe("killed");
		});
		expect((await management.readOutput(bashId, 4096)).output).toContain("bash-live");
		expect((await management.readOutput(monitorId, 4096)).output).toContain("monitor-live");
		expect(updates).toContain(`bash:${bashId}:running`);
		expect(updates).toContain(`bash:${bashId}:killed`);
		expect(updates).toContain(`monitor:${monitorId}:running`);
		expect(updates).toContain(`monitor:${monitorId}:killed`);
		expect(subscriberError).toHaveBeenCalledWith(
			"[pi-agentic-processes] management API subscriber failed",
			expect.any(Error),
		);
		await expect(management.stop(bashId)).rejects.toThrow("already killed");

		for (const handler of apiMock.getHandlers("session_shutdown")) await handler({}, ctx(cwd));
		expect(() => management.list()).toThrow("unavailable after Pi session shutdown");
	});

	it("runs a foreground bash command with the compatible output shape", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		installEventBus(apiMock);
		bashBackgroundingExtension(apiMock.api);
		const execute = apiMock.getTool("bash").execute;
		if (!execute) throw new Error("bash execute missing");

		const result = await execute("call-1", { command: "printf 'hello\\n'" }, undefined, undefined, ctx(cwd));

		expect(text(result)).toContain("Command completed");
		expect(text(result)).toContain("hello");
	});

	it("exposes a UI-independent bash task manager API", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		installEventBus(apiMock);
		const manager = createBashTaskManager(apiMock.api);
		const updates: string[] = [];
		const unsubscribe = manager.subscribe((snapshot) => updates.push(`${snapshot.taskId}:${snapshot.status}`));

		const task = await manager.start({
			command: "printf 'manager-ready\\n'; sleep 0.1; printf 'manager-done\\n'",
			cwd,
			backgroundAfterSeconds: 0.01,
		});
		expect(manager.get(task.taskId)?.taskId).toBe(task.taskId);
		expect(manager.list("running").some((item) => item.taskId === task.taskId)).toBe(true);

		const output = await manager.readOutput({ taskId: task.taskId, block: true, waitSeconds: 2, tailBytes: 4096 });
		expect(output.task.status).toBe("completed");
		expect(output.output).toContain("manager-ready");
		expect(output.output).toContain("manager-done");
		expect(updates.some((update) => update.endsWith(":running"))).toBe(true);
		expect(updates.some((update) => update.endsWith(":completed"))).toBe(true);
		unsubscribe();
	});

	it("isolates throwing Bash subscribers from task lifecycle and other observers", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		const manager = createBashTaskManager(apiMock.api);
		const subscriberError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		manager.subscribe(() => {
			throw new Error("broken Bash observer");
		});
		const updates: string[] = [];
		manager.subscribe((snapshot) => updates.push(snapshot.status));

		const task = await manager.start({
			command: "printf 'observer-safe\\n'",
			cwd,
			backgroundAfterSeconds: 0.01,
		});
		await task.completion;

		expect(manager.get(task.taskId)?.status).toBe("completed");
		expect(updates).toContain("running");
		expect(updates).toContain("completed");
		expect(subscriberError).toHaveBeenCalledWith(
			"[pi-agentic-processes] Bash task subscriber failed",
			expect.any(Error),
		);
	});

	it("reports real Bash output availability and stable terminal timestamps", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		const manager = createBashTaskManager(apiMock.api);
		const silent = await manager.start({ command: ":", cwd, backgroundAfterSeconds: 0.01 });
		await silent.completion;

		const terminal = manager.getSnapshot(silent.taskId);
		expect(terminal?.hasOutput).toBe(false);
		expect(terminal?.updatedAtMs).toBeGreaterThanOrEqual(terminal?.startedAtMs ?? Number.POSITIVE_INFINITY);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(manager.getSnapshot(silent.taskId)?.updatedAt).toBe(terminal?.updatedAt);

		const noisy = await manager.start({ command: "printf 'output\\n'", cwd, backgroundAfterSeconds: 0.01 });
		await noisy.completion;
		expect(manager.getSnapshot(noisy.taskId)?.hasOutput).toBe(true);
	});

	it("keeps bash task state scoped to each manager instance", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		installEventBus(apiMock);
		const firstManager = createBashTaskManager(apiMock.api);
		const secondManager = createBashTaskManager(apiMock.api);

		const task = await firstManager.start({
			command: "printf 'scoped-running\\n'; sleep 30",
			cwd,
			backgroundAfterSeconds: 0.01,
		});
		expect(firstManager.list("running").map((item) => item.taskId)).toContain(task.taskId);
		expect(secondManager.list("running").map((item) => item.taskId)).not.toContain(task.taskId);
		await expect(secondManager.stop(task.taskId, "wrong manager", 0)).rejects.toThrow(
			"Unknown background bash task id",
		);
		await firstManager.stop(task.taskId, "scoped manager cleanup");
	});

	it("supports background bash start, list, output, completion, and kill flows", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		const events = installEventBus(apiMock);
		bashBackgroundingExtension(apiMock.api);
		const bash = apiMock.getTool("bash").execute;
		const bashOutput = apiMock.getTool("bash_output").execute;
		const bashTasks = apiMock.getTool("bash_tasks").execute;
		const killBash = apiMock.getTool("kill_bash").execute;
		if (!bash || !bashOutput || !bashTasks || !killBash) throw new Error("bash tools missing");

		const completedStart = await bash(
			"call-bg-complete",
			{ command: "printf 'start\\n'; sleep 0.1; printf 'done\\n'", background_after_seconds: 0.01 },
			undefined,
			undefined,
			ctx(cwd),
		);
		const completedTaskId = taskIdFrom(completedStart);
		const completedOutput = await bashOutput(
			"call-output-complete",
			{ task_id: completedTaskId, block: true, wait_seconds: 2, tail_bytes: 4096 },
			undefined,
			undefined,
			ctx(cwd),
		);
		expect(text(completedOutput)).toContain("status: completed");
		expect(text(completedOutput)).toContain("start");
		expect(text(completedOutput)).toContain("done");

		const runningStart = await bash(
			"call-bg-running",
			{ command: "printf 'running\\n'; sleep 30", run_in_background: true },
			undefined,
			undefined,
			ctx(cwd),
		);
		const runningTaskId = taskIdFrom(runningStart);
		const tasks = await bashTasks("call-tasks", { status: "running" }, undefined, undefined, ctx(cwd));
		expect(text(tasks)).toContain(runningTaskId);
		const killed = await killBash(
			"call-kill",
			{ task_id: runningTaskId, reason: "test cleanup" },
			undefined,
			undefined,
			ctx(cwd),
		);
		expect(text(killed)).toContain(`Task ${runningTaskId}`);
		expect(events.emits.some((event) => event.name === "aria-local:background-task-update")).toBe(true);
	});

	it("sends background completion with steering delivery", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		installEventBus(apiMock);
		bashBackgroundingExtension(apiMock.api);
		const bash = apiMock.getTool("bash").execute;
		if (!bash) throw new Error("bash execute missing");
		const sendMessage = vi.spyOn(apiMock.api, "sendMessage");

		await bash(
			"call-bg-steer",
			{ command: "sleep 0.05; printf 'done\\n'", run_in_background: true },
			undefined,
			undefined,
			ctx(cwd),
		);

		await vi.waitFor(() => {
			expect(sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "background-bash-task" }),
				{ triggerTurn: true, deliverAs: "steer" },
			);
		});
	});

	it.skipIf(process.platform === "win32")(
		"suppresses completion steering until a timed-out blocking poll finishes reading its snapshot",
		async () => {
			const cwd = await tempCwd();
			const apiMock = createExtensionApiMock();
			installEventBus(apiMock);
			const manager = createBashTaskManager(apiMock.api);
			const sendMessage = vi.spyOn(apiMock.api, "sendMessage");
			const task = await manager.start({
				command: "sleep 0.05; printf 'done\\n'",
				cwd,
				backgroundAfterSeconds: 0.01,
			});
			task.notifyOnCompletion = true;
			const fifoPath = join(cwd, "blocking-output-snapshot.fifo");
			await execFileAsync("mkfifo", [fifoPath]);
			task.outputPath = fifoPath;

			const readPromise = manager.readOutput({
				taskId: task.taskId,
				block: true,
				waitSeconds: 0.01,
				tailBytes: 4096,
			});
			await task.completion;
			const writer = await open(fifoPath, "w");
			await writer.close();
			const result = await readPromise;

			expect(result.task.status).toBe("completed");
			expect(result.task.notifyOnCompletion).toBe(false);
			expect(sendMessage).not.toHaveBeenCalled();
		},
	);

	it("delivers completion steering when a blocking poll observes completion but its snapshot read fails", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		installEventBus(apiMock);
		const manager = createBashTaskManager(apiMock.api);
		const sendMessage = vi.spyOn(apiMock.api, "sendMessage");
		const task = await manager.start({
			command: "sleep 0.05; printf 'done\\n'",
			cwd,
			backgroundAfterSeconds: 0.01,
		});
		task.notifyOnCompletion = true;
		task.outputPath = cwd;

		await expect(
			manager.readOutput({ taskId: task.taskId, block: true, waitSeconds: 2, tailBytes: 4096 }),
		).rejects.toThrow();
		await task.completion;

		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "background-bash-task" }),
			{ triggerTurn: true, deliverAs: "steer" },
		);
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	it("keeps completion steering enabled after a blocking output poll times out", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		installEventBus(apiMock);
		bashBackgroundingExtension(apiMock.api);
		const bash = apiMock.getTool("bash").execute;
		const bashOutput = apiMock.getTool("bash_output").execute;
		if (!bash || !bashOutput) throw new Error("bash tools missing");
		const sendMessage = vi.spyOn(apiMock.api, "sendMessage");

		const started = await bash(
			"call-bg-poll-timeout",
			{ command: "sleep 0.2; printf 'done\\n'", run_in_background: true },
			undefined,
			undefined,
			ctx(cwd),
		);
		const taskId = taskIdFrom(started);
		const polled = await bashOutput(
			"call-output-poll-timeout",
			{ task_id: taskId, block: true, wait_seconds: 0.01, tail_bytes: 4096 },
			undefined,
			undefined,
			ctx(cwd),
		);

		expect(text(polled)).toContain("status: running");
		await vi.waitFor(() => {
			expect(sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "background-bash-task" }),
				{ triggerTurn: true, deliverAs: "steer" },
			);
			expect(sendMessage).toHaveBeenCalledTimes(1);
		});
	});

	it("exposes a UI-independent monitor manager API", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		const manager = createMonitorManager(apiMock.api);
		const updates: string[] = [];
		const unsubscribe = manager.subscribe((snapshot) => updates.push(`${snapshot.id}:${snapshot.liveTaskStatus}`));

		const started = await manager.start(
			{ command: "printf 'MANAGER_READY\\n'; sleep 30", inject: false, name: "manager-monitor" },
			cwd,
		);
		const monitorId = monitorIdFrom(started);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const status = await manager.status({ id: monitorId, tail: 20 });
		expect(text(status)).toContain("MANAGER_READY");
		const listed = await manager.list();
		expect(text(listed)).toContain(monitorId);
		const stopped = await manager.stop({ id: monitorId });
		expect(text(stopped)).toContain(`Sent SIGTERM to monitor manager-monitor (${monitorId}).`);
		await vi.waitFor(() => expect(manager.get(monitorId)?.liveTaskStatus).toBe("killed"));
		const terminalUpdatedAt = manager.get(monitorId)?.updatedAt;
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(manager.get(monitorId)?.updatedAt).toBe(terminalUpdatedAt);
		expect(updates.some((update) => update.endsWith(":running"))).toBe(true);
		expect(updates.length).toBeGreaterThanOrEqual(2);
		unsubscribe();
	});

	it.skipIf(process.platform === "win32")(
		"rejects failed monitor signal dispatch without falsely recording a stop",
		async () => {
			const cwd = await tempCwd();
			const apiMock = createExtensionApiMock();
			const manager = createMonitorManager(apiMock.api);
			const started = await manager.start({ command: "sleep 30", inject: false, name: "dispatch-failure" }, cwd);
			const monitorId = monitorIdFrom(started);
			const kill = vi.spyOn(process, "kill").mockImplementationOnce(() => {
				throw new Error("EPERM test failure");
			});

			await expect(manager.stop({ id: monitorId })).rejects.toThrow("EPERM test failure");
			expect(manager.get(monitorId)).toMatchObject({ liveTaskStatus: "running", stopReason: undefined });
			expect((await manager.readOutput(monitorId, 4096)).output).toContain("failed to send SIGTERM");

			kill.mockRestore();
			await manager.stop({ id: monitorId, reason: "test cleanup" });
			await vi.waitFor(() => expect(manager.get(monitorId)?.liveTaskStatus).toBe("killed"));
		},
	);

	it("isolates throwing monitor subscribers from process lifecycle and other observers", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		const manager = createMonitorManager(apiMock.api);
		const subscriberError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		manager.subscribe(() => {
			throw new Error("broken monitor observer");
		});
		const updates: string[] = [];
		manager.subscribe((snapshot) => updates.push(snapshot.liveTaskStatus));

		const started = await manager.start({ command: "printf 'observer-safe\\n'", inject: false }, cwd);
		const monitorId = monitorIdFrom(started);
		await vi.waitFor(() => expect(manager.get(monitorId)?.liveTaskStatus).toBe("completed"));

		expect(updates).toContain("running");
		expect(updates).toContain("completed");
		expect((await manager.readOutput(monitorId, 4096)).output).toContain("observer-safe");
		expect(subscriberError).toHaveBeenCalledWith(
			"[pi-agentic-processes] monitor subscriber failed",
			expect.any(Error),
		);
		manager.shutdown();
	});

	it("supports monitor start, status, list, log tail, and stop flows", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		const events = installEventBus(apiMock);
		monitorExtension(apiMock.api);
		const monitorStart = apiMock.getTool("monitor_start").execute;
		const monitorStatus = apiMock.getTool("monitor_status").execute;
		const monitorList = apiMock.getTool("monitor_list").execute;
		const monitorStop = apiMock.getTool("monitor_stop").execute;
		if (!monitorStart || !monitorStatus || !monitorList || !monitorStop) throw new Error("monitor tools missing");

		const started = await monitorStart(
			"call-monitor-start",
			{ command: "printf 'READY\\n'; sleep 30", inject: false, name: "ready-test" },
			undefined,
			undefined,
			ctx(cwd),
		);
		const monitorId = monitorIdFrom(started);
		await new Promise((resolve) => setTimeout(resolve, 100));

		const status = await monitorStatus(
			"call-monitor-status",
			{ id: monitorId, tail: 20 },
			undefined,
			undefined,
			ctx(cwd),
		);
		expect(text(status)).toContain("READY");
		expect(text(status)).toContain("statusTailGuardrail");
		const listed = await monitorList("call-monitor-list", {}, undefined, undefined, ctx(cwd));
		expect(text(listed)).toContain(monitorId);
		const stopped = await monitorStop("call-monitor-stop", { id: monitorId }, undefined, undefined, ctx(cwd));
		expect(text(stopped)).toContain(`Sent SIGTERM to monitor ready-test (${monitorId}).`);
		expect(events.emits.some((event) => event.name === "aria-local:monitor-update")).toBe(true);
	});
});
