# Extension source consolidation

The migration keeps separate npm packages, independently versioned, with unchanged runtime implementations and public exports. It does not create an umbrella installation package or import private Git history.

| Source snapshot | Package | Old → prepared version | Destination |
|---|---|---|---|
| `fractaal/pi-cross-agent-memory@0abc6686552fd1474454d6071e23eb9081ac7eca` | `@fractaal/pi-cross-agent-memory` | 0.3.0 → 0.3.1 | `packages/cross-agent-memory` |
| `fractaal/pi-goal-x@f74698d6a0eb9f78ff80e7adb01c6a9070010804` | `@fractaal/pi-goal-x` | 0.28.8 → 0.28.9 | `packages/goal-x` |
| Same Goal snapshot | `@fractaal/pi-todo` | 0.1.2 → 0.1.3 | `packages/todo` |
| Same Goal snapshot | `@fractaal/pi-context-window` | 0.1.0 → 0.1.1 | `packages/context-window` |

The original licenses stay with the packages. Goal's shipped architecture document is retained; private historical branches/specs and repository-specific publishing machinery are not imported.

## Tests and build ownership

- Cross-agent-memory's original Vitest suite moves alongside its unchanged source; additional acceptance verifies the actual packed Node and Pi entrypoints.
- The existing shared Goal-family suite moves to `packages/goal-x/tests`. Imports and fixture paths point to sibling Todo/context-window packages; the workspace lockfile assertion now checks `packages/goal-x` instead of the old repository root. Runtime behavior assertions remain intact.
- The original installed-package suite retains real Pi RPC discovery, contract imports, deterministic Goal continuation/completion/compaction, Todo idempotence, and context-window branch/restart/clone/fork/compaction checks. Each package is still installed alone.
- Goal-family tests use Node's test runner, not Vitest. Root commands explicitly invoke both and avoid double-discovering Node tests as Vitest tests.
- Strict package typechecks and the existing ESLint gate are retained. The shared development harness uses Goal's existing Pi 0.84.1, while Claude Bridge and Fractal Compact retain their own host pins. No public peer requirement is broadened or raised by the migration.
- The original Goal repo's `npm-publishing.test.mjs`, `publish.mjs`, and release verifier tested its obsolete root-package/`fractaal-v*` publisher. They are replaced by the destination's existing independently versioned workspace-tag verifier and its tests, not carried as a competing publication path.

## Development dependency resolution

Goal's former development graph had fixes for `undici`, `minimatch`, and `brace-expansion`. Native version-targeted root overrides retain those fixes for the shared harness: `undici` 8.5.0 → 8.10.0, `minimatch` 10.2.5 → 10.2.6, and 5.x `brace-expansion` → 5.0.9. They do not override the old 1.x brace-expansion used by ESLint's 3.x minimatch. Pi remains a host peer, not a bundled runtime dependency of these extensions.

## Release and consumer transition

Use the [batch release procedure](releasing.md#batch-releases): one reviewed merge, the existing per-package tags at the same commit, and a Trusted Publisher check for each npm package. No pilot-first release is required.

Old npm versions and Git refs remain valid. Consumers already importing package roots, `/contracts`, or Goal's `/transcript-events` keep those paths. Pinned consumers upgrade deliberately after replacement release verification; migration is not a blanket Pi/ALR upgrade or deployment.

The old repositories should receive migration notices after the replacement release is verified. Do not archive/delete them or rewrite their history as part of publication. The older Git-installed MCP bridge is a separate revision/packaging decision, not implicitly upgraded by this change.
