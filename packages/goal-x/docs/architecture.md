# Architecture

Goal and Todo are separate Pi-native producers. Each owns one full, versioned snapshot persisted as Pi session custom entries and replays that snapshot from the active session branch.

```text
@fractaal/pi-goal-x             @fractaal/pi-todo
pi-goal:state                    pi-todo:state
pi-goal:proposal                 revisioned full plan
pi-goal:transcript-event
          \                         /
                Pi event bus
                     |
              optional adapters
```

The event bus is non-replaying, so each producer also exposes a request-state event. A late consumer subscribes first, emits that request, and receives the complete current snapshot.

Goal uses Pi's own follow-up queue for autonomous continuation. Every continuation is the same durable custom message, `Continue the Goal.`. `before_agent_start` adds one deterministic semantic Goal block to the system prompt for the run; accounting revision, timestamps, usage, Goal identity, and active-time changes are excluded so unchanged Goal meaning preserves exact prompt bytes. Goal registers one stable `ctx.onIdle` callback; Pi owns the full run boundary, including retries, compaction, and queued messages, so Goal never polls or reconstructs lifecycle state. The callback rechecks the current Goal before sending, making stale registrations harmless. Normal agent ends register it; terminal `error` and `aborted` outcomes cancel any pending registration instead.

Model-owned blocking is a strict transition, not a discretionary pause. `set_goal_blocked` requires `blocker`, `evidence`, `whyNoAutonomousPathRemains`, and `unblockCondition`. The producer emits `goal_blocked`, disables continuation, and maps the proof into the existing `paused` state: the first three fields are encoded in labeled `pause.reason` text and the unblock condition occupies `pause.suggestedAction`. This keeps the versioned state shape and downstream projection compatible while preserving the full proof. The native `/goal-pause` command remains human-owned and emits `goal_paused`. No blocked status, attempt counter, blocker auditor, retry system, compaction system, scheduler, or database is added.

Completion runs an isolated auditor; shell access exists only behind a Bubblewrap read-only filesystem/network/process boundary and is omitted when that OS capability is unavailable. Approval permits one normal final response, and archival occurs only at `agent_settled`.

Todo accepts one full replacement plan and exposes one exact read-only `get_todo` tool. Validation happens before the single state mutation: stale revision, unexplained omission of unfinished work, normalized dependency collision, missing dependency, cycle, premature dependent progress, or the 16 KiB serialized UTF-8 plan budget rejects the mutation without changing state. Todo state is not inserted by a per-provider context transform. Stable tool guidance owns retrieval policy, while successful reads and writes expose the plan through durable tool history. If unfinished state grows at least 65,536 context tokens distant, Todo queues one stable hidden checkpoint into an inevitable tool-loop call or the next external turn. Restoration and compaction also queue one checkpoint when unfinished work remains. Checkpoints never impersonate the user or wake an idle model solely for bookkeeping.

A migration-only Goal module may read legacy embedded tasks and write both new entry schemas once. Explicit legacy focus—including explicit null—wins over session-state fallback, ambiguous open Goals require selection, and manual-active Goals migrate paused rather than unexpectedly continuing. The adapter rechecks the Todo byte budget before either new snapshot is appended. Neither ongoing core imports the other package, and legacy source files remain unchanged.
