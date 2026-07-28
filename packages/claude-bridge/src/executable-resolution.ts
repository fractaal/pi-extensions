import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join, win32 } from "node:path";

export interface ClaudeCodeExecutableResolution {
	command: "claude" | "claude-code";
	executablePath: string;
}

export interface ResolveClaudeCodeExecutableOptions {
	configuredPath?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	allowWindowsShellShims?: boolean;
}

const DEFAULT_WINDOWS_PATH_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];
const WINDOWS_NATIVE_EXTENSIONS = new Set([".COM", ".EXE"]);

export function resolveClaudeCodeExecutable({
	configuredPath,
	env = process.env,
	platform = process.platform,
	allowWindowsShellShims = false,
}: ResolveClaudeCodeExecutableOptions = {}): ClaudeCodeExecutableResolution | null {
	const configured = configuredPath?.trim();
	const isWindows = platform === "win32";
	if (configured) {
		const extension = isWindows ? win32.extname(configured).toUpperCase() : "";
		if (!allowWindowsShellShims && isWindows && !WINDOWS_NATIVE_EXTENSIONS.has(extension)) {
			const received = extension || "an extensionless path";
			throw new Error(`Configured Claude executable must be a native Windows binary, not ${received}. Leave the path unset to use the bundled native CLI.`);
		}
		return {
			command: configuredCommandName(configured),
			executablePath: configured,
		};
	}

	const pathDelimiter = isWindows ? ";" : delimiter;
	const pathJoin = isWindows ? win32.join : join;
	const extensions = isWindows
		? windowsPathExtensions(env, allowWindowsShellShims)
		: [""];

	for (const command of ["claude", "claude-code"] as const) {
		for (const directory of (env.PATH ?? "").split(pathDelimiter).filter(Boolean)) {
			for (const extension of extensions) {
				const executablePath = pathJoin(directory, `${command}${extension}`);
				try {
					accessSync(executablePath, isWindows ? fsConstants.F_OK : fsConstants.X_OK);
					return { command, executablePath };
				} catch {
					// Keep searching the effective process PATH.
				}
			}
		}
	}
	return null;
}

function windowsPathExtensions(env: NodeJS.ProcessEnv, allowShellShims: boolean): string[] {
	const configured = (env.PATHEXT ?? DEFAULT_WINDOWS_PATH_EXTENSIONS.join(";"))
		.split(";")
		.map((value) => normalizeWindowsExtension(value))
		.filter(Boolean);
	const extensions = allowShellShims
		? configured
		: configured.filter((extension) => WINDOWS_NATIVE_EXTENSIONS.has(extension.toUpperCase()));
	return [...new Set(extensions)];
}

function normalizeWindowsExtension(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function configuredCommandName(configuredPath: string): ClaudeCodeExecutableResolution["command"] {
	const baseName = configuredPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	return baseName.startsWith("claude-code") ? "claude-code" : "claude";
}
