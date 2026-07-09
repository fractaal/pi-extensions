import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDirectiveContextBlock,
  createDirectiveRootsExtension,
  discoverDirectiveFiles,
  skillPathsForRoots,
} from '../src/index.js';

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-directive-roots-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakePi() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any> | any>>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  return {
    pi: {
      on: vi.fn((name: string, handler: (event: any, ctx: any) => Promise<any> | any) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      }),
      appendEntry: vi.fn((customType: string, data: unknown) => appended.push({ customType, data })),
    },
    handlers,
    appended,
  };
}

async function emit(runtime: ReturnType<typeof fakePi>, name: string, event: any, ctx: any = {}) {
  const results = [];
  for (const handler of runtime.handlers.get(name) ?? []) results.push(await handler(event, ctx));
  return results;
}

describe('directive root primitives', () => {
  it('discovers CLAUDE.md, AGENTS.md, and MEMORY.md in target ancestry, deepest first, without crossing the boundary', async () => {
    const root = await tempRoot();
    const workspace = join(root, 'workspace');
    const src = join(workspace, 'src');
    await mkdir(src, { recursive: true });
    await writeFile(join(root, 'CLAUDE.md'), 'outside boundary', 'utf8');
    await writeFile(join(workspace, 'CLAUDE.md'), 'workspace claude', 'utf8');
    await writeFile(join(workspace, 'AGENTS.md'), 'workspace agents', 'utf8');
    await writeFile(join(src, 'MEMORY.md'), 'src memory', 'utf8');

    const files = await discoverDirectiveFiles({ targetPath: join(src, 'index.ts'), boundary: workspace });

    expect(files.map((file) => file.path)).toEqual([
      join(src, 'MEMORY.md'),
      join(workspace, 'CLAUDE.md'),
      join(workspace, 'AGENTS.md'),
    ]);
  });

  it('discovers directives when the discovery boundary is the filesystem root', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'MEMORY.md'), 'root-boundary memory', 'utf8');

    const files = await discoverDirectiveFiles({ targetPath: root, boundary: '/' });

    expect(files.map((file) => file.path)).toEqual([join(root, 'MEMORY.md')]);
  });

  it('discovers directives inside existing dot-named directories instead of guessing they are files', async () => {
    const root = await tempRoot();
    const configDir = join(root, '.config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'AGENTS.md'), 'dot-dir directive', 'utf8');

    const files = await discoverDirectiveFiles({ targetPath: configDir, boundary: root });

    expect(files.map((file) => file.path)).toEqual([join(configDir, 'AGENTS.md')]);
  });

  it('derives Claude, generic agent, and Codex skill directories for each directive root in order', () => {
    expect(skillPathsForRoots(['/project', '/user'])).toEqual([
      '/project/.claude/skills',
      '/project/.agents/skills',
      '/project/.codex/skills',
      '/user/.claude/skills',
      '/user/.agents/skills',
      '/user/.codex/skills',
    ]);
  });

  it('renders directive context groups while deduping paths already loaded by Pi context files', () => {
    const block = buildDirectiveContextBlock([
      { scope: 'project', path: '/repo/AGENTS.md', content: 'already loaded', group: 'Local project directive context' },
      { scope: 'project', path: '/repo/MEMORY.md', content: 'remember this', group: 'Local project directive context' },
      { scope: 'org', path: 'CLAUDE.md', content: 'org rules', group: 'Firestore org/user directive context' },
    ], { alreadyLoadedPaths: new Set(['/repo/AGENTS.md']) });

    expect(block).toContain('## Firestore org/user directive context');
    expect(block).toContain('scope="org" path="CLAUDE.md"');
    expect(block).toContain('org rules');
    expect(block).toContain('## Local project directive context');
    expect(block).toContain('scope="project" path="/repo/MEMORY.md"');
    expect(block).toContain('remember this');
    expect(block).not.toContain('already loaded');
  });

  it('keeps org and user Firestore directives when they share the same relative path', () => {
    const block = buildDirectiveContextBlock([
      { scope: 'org', path: 'CLAUDE.md', content: 'org rules', group: 'Firestore org/user directive context' },
      { scope: 'user', path: 'CLAUDE.md', content: 'user rules', group: 'Firestore org/user directive context' },
    ]);

    expect(block).toContain('scope="org" path="CLAUDE.md"');
    expect(block).toContain('org rules');
    expect(block).toContain('scope="user" path="CLAUDE.md"');
    expect(block).toContain('user rules');
  });
});

