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

Current behavior is intentionally parity-first: process execution, output logs,
foreground/background timing, monitor guardrails, and stop semantics stay
compatible with the original personal Pi hooks.

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
