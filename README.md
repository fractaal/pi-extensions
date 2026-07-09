# pi-extensions

fractaal's Pi extension monorepo — agentic QoL extensions published to npm under `@fractaal`.

## Packages

| Package | What it does |
|---|---|
| [`@fractaal/pi-agentic-processes`](packages/agentic-processes) | Background bash tasks, sparse monitors, and headless management APIs (`bash-backgrounding` + `monitor` extensions). |
| [`@fractaal/pi-fractal-compact`](packages/fractal-compact) | High-fidelity compaction extension. |
| [`@fractaal/pi-codex-usage-info`](packages/codex-usage-info) | Codex/OpenAI usage statusline extension. |
| [`@fractaal/pi-directive-roots`](packages/directive-roots) | Directive-root loading and mid-turn discovery for `CLAUDE.md`, `AGENTS.md`, `MEMORY.md`, and shared skill directories. |

## Consumption

Each package ships two entry doors from one implementation:

- **Pi's loader**: the `pi.extensions` manifest points at `./src/index.ts`; Pi compiles TypeScript itself. `pi install npm:@fractaal/pi-agentic-processes`.
- **Programmatic import**: `exports` points at compiled JS in `dist/`, built at publish time by `prepack`. Hosts embedding Pi as a library (e.g. Aria Local Runtime) import extension factories as ordinary modules.

The publishing pattern is documented in the reference implementation: [`@fractaal/pi-cross-agent-memory`](https://github.com/fractaal/pi-cross-agent-memory) — see its "Publishing a Pi extension properly" README section. `dist/` is never committed; no git-SHA tarball pins; no `.ts` paths resolved out of `node_modules` at runtime.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Release (per package):

```bash
cd packages/<name>
npm version minor
npm publish   # prepack builds dist/
```

## Provenance

`agentic-processes`, `fractal-compact`, and `codex-usage-info` were originally canonicalized inside a fork of [Jonghakseo/pi-extension](https://github.com/Jonghakseo/pi-extension) and moved here to live under fractaal ownership with proper npm publishing.
