# @fractaal/pi-todo

A small Pi extension that owns one revisioned Todo plan per session branch.

- Read tool: `get_todo()`
- Mutation tool: `todo({ baseRevision?, tasks, remove? })`
- Event: `pi-todo:state`
- Replay request: `pi-todo:request-state`
- Persistence: Pi session custom entries only

The complete task snapshot is authoritative and must fit the 16 KiB serialized UTF-8 plan budget. Existing unfinished tasks cannot disappear unless the mutation names them in `remove` with a non-empty reason. Completed tasks may leave the current working plan.

Todo contents are retrieved through `get_todo` and normal durable tool history, never floated into every provider request. Stable prompt guidance plus bounded durable checkpoints restore salience after meaningful context growth, restoration, or compaction without waking an idle model solely for bookkeeping. Complete-only and empty plans queue no checkpoints.

## Install and embed

```bash
pi install npm:@fractaal/pi-todo
```

The package root exports the compiled extension factory; `/contracts` exports the public contracts. Pi discovers the shipped TypeScript entry through `pi.extensions`. These entrypoints and persisted state formats are unchanged by the repository move.

## Development and releases

Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `npm run test:installed` from the monorepo root. The shared Node tests and isolated installed-package acceptance live in `packages/goal-x/tests` and are included in those commands.

Use the [shared release guide](https://github.com/fractaal/pi-extensions/blob/main/docs/releasing.md) and tag `todo-v<version>`. This package has its own version and npm Trusted Publisher, even when released in a batch with its siblings.

Version 0.1.3 imports the unchanged runtime of 0.1.2 from `fractaal/pi-goal-x@f74698d6a0eb9f78ff80e7adb01c6a9070010804`, without private Git history. The original MIT license is retained.
