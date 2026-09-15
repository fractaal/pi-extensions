import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cwd = process.cwd();
const sessionDirectory = mkdtempSync(path.join(tmpdir(), "portable-native-pi-"));

function writeSession(name, customType, data) {
	const sessionId = randomUUID();
	const sessionFile = path.join(sessionDirectory, `${name}.jsonl`);
	const timestamp = new Date().toISOString();
	writeFileSync(sessionFile, [
		JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd }),
		JSON.stringify({ type: "custom", id: randomUUID(), parentId: null, timestamp, customType, data }),
	].join("\n") + "\n");
	return sessionFile;
}

function runCase(label, extensionPaths, requiredCommands, prompts, sessionFile, expectedNotification) {
	return new Promise((resolve, reject) => {
		const child = spawn("pi", [
			"--offline",
			"--mode", "rpc",
			"--session", sessionFile,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			...extensionPaths.flatMap((extension) => ["--extension", extension]),
		], {
			cwd,
			env: { ...process.env, PI_CODING_AGENT_DIR: path.join(sessionDirectory, "profile") },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let buffer = "";
		let stderr = "";
		const events = [];
		let finished = false;

		function finish(error) {
			if (finished) return;
			finished = true;
			clearTimeout(watchdog);
			child.kill("SIGTERM");
			if (error) {
				reject(new Error(`${label}: ${error}\nstderr: ${stderr.trim() || "(empty)"}\nevents: ${JSON.stringify(events, null, 2)}`));
				return;
			}
			const commandList = events.find((event) => event.type === "response" && event.id === "commands")?.data?.commands ?? [];
			resolve({
				label,
				commands: commandList.map((command) => command.name).filter((name) => requiredCommands.includes(name)),
				notifications: events.filter((event) => event.type === "extension_ui_request" && event.method === "notify").map((event) => event.message),
			});
		}

		function check() {
			if (events.some((event) => event.type === "extension_error")) return finish("Native Pi reported an extension_error.");
			const commandResponse = events.find((event) => event.type === "response" && event.id === "commands");
			if (!commandResponse) return;
			const names = (commandResponse.data?.commands ?? []).map((command) => command.name);
			for (const required of requiredCommands) {
				if (!names.includes(required)) return finish(`Native Pi did not register /${required}.`);
			}
			if (!events.find((event) => event.type === "response" && event.id === "state")?.success) return;
			for (const prompt of prompts) {
				if (!events.find((event) => event.type === "response" && event.id === prompt.id)?.success) return;
			}
			const notifications = events.filter((event) => event.type === "extension_ui_request" && event.method === "notify");
			if (notifications.length < prompts.length) return;
			if (!notifications.some((event) => String(event.message).includes(expectedNotification))) return finish(`Native replay notification did not include ${JSON.stringify(expectedNotification)}.`);
			finish();
		}

		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line.trim()) continue;
				try {
					events.push(JSON.parse(line));
					check();
				} catch (error) {
					finish(`Native Pi emitted non-JSON stdout: ${line}\n${error}`);
				}
			}
		});
		child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
		child.on("error", (error) => finish(`Could not launch native Pi: ${error.message}`));
		child.on("exit", (code, signal) => {
			if (!finished) finish(`Native Pi exited before verification (code=${code}, signal=${signal}).`);
		});

		const watchdog = setTimeout(() => finish("Native Pi RPC smoke did not settle within 20 seconds."), 20_000);
		child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
		child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
		for (const prompt of prompts) child.stdin.write(`${JSON.stringify({ id: prompt.id, type: "prompt", message: prompt.message })}\n`);
	});
}

const goal = path.join(cwd, "extensions", "goal.ts");
const todo = path.join(cwd, "..", "todo", "extensions", "todo.ts");
const goalSession = writeSession("goal", "pi-goal-state-v1", {
	schemaVersion: 1,
	revision: 7,
	goal: {
		id: "native-goal",
		objective: "Replay the native Goal snapshot",
		status: "paused",
		autoContinue: false,
		usage: { tokensUsed: 12, activeSeconds: 3 },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:01.000Z",
		pause: { reason: "Native replay fixture" },
	},
});
const todoSession = writeSession("todo", "pi-todo-state-v1", {
	schemaVersion: 1,
	revision: 4,
	tasks: [{ key: "native", subject: "Replay the native Todo snapshot", status: "in_progress" }],
});
try {
	const results = await Promise.all([
		runCase("Goal standalone", [goal], ["goal", "goal-status", "goal-pause", "goal-resume", "goal-abandon", "goal-migrate"], [{ id: "goal-status", message: "/goal-status" }], goalSession, "Replay the native Goal snapshot"),
		runCase("Todo standalone", [todo], ["todos"], [{ id: "todos", message: "/todos" }], todoSession, "Replay the native Todo snapshot"),
	]);
	console.log(JSON.stringify({ pi: "native RPC", results }, null, 2));
} finally {
	rmSync(sessionDirectory, { recursive: true, force: true });
}
