# @fractaal/pi-pkill-guard

Stops two ways an agent's `pkill` goes wrong in Pi.

**It kills its own call.** Pi runs each bash call as one `bash -lc <command>`
process, so that shell's command line holds the whole command text. A
`pkill -f <pattern>` written in the command matches the shell running it, and
the call dies with exit 143 before the rest of the command runs.
`kill $(pgrep -f ...)` dies the same way, and a loop waiting for
`pgrep -f ...` to come up empty never ends.

**It kills everything else.** A loose pattern such as `pkill -f "x"` signals
every process with an x in its command line: the terminal multiplexer and every
agent in it, the D-Bus session bus, the portals, browsers.

## What it does

For `bash` and `monitor_start` calls whose command mentions `pkill` or `pgrep`,
the extension puts this package's `bin/` first on `PATH`. The `pkill` and
`pgrep` there wrap the real ones:

| Case | What happens |
|---|---|
| The pattern matches the call's own shell | That shell is left out, so the command runs as written. |
| The pattern matches Pi itself | `pkill` leaves Pi out, so the session keeps running. `pgrep` still lists it. |
| `pkill` matches processes inside this Pi session | Signalled as normal. |
| `pkill` matches processes outside this Pi session | Left alone and reported. If nothing inside matched, `pkill` exits 1. |
| `pkill -p <PID>` or `pkill -F <pidfile>` | Passed straight through: a named PID is deliberate. |
| `pkill -v` | Refused with exit 2: it signals nearly everything the user runs. |

"This Pi session" is Pi's cgroup. tmux gives each pane its own systemd scope,
and processes stay in it even after they daemonize, so the session's own servers
and test runners count as inside. The desktop, other apps and agents in other
panes are outside. Pi started some other way shares whatever cgroup its terminal
or service has.

When the guard steps in, it adds a note to the tool result. The note says what
matched, what was left alone and why, so the model learns this even when the
command discarded stderr with `2>/dev/null`. Matches left alone are also reported on stderr.

## Limits

- Linux only, and it needs a procps-ng `pgrep` that accepts `--cgroup` and
  `-p`/`--pid`. Older ones, such as on GitHub's Ubuntu runners, don't. Where
  either is missing, the extension does nothing.
- `sudo pkill`, `killall`, and `kill $(pgrep -f <loose pattern>)` aimed at other
  processes are not limited. `pgrep` can't tell that its output is about to be
  killed.
- A broad pattern can still signal this session's own processes, such as its
  MCP servers or background tasks.
- A call that moves to the background returns before its notes are written;
  the `pkill` stderr report still lands in the task's output.

## Claude Code

`bin/pkill` also works for Claude Code, where `$CLAUDE_PID` marks the harness.
A PreToolUse hook can put `bin/` on `PATH` and set `PKILL_SELF_SAFE_ID` to the
tool call ID. A PostToolUse hook then reads the notes from
`$XDG_RUNTIME_DIR/pkill-self-safe/<id>`.
