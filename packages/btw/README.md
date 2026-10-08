# @fractaal/pi-btw

Side conversations for [Pi](https://github.com/earendil-works/pi). `/btw` branches the session's current context into a panel where you can keep talking to the model while the main agent carries on. Tool calls are blocked there. If the discussion turns out to matter, send it back to the main session.

```text
/btw why did it pick that approach?   start a side conversation from this point
/btw                                  pick one of this session's side conversations to resume, or start a new one
```

Side conversations keep going while hidden. The status line shows when one is replying or has a reply you have not seen.

In the panel:

| Key | Action |
|---|---|
| Enter | Ask a follow-up |
| Esc | Hide the panel; a reply in progress keeps going |
| Ctrl+C | Stop the reply in progress |
| Ctrl+S | Send the discussion back to the main session |
| Ctrl+Y | Copy the discussion to the clipboard |
| PgUp / PgDn | Scroll |

## How it works

The branch starts from the main session's context as it stands when you start it, including a run that is still in progress. Tool calls whose results have not arrived yet are marked as still running. The request repeats the main session's latest request exactly (prompt, tool declarations and history, including prompt text other extensions add for the run) and appends what the session gained since, so the provider can serve that prefix from its prompt cache. The panel title shows how much of the latest prompt was cached. Before the main session's first request in this Pi process, and after compaction or `/tree`, the branch uses the stored session history instead, which can lack prompt text added per run.

Tools stay declared, because removing them would change the cached prefix. When the model calls one, it gets a "blocked" result and is asked again. The first question also tells it that this is a temporary side conversation where tools do not run.

Side conversations exist only in memory. They are not written to the session file, and they end when Pi exits or the session changes.

**Send back** (Ctrl+S) adds the discussion to the main session as one message. It is framed as context the user brought back from an ephemeral branch and holds the side conversation from the branch point to the end. If the main agent is working, the message steers it after the current tool batch. If it is idle, the message starts a turn.

Each side conversation has its own session id (`<main id>:btw:<random>`). Providers that keep per-conversation state, such as Claude Bridge, therefore run it separately from the main session.

Requires Pi 0.86 or later and the interactive terminal UI.
