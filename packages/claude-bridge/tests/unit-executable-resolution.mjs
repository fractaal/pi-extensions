import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveClaudeCodeExecutable } from "@fractaal/pi-claude-bridge/executable-resolution";

function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "claude-bridge-resolution-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function executable(path) {
	writeFileSync(path, "#!/bin/sh\nexit 0\n");
	chmodSync(path, 0o755);
	return path;
}

describe("resolveClaudeCodeExecutable", () => {
	it("keeps claude ahead of claude-code across the effective POSIX PATH", { skip: process.platform === "win32" }, () => withTempDir((dir) => {
		const claudeCodeDir = join(dir, "claude-code-bin");
		const claudeDir = join(dir, "claude-bin");
		mkdirSync(claudeCodeDir);
		mkdirSync(claudeDir);
		executable(join(claudeCodeDir, "claude-code"));
		const claude = executable(join(claudeDir, "claude"));

		assert.deepEqual(resolveClaudeCodeExecutable({
			env: { PATH: `${claudeCodeDir}${delimiter}${claudeDir}` },
			platform: process.platform,
		}), { command: "claude", executablePath: claude });
	}));

	it("uses claude-code when it is the only POSIX executable", { skip: process.platform === "win32" }, () => withTempDir((dir) => {
		const claudeCode = executable(join(dir, "claude-code"));
		assert.deepEqual(resolveClaudeCodeExecutable({ env: { PATH: dir }, platform: process.platform }), {
			command: "claude-code",
			executablePath: claudeCode,
		});
	}));

	it("models native Windows resolution without selecting a shell shim", { skip: process.platform === "win32" }, () => withTempDir((dir) => {
		const previousCwd = process.cwd();
		process.chdir(dir);
		try {
			writeFileSync("C:\\shim\\claude", "#!/bin/sh\n");
			writeFileSync("C:\\shim\\claude.CMD", "@echo off\r\n");
			writeFileSync("C:\\native\\claude.EXE", "MZ");
			assert.deepEqual(resolveClaudeCodeExecutable({
				env: { PATH: "C:\\shim;C:\\native", PATHEXT: ".CMD;.EXE" },
				platform: "win32",
			}), {
				command: "claude",
				executablePath: "C:\\native\\claude.EXE",
			});
		} finally {
			process.chdir(previousCwd);
		}
	}));

	it("models Windows shell-shim resolution for status and login callers", { skip: process.platform === "win32" }, () => withTempDir((dir) => {
		const previousCwd = process.cwd();
		process.chdir(dir);
		try {
			writeFileSync("C:\\tools\\claude.CMD", "@echo off\r\n");
			assert.deepEqual(resolveClaudeCodeExecutable({
				env: { PATH: "C:\\tools", PATHEXT: ".CMD;.EXE" },
				platform: "win32",
				allowWindowsShellShims: true,
			}), {
				command: "claude",
				executablePath: "C:\\tools\\claude.CMD",
			});
		} finally {
			process.chdir(previousCwd);
		}
	}));

	it("resolves native and shell-shim commands on a Windows host", { skip: process.platform !== "win32" }, () => withTempDir((dir) => {
		const shimDir = join(dir, "shim");
		const nativeDir = join(dir, "native");
		mkdirSync(shimDir);
		mkdirSync(nativeDir);
		writeFileSync(join(shimDir, "claude.CMD"), "@echo off\r\n");
		writeFileSync(join(nativeDir, "claude.EXE"), "MZ");
		const env = { PATH: `${shimDir};${nativeDir}`, PATHEXT: ".CMD;.EXE" };

		assert.deepEqual(resolveClaudeCodeExecutable({ env, platform: "win32" }), {
			command: "claude",
			executablePath: join(nativeDir, "claude.EXE"),
		});
		assert.deepEqual(resolveClaudeCodeExecutable({ env, platform: "win32", allowWindowsShellShims: true }), {
			command: "claude",
			executablePath: join(shimDir, "claude.CMD"),
		});
	}));

	it("honors an explicit configured path without persisting auto-discovery", () => {
		assert.deepEqual(resolveClaudeCodeExecutable({ configuredPath: " /custom/claude-code " }), {
			command: "claude-code",
			executablePath: "/custom/claude-code",
		});
	});

	it("refuses to feed an explicitly configured Windows shell shim into Agent SDK execution", () => {
		assert.throws(
			() => resolveClaudeCodeExecutable({ configuredPath: "C:\\tools\\claude.CMD", platform: "win32" }),
			/native Windows binary, not \.CMD/,
		);
		assert.throws(
			() => resolveClaudeCodeExecutable({ configuredPath: "C:\\tools\\claude", platform: "win32" }),
			/native Windows binary, not an extensionless path/,
		);
		assert.deepEqual(resolveClaudeCodeExecutable({
			configuredPath: "C:\\tools\\claude.CMD",
			platform: "win32",
			allowWindowsShellShims: true,
		}), {
			command: "claude",
			executablePath: "C:\\tools\\claude.CMD",
		});
	});
});
