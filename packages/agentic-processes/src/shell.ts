import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { existsSync as nodeExistsSync } from "node:fs";
import path from "node:path";

export interface BashShellSpec {
	command: string;
	args: string[];
}

type Platform = NodeJS.Platform | "win32" | "linux" | "darwin";
type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;
type ExistsSync = (path: string) => boolean;
type Spawn = typeof nodeSpawn;

export interface ShellResolutionOptions {
	env?: Env;
	platform?: Platform;
	existsSync?: ExistsSync;
}

export interface KillProcessOptions {
	platform?: Platform;
	spawn?: Spawn;
}

export function resolveBashShell(options: ShellResolutionOptions = {}): BashShellSpec {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const existsSync = options.existsSync ?? nodeExistsSync;
	const configured = getEnv(env, "PI_BASH_PATH") || getEnv(env, "ARIA_LOCAL_BASH_PATH");
	if (configured) {
		if (existsSync(configured)) return { command: configured, args: ["-lc"] };
		throw new Error(`Configured Bash path does not exist: ${configured}`);
	}

	if (platform !== "win32") {
		for (const candidate of ["/bin/bash", "/usr/bin/bash"]) {
			if (existsSync(candidate)) return { command: candidate, args: ["-lc"] };
		}
		return { command: "bash", args: ["-lc"] };
	}

	for (const candidate of windowsBashCandidates(env)) {
		if (existsSync(candidate)) return { command: candidate, args: ["-lc"] };
	}

	throw new Error(
		"Aria Local could not find Bash on Windows. Install Git for Windows, or set PI_BASH_PATH / ARIA_LOCAL_BASH_PATH to a Bash executable.",
	);
}

export function windowsBashCandidates(env: Env = process.env): string[] {
	return uniqueStrings([
		...pathCandidates("bash.exe", env, "win32"),
		...(getEnv(env, "ProgramFiles") ? [path.win32.join(getEnv(env, "ProgramFiles") ?? "", "Git", "bin", "bash.exe")] : []),
		...(getEnv(env, "ProgramFiles") ? [path.win32.join(getEnv(env, "ProgramFiles") ?? "", "Git", "usr", "bin", "bash.exe")] : []),
		...(getEnv(env, "ProgramFiles(x86)")
			? [path.win32.join(getEnv(env, "ProgramFiles(x86)") ?? "", "Git", "bin", "bash.exe")]
			: []),
		...(getEnv(env, "ProgramFiles(x86)")
			? [path.win32.join(getEnv(env, "ProgramFiles(x86)") ?? "", "Git", "usr", "bin", "bash.exe")]
			: []),
		"C:\\Program Files\\Git\\bin\\bash.exe",
		"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
		"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
		"C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
	]);
}

export function killChildProcessTree(
	child: Pick<ChildProcess, "pid" | "kill">,
	signal: NodeJS.Signals = "SIGKILL",
	options: KillProcessOptions = {},
): void {
	if (!child.pid) return;
	const platform = options.platform ?? process.platform;
	if (platform === "win32") {
		const killer = spawnTaskkill(child.pid, signal, options.spawn ?? nodeSpawn);
		killer.on("error", () => {
			try {
				child.kill(signal);
			} catch {
				// Already exited.
			}
		});
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Already exited.
		}
	}
}

export async function killProcessTree(
	pid: number,
	signal: NodeJS.Signals = "SIGTERM",
	options: KillProcessOptions = {},
): Promise<void> {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") {
		process.kill(-pid, signal);
		return;
	}

	await new Promise<void>((resolve, reject) => {
		let killer: ReturnType<Spawn>;
		try {
			killer = spawnTaskkill(pid, signal, options.spawn ?? nodeSpawn);
		} catch (error) {
			reject(error);
			return;
		}
		killer.once("error", reject);
		killer.once("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`taskkill exited with code ${code ?? "null"}.`));
		});
	});
}

function spawnTaskkill(pid: number, signal: NodeJS.Signals, spawn: Spawn): ReturnType<Spawn> {
	const args = ["/PID", String(pid), "/T"];
	if (signal === "SIGKILL") args.push("/F");
	return spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
}

function pathCandidates(command: string, env: Env, platform: Platform): string[] {
	const pathValue = getEnv(env, "PATH") || "";
	const delimiter = platform === "win32" ? ";" : path.delimiter;
	const pathModule = platform === "win32" ? path.win32 : path;
	return pathValue
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((dir) => pathModule.join(dir, command));
}

function getEnv(env: Env, name: string): string | undefined {
	const exact = env[name];
	if (exact !== undefined) return exact;
	const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
	return key ? env[key] : undefined;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}