describe('Pi extension behavior', () => {
  it('loads initial directive-root skill paths including .codex/skills', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'CLAUDE.md'), 'project rules', 'utf8');
    const runtime = fakePi();
    createDirectiveRootsExtension({ boundary: root })(runtime.pi as never);

    await emit(runtime, 'session_start', { reason: 'startup' }, { cwd: root, sessionManager: { getBranch: () => [] }, hasUI: false });
    const results = await emit(runtime, 'resources_discover', { cwd: root, reason: 'startup' }, { cwd: root });

    expect(results[0].skillPaths).toEqual([
      join(root, '.claude', 'skills'),
      join(root, '.agents', 'skills'),
      join(root, '.codex', 'skills'),
    ]);
  });

  it('injects undiscovered directive files before agent start without duplicating Pi-loaded context files', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'AGENTS.md'), 'Pi already loaded this', 'utf8');
    await writeFile(join(root, 'MEMORY.md'), 'project memory', 'utf8');
    const runtime = fakePi();
    createDirectiveRootsExtension({ boundary: root })(runtime.pi as never);

    await emit(runtime, 'session_start', { reason: 'startup' }, { cwd: root, sessionManager: { getBranch: () => [] }, hasUI: false });
    const results = await emit(runtime, 'before_agent_start', {
      systemPrompt: 'base prompt',
      systemPromptOptions: { contextFiles: [{ path: join(root, 'AGENTS.md'), content: 'Pi already loaded this' }] },
    }, { cwd: root });

    expect(results[0].systemPrompt).toContain('base prompt');
    expect(results[0].systemPrompt).toContain('project memory');
    expect(results[0].systemPrompt).not.toContain('Pi already loaded this');
  });

  it('appends a system notice to successful read results and persists newly discovered directive paths', async () => {
    const root = await tempRoot();
    const src = join(root, 'src');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'CLAUDE.md'), 'src rules', 'utf8');
    const runtime = fakePi();
    createDirectiveRootsExtension({ boundary: root })(runtime.pi as never);
    await emit(runtime, 'session_start', { reason: 'startup' }, { cwd: root, sessionManager: { getBranch: () => [] }, hasUI: false });

    const results = await emit(runtime, 'tool_result', {
      toolName: 'read',
      toolCallId: 'tool-1',
      input: { path: join(src, 'file.ts') },
      content: [{ type: 'text', text: 'file content' }],
      isError: false,
    }, { cwd: root });

    expect(results[0].content[0].text).toContain('file content');
    expect(results[0].content[0].text).toContain('<system-notice>');
    expect(results[0].content[0].text).toContain(join(src, 'CLAUDE.md'));
    expect(runtime.appended.at(-1)?.data).toMatchObject({ loadedDirectivePaths: [join(src, 'CLAUDE.md')] });
  });

  it('blocks write/edit until newly applicable directive files have been surfaced', async () => {
    const root = await tempRoot();
    const src = join(root, 'src');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'MEMORY.md'), 'src memory', 'utf8');
    const runtime = fakePi();
    createDirectiveRootsExtension({ boundary: root })(runtime.pi as never);
    await emit(runtime, 'session_start', { reason: 'startup' }, { cwd: root, sessionManager: { getBranch: () => [] }, hasUI: false });

    const results = await emit(runtime, 'tool_call', {
      toolName: 'edit',
      toolCallId: 'tool-2',
      input: { path: join(src, 'file.ts') },
    }, { cwd: root });

    expect(results[0]).toMatchObject({ block: true });
    expect(results[0].reason).toContain('Read these files');
    expect(results[0].reason).toContain(join(src, 'MEMORY.md'));
  });

  it('does not announce directive files outside the target ancestry', async () => {
    const root = await tempRoot();
    const src = join(root, 'src');
    const sibling = join(root, 'sibling');
    await mkdir(src, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, 'CLAUDE.md'), 'sibling only', 'utf8');
    const runtime = fakePi();
    createDirectiveRootsExtension({ boundary: root })(runtime.pi as never);
    await emit(runtime, 'session_start', { reason: 'startup' }, { cwd: root, sessionManager: { getBranch: () => [] }, hasUI: false });

    const results = await emit(runtime, 'tool_call', {
      toolName: 'write',
      toolCallId: 'tool-3',
      input: { path: join(src, 'file.ts') },
    }, { cwd: root });

    expect(results[0]).toBeUndefined();
    expect(runtime.appended).toHaveLength(0);
  });
});
