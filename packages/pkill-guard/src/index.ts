import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

// Pi runs each bash call as `bash -lc <command>`, so that shell's argv holds the
// whole command text. A `pkill -f <pattern>` written in the command therefore
// matches the shell running it and kills its own call (exit 143), and a loose
// pattern such as `pkill -f "x"` reaches every process the user runs. For
// commands that mention pkill or pgrep, this puts ../bin first on PATH. Its
// shim leaves the call's own shells out of the match and only lets pkill signal
// processes in this Pi session's cgroup (see bin/pkill). After the call, any
// note the shim left is added to the result so the model learns what happened.

const BIN_DIR = fileURLToPath(new URL("../bin", import.meta.url));
const GUARDED_TOOLS = new Set(["bash", "monitor_start"]);
const MENTIONS_PKILL_OR_PGREP = /\bp(?:kill|grep)\b/;

export default function pkillGuardExtension(pi: ExtensionAPI): void {
	// The shim reads /proc and cgroup v2, which only Linux has.
	if (process.platform !== "linux") return;

	pi.on("tool_call", (event) => {
		if (!GUARDED_TOOLS.has(event.toolName)) return;
		const input = event.input as { command?: unknown };
		if (typeof input.command !== "string" || !MENTIONS_PKILL_OR_PGREP.test(input.command)) return;
		input.command =
			`export PATH=${shellQuote(BIN_DIR)}:"$PATH" PKILL_SELF_SAFE_ROOT=${process.pid} PKILL_SELF_SAFE_ID=${noteId(event.toolCallId)}` +
			`  # pkill/pgrep: skip the shell running this call\n${input.command}`;
	});

	pi.on("tool_result", (event) => {
		if (!GUARDED_TOOLS.has(event.toolName)) return;
		const file = path.join(process.env.XDG_RUNTIME_DIR || "/tmp", "pkill-self-safe", noteId(event.toolCallId));
		let notes: string;
		try {
			notes = readFileSync(file, "utf8");
		} catch {
			return;
		}
		rmSync(file, { force: true });
		const text = describeNotes(notes);
		if (!text) return;
		const result: { content: ToolResultEvent["content"]; structuredContent?: unknown } = {
			content: [...event.content, { type: "text", text }],
		};
		// Pi drops structured content when content is replaced, unless it is handed back.
		if ("structuredContent" in event) result.structuredContent = event.structuredContent;
		return result;
	});
}

// The shim only accepts IDs it can use as a file name; Pi's contain `|`.
function noteId(toolCallId: string): string {
	return toolCallId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Note lines are tab-separated, kind first (see note() in bin/pkill):
//   pkill|pgrep  selection  call       its own shell matched
//   skipped      inside     call  outside  groups  examples
//   refused      -          call
//   harness      selection  call       "PID name" of Pi, which it matched
function describeNotes(notes: string): string {
	const rows = [...new Set(notes.split("\n").filter(Boolean))].map((line) => line.split("\t"));
	const self = unique(rows.filter(([kind]) => kind === "pkill" || kind === "pgrep").map((row) => row[2] ?? "")).slice(0, 3);
	const skipped = uniqueBy(rows.filter(([kind]) => kind === "skipped"), (row) => row[2] ?? "").slice(0, 3);
	const refused = unique(rows.filter(([kind]) => kind === "refused").map((row) => row[2] ?? ""));
	const harness = uniqueBy(rows.filter(([kind]) => kind === "harness"), (row) => row[2] ?? "").slice(0, 3);

	const parts: string[] = [];
	if (self.length > 0) {
		const harm = [
			self.some((call) => call.startsWith("pkill"))
				? "pkill would have killed this call (exit 143), and nothing after it would have run"
				: undefined,
			self.some((call) => call.startsWith("pgrep"))
				? "pgrep would have listed that shell as a match, so `kill $(pgrep ...)` would have killed this call, and a loop waiting for pgrep to come up empty would never end"
				: undefined,
		]
			.filter(Boolean)
			.join("; also, ");
		parts.push(
			`${self.map((call) => `\`${call}\``).join(", ")} also matched the shell running this bash call. ` +
				"Pi runs each call as one `bash -lc` process whose command line holds the whole command text, so a -f pattern written in the command matches that shell too. " +
				`Without this guard, ${harm}. The guard left that shell out of the match, so the command ran as you meant it and needs no change. ` +
				"In this environment you can write pkill -f and pgrep -f patterns normally; only sudo pkill is not covered.",
		);
	}
	for (const [, inside, call, outside, groups, examples] of skipped) {
		parts.push(
			`\`${call}\` also matched ${count(outside, "process", "processes")} outside this Pi session, in ${count(groups, "group", "groups")} (for example ${examples}). ` +
				"Those belong to the desktop, other apps or other agents, so the guard did not signal them: pkill here only reaches processes this session started, which share its cgroup. " +
				(inside === "0"
					? "Nothing inside this session matched, so nothing was signalled."
					: `It signalled the ${count(inside, "match", "matches")} inside this session.`) +
				" If you meant one of the others, check it with `ps -o pid,args -p <PID>` and kill it by PID.",
		);
	}
	for (const [, , call, pi] of harness) {
		parts.push(
			`\`${call}\` also matched Pi itself (PID ${pi}). Signalling it would have ended this whole session, so the guard left Pi out; other matches were handled as usual.`,
		);
	}
	for (const call of refused) {
		parts.push(
			`\`${call}\` was refused: pkill -v signals every process that does not match, which is nearly everything the user runs. Kill specific PIDs instead.`,
		);
	}
	return parts.join("\n\n");
}

function count(n: string | undefined, one: string, many: string): string {
	return `${n} ${n === "1" ? one : many}`;
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const k = key(value);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}
