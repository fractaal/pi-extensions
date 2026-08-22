# @fractaal/pi-directive-roots

Reusable Pi extension for directive roots shared by Aria Local Runtime, Ben's personal Pi, and Cloud Pi Aria-style workflows.

A **directive root** is a directory containing one or more directive files:

- `CLAUDE.md`
- `AGENTS.md`
- `MEMORY.md`

For each directive root, the extension also exposes skill directories:

- `.claude/skills`
- `.agents/skills`
- `.codex/skills`

## Pi usage

```bash
pi install npm:@fractaal/pi-directive-roots
```

Local dogfood before publish:

```bash
pi install /path/to/pi-extensions/packages/directive-roots
```

Pi loads the extension through `package.json`'s `pi.extensions` manifest entry, which points at `./src/index.ts`. Pi's package loader compiles that TypeScript source itself.

## Embedding

ALR or another Node host imports the compiled package export:

```ts
import { createDirectiveRootsExtension } from '@fractaal/pi-directive-roots';

const extensionFactory = createDirectiveRootsExtension({
  boundary: 'git',
  directiveFiles: [
    { scope: 'org', path: 'CLAUDE.md', content: 'Org directives...' },
  ],
});
```

The Node import resolves to `dist/` through the package `exports` map. Do not import `src/index.ts` from a Node host.

## Behavior

- Startup/resource discovery loads directive roots around the current cwd and derives all supported skill directories.
- `before_agent_start` appends directive file content that Pi has not already loaded through its normal context-file system, deduplicating identical trimmed content across paths and directive groups.
- Read-like tool results (`read`, `grep`, `find`, `ls`) are allowed, then annotated with a `<system-notice>` when they enter a directory governed by newly discovered directives.
- Write-like tool calls (`write`, `edit`) are blocked until newly applicable directive files are surfaced to the model.
- Mid-session discoveries are persisted with `pi.appendEntry()` so reloaded sessions can reconstruct the loaded directive paths.

## Publish flow

Commit the package version bump to `main`, then push its release tag:

```bash
git tag directive-roots-v0.1.1
git push origin directive-roots-v0.1.1
```

The monorepo's `publish-npm.yml` workflow verifies the live tag, package version, and `main` ancestry before testing, building, packing, and publishing through npm Trusted Publishing. The npm package must authorize repository `fractaal/pi-extensions`, workflow `publish-npm.yml`, and environment `npm-publish`; that GitHub environment and matching release tags must be protected before the first release. No local npm login, token, OTP, or `npm publish` command is part of the release path.

`prepack` builds `dist/` for the npm tarball. `dist/` is ignored by git and should not be committed.
