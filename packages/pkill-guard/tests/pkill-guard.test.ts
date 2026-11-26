import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionApiMock } from "../../../tests/mock-extension-api.ts";
import { bashBackgroundingExtension } from "../../agentic-processes/src/index.ts";
import pkillGuardExtension from "../src/index.ts";

// These run real pkill and pgrep against real processes through Pi's bash
// tool, with the pattern always a random token so nothing else can match.

const realRuntimeDir = process.env.XDG_RUNTIME_DIR;
// The guard needs a pgrep with --cgroup and -p; elsewhere it does nothing.
const canGuard =
	process.platform === "linux" &&
	[0, 1].includes(spawnSync("/usr/bin/pgrep", ["--cgroup", "/", "-p", "1"], { stdio: "ignore" }).status ?? -1);
const canStartOutsideSession =
	process.platform === "linux" &&
	spawnSync("systemd-run", ["--user", "--scope", "--quiet", "true"], { stdio: "ignore" }).status === 0;

let token = "";
const children: ChildProcess[] = [];
const tempRoots: string[] = [];

beforeEach(async () => {
	token = `pkguard-${randomBytes(6).toString("hex")}`;
	const runtimeDir = await mkdtemp(join(tmpdir(), "pi-pkill-guard-test-"));
	tempRoots.push(runtimeDir);
	vi.stubEnv("XDG_RUNTIME_DIR", runtimeDir);
	// When these tests run from Claude Code, its own pkill guard may be on PATH;
	// without CLAUDE_PID it steps aside, so only this package's guard acts here.
	vi.stubEnv("CLAUDE_PID", undefined);
});

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	vi.unstubAllEnvs();
	await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// A process in this session (a child of the test, so it shares its cgroup).
function startInside(): ChildProcess {
	const child = spawn("bash", ["-c", `exec -a '${token}-inside' sleep 300`], { stdio: "ignore" });
	children.push(child);
	return child;
}

// A process outside this session, the way the desktop and other agents are.
async function startOutside(): Promise<ChildProcess> {
	const child = spawn(
		"systemd-run",
		["--user", "--scope", "--quiet", "bash", "-c", `exec -a '${token}-outside' sleep 300`],
		{ stdio: "ignore", env: { ...process.env, XDG_RUNTIME_DIR: realRuntimeDir } },
	);
	children.push(child);
	for (let i = 0; i < 50; i++) {
		const cmdline = await readFile(`/proc/${child.pid}/cmdline`, "utf8").catch(() => "");
		if (cmdline.startsWith(`${token}-outside`)) return child;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("outside process did not start");
}

function stopsWithin(child: ChildProcess, ms: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), ms);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

// One bash tool call as Pi makes it: tool_call handlers, the tool, then
// tool_result handlers. Returns the text the model would read.
async function runBash(command: string): Promise<string> {
	const apiMock = createExtensionApiMock();
	Object.assign(apiMock.api, { events: { emit() {}, on: () => () => {} } });
	bashBackgroundingExtension(apiMock.api);
	pkillGuardExtension(apiMock.api);
	const ctx = { cwd: tmpdir(), hasUI: false } as unknown as ExtensionContext;
	const toolCallId = `call_${randomBytes(4).toString("hex")}|fc_${randomBytes(4).toString("hex")}`;

	const call = { type: "tool_call", toolName: "bash", toolCallId, input: { command } };
	for (const handler of apiMock.getHandlers("tool_call")) await handler(call, ctx);
	const execute = apiMock.getTool("bash").execute;
	if (!execute) throw new Error("bash execute missing");
	type Result = { content: Array<{ type: string; text?: string }>; details?: unknown };
	let result: Result;
	let isError = false;
	try {
		result = (await execute(toolCallId, call.input, undefined, undefined, ctx)) as Result;
	} catch (error) {
		// Pi turns a thrown tool error into an error result and still runs tool_result.
		result = { content: [{ type: "text", text: (error as Error).message }], details: {} };
		isError = true;
	}
	for (const handler of apiMock.getHandlers("tool_result")) {
		const event = { type: "tool_result", toolName: "bash", toolCallId, input: call.input, isError, ...result };
		const patch = await handler(event, ctx);
		if (patch) result = { ...result, ...patch };
	}
	return result.content.map((part) => part.text ?? "").join("\n");
}

describe.runIf(canGuard)("pkill and pgrep in a Pi bash call", () => {
	it("a pkill -f pattern stops its target and the rest of the command still runs", async () => {
		const inside = startInside();

		const output = await runBash(`pkill -f ${token}; echo "after pkill: $?"`);

		expect(output).toContain("after pkill: 0");
		expect(await stopsWithin(inside, 2000)).toBe(true);
		expect(output).toContain("also matched the shell running this bash call");
	});

	it("pgrep -f lists the matching process and not the shell running the call", async () => {
		const inside = startInside();

		const output = await runBash(`pgrep -f ${token}`);

		expect(output.split("\n").filter((line) => /^\d+$/.test(line))).toEqual([String(inside.pid)]);
	});

	it("a pkill pattern that also matches Pi itself leaves Pi running", async () => {
		// The test process plays Pi: it spawns the bash call, so the guard treats it as the harness.
		const originalTitle = process.title;
		let signalled = 0;
		const onSignal = () => signalled++;
		process.on("SIGUSR2", onSignal);
		process.title = `${token}-pi`;
		const inside = startInside();
		try {
			const output = await runBash(`pkill -USR2 -f ${token}; echo "after pkill: $?"`);

			expect(output).toContain("after pkill: 0");
			expect(await stopsWithin(inside, 2000)).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(signalled).toBe(0);
			expect(output).toContain("also matched Pi itself");
		} finally {
			process.title = originalTitle;
			process.off("SIGUSR2", onSignal);
		}
	});

	it("pgrep -V prints its version and is not reported as a match", async () => {
		const output = await runBash("pgrep -V");

		expect(output).toContain("procps");
		expect(output).not.toContain("also matched");
	});

	it("pkill -v is refused", async () => {
		// Signal 0 only checks that processes exist, so this is harmless either way.
		const output = await runBash(`pkill -0 -v -f ${token}; echo "rc=$?"`);

		expect(output).toContain("rc=2");
		expect(output).toContain("was refused");
	});

	describe.runIf(canStartOutsideSession)("processes outside this session", () => {
		it("pkill leaves them alone and tells the model, even with stderr discarded", async () => {
			const inside = startInside();
			const outside = await startOutside();

			const output = await runBash(`pkill -f ${token} 2>/dev/null; echo "after pkill: $?"`);

			expect(output).toContain("after pkill: 0");
			expect(await stopsWithin(inside, 2000)).toBe(true);
			expect(await stopsWithin(outside, 500)).toBe(false);
			expect(output).toContain("outside this Pi session");
			expect(output).toContain(String(outside.pid));
		});

		it("pkill reports no match when only they match, and the model still hears why", async () => {
			const outside = await startOutside();

			const output = await runBash(`pkill -f ${token} 2>/dev/null`);

			expect(output).toContain("exit code 1");
			expect(output).toContain("Nothing inside this session matched");
			expect(await stopsWithin(outside, 500)).toBe(false);
		});

		it("pkill -p still signals one of them by PID", async () => {
			const outside = await startOutside();

			await runBash(`pkill -p ${outside.pid}`);

			expect(await stopsWithin(outside, 2000)).toBe(true);
		});
	});
});
