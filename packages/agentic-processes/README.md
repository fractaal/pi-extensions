# @fractaal/pi-agentic-processes

Agentic process lifecycle tools for Pi.

This package canonicalizes Ben's personal `bash-backgrounding.ts` and
`monitor.ts` hooks into one reusable extension package. It preserves the public
LLM tool surface while the implementation grows a headless management core that
ALR and future Pi TUI controls can call.

Registered tools:

- `bash`
- `bash_output`
- `bash_tasks`
- `kill_bash`
- `monitor_start`
- `monitor_status`
- `monitor_list`
- `monitor_stop`

Process execution, foreground/background timing, monitor guardrails, and stop
semantics remain compatible with the original personal Pi hooks. Bash and monitor
output is spooled beneath the operating system's temporary directory, retained
while the owning Pi session can inspect it, and removed on graceful session
shutdown. The package does not recover processes or logs after a Pi restart.

## Headless management API

Consumers running in the same Pi process can request the session-scoped API from
Pi's shared extension event bus:

```ts
import { requestAgenticProcessManagementApi } from "@fractaal/pi-agentic-processes";

const processes = requestAgenticProcessManagementApi(pi.events);
```

The API exposes `list()`, `readOutput(id, tailBytes?)`, `stop(id, reason?)`, and
`subscribe(listener)`. Bash and monitor jobs appear in one list; output reads use
the existing bounded combined log contract. The API manages the same records as
the LLM tools and becomes unavailable when the owning Pi session shuts down. It
does not persist or recover processes across Pi process restarts.

## Per-task Bash spawn context

Embedded runtimes can configure the package without replacing its Bash tool:

```ts
import { createAgenticProcessesExtension } from "@fractaal/pi-agentic-processes";

const extension = createAgenticProcessesExtension({
  bash: {
    spawnHook: (context) => ({
      ...context,
      env: { ...context.env, SESSION_ACTOR: currentActor() },
    }),
  },
});
```

The hook runs immediately before every Bash child spawn, including commands that
start in the background or auto-background later. It receives a fresh copy of
`process.env`; the package does not mutate process-global environment state.
