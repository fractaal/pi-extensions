import { stat, readFile } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const DIRECTIVE_FILENAMES = ['CLAUDE.md', 'AGENTS.md', 'MEMORY.md'] as const;
export const DEFAULT_SKILL_SUBDIRS = ['.claude/skills', '.agents/skills', '.codex/skills'] as const;

const STATE_ENTRY_TYPE = 'pi-directive-roots-state';
const DEFAULT_LOCAL_GROUP = 'Local project directive context';
const DEFAULT_STATIC_GROUP = 'Firestore org/user directive context';

export type DirectiveFilename = (typeof DIRECTIVE_FILENAMES)[number];
export type DirectiveKind = 'claude' | 'agents' | 'memory';
export type DirectiveBoundary = string | 'filesystem' | 'git';

export interface DiscoveredDirectiveFile {
  path: string;
  dir: string;
  kind: DirectiveKind;
}

export interface DirectiveContextFile {
  scope: string;
  path: string;
  content: string;
  group?: string;
}

export interface BuildDirectiveContextBlockOptions {
  alreadyLoadedPaths?: ReadonlySet<string>;
}

export interface DiscoverDirectiveFilesOptions {
  targetPath: string;
  boundary?: string;
  maxAncestors?: number;
  fileExists?: (path: string) => Promise<boolean>;
}

export interface DirectiveRootsExtensionOptions {
  /** Extra non-filesystem directive files, for hosts like ALR that receive Firestore org/user directives. */
  directiveFiles?: DirectiveContextFile[];
  /** Filesystem boundary for ancestor walks. A path confines discovery to that tree; `git` stops at nearest .git; `filesystem` walks to root. */
  boundary?: DirectiveBoundary;
  /** Group label for local filesystem directive files. */
  localGroup?: string;
  /** Show a TUI/RPC notice when initial directive roots are found. Defaults false for quiet package behavior. */
  notifyOnSessionStart?: boolean;
  /** Tool names treated as read-like for post-result notices. */
  readToolNames?: string[];
  /** Tool names treated as write-like for preflight blocking. */
  writeToolNames?: string[];
}

type ToolResultContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export async function discoverDirectiveFiles(options: DiscoverDirectiveFilesOptions): Promise<DiscoveredDirectiveFile[]> {
  const targetPath = resolve(options.targetPath);
  const boundary = resolve(options.boundary ?? parse(targetPath).root);
  const maxAncestors = options.maxAncestors ?? 64;
  const exists = options.fileExists ?? defaultFileExists;
  const found: DiscoveredDirectiveFile[] = [];

  let cursor = await targetDirectory(targetPath);

  for (let index = 0; index < maxAncestors; index += 1) {
    if (!isWithin(cursor, boundary)) break;

    for (const filename of DIRECTIVE_FILENAMES) {
      const path = join(cursor, filename);
      if (await exists(path)) {
        found.push({ path, dir: cursor, kind: kindFromFilename(filename) });
      }
    }

    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return found;
}

export function skillPathsForDirectiveRoot(root: string): string[] {
  return DEFAULT_SKILL_SUBDIRS.map((subdir) => join(root, ...subdir.split('/')));
}

export function skillPathsForRoots(roots: ReadonlyArray<string>): string[] {
  return roots.flatMap(skillPathsForDirectiveRoot);
}

export function buildDirectiveContextBlock(files: ReadonlyArray<DirectiveContextFile>, options: BuildDirectiveContextBlockOptions = {}): string {
  const alreadyLoadedPaths = options.alreadyLoadedPaths ?? new Set<string>();
  const seen = new Set<string>();
  const groups = new Map<string, DirectiveContextFile[]>();

  for (const file of files) {
    if (!file.path || !file.content.trim()) continue;
    if (alreadyLoadedPaths.has(file.path)) continue;
    const group = file.group ?? DEFAULT_STATIC_GROUP;
    const key = `${group}\0${file.scope}\0${file.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.set(group, [...(groups.get(group) ?? []), file]);
  }

  if (groups.size === 0) return '';

  return Array.from(groups.entries())
    .map(([group, groupFiles]) => [
      `## ${group}`,
      '',
      ...groupFiles.map((file) => [
        `<directive-file scope="${xmlAttr(file.scope)}" path="${xmlAttr(file.path)}">`,
        file.content.trimEnd(),
        '</directive-file>',
      ].join('\n')),
    ].join('\n'))
    .join('\n\n');
}

export function createDirectiveRootsExtension(options: DirectiveRootsExtensionOptions = {}) {
  const staticDirectiveFiles = (options.directiveFiles ?? []).map((file) => ({
    ...file,
    group: file.group ?? DEFAULT_STATIC_GROUP,
  }));
  const localGroup = options.localGroup ?? DEFAULT_LOCAL_GROUP;
  const notifyOnSessionStart = options.notifyOnSessionStart ?? false;
  const readToolNames = new Set((options.readToolNames ?? ['read', 'grep', 'find', 'ls', 'Read', 'Grep', 'Find', 'Ls']).map((name) => name.toLowerCase()));
  const writeToolNames = new Set((options.writeToolNames ?? ['write', 'edit', 'Write', 'Edit']).map((name) => name.toLowerCase()));

  let knownLocalFiles = new Map<string, DiscoveredDirectiveFile>();
  let persistedDirectivePaths = new Set<string>();
  let lastSkillRoots: string[] = [];

  return function directiveRoots(pi: ExtensionAPI) {
    async function refreshForCwd(cwd: string, sessionManager?: unknown): Promise<void> {
      persistedDirectivePaths = restorePersistedDirectivePaths(sessionManager);
      knownLocalFiles = new Map<string, DiscoveredDirectiveFile>();

      const boundary = await resolveBoundary(cwd, options.boundary);
      const cwdFiles = await discoverDirectiveFiles({ targetPath: cwd, boundary });
      for (const file of cwdFiles) knownLocalFiles.set(file.path, file);
      for (const path of persistedDirectivePaths) {
        knownLocalFiles.set(path, { path, dir: dirname(path), kind: kindFromFilename(basename(path) as DirectiveFilename) });
      }
      lastSkillRoots = rootsForFiles([...knownLocalFiles.values()]);
    }

    async function discoverNewForTarget(targetPath: string, cwd: string): Promise<DiscoveredDirectiveFile[]> {
      const boundary = await resolveBoundary(cwd, options.boundary, targetPath);
      const candidates = await discoverDirectiveFiles({ targetPath, boundary });
      return candidates.filter((file) => !knownLocalFiles.has(file.path));
    }

    function persistNew(files: DiscoveredDirectiveFile[]): void {
      if (files.length === 0) return;
      for (const file of files) {
        knownLocalFiles.set(file.path, file);
        persistedDirectivePaths.add(file.path);
      }
      lastSkillRoots = rootsForFiles([...knownLocalFiles.values()]);
      pi.appendEntry(STATE_ENTRY_TYPE, { loadedDirectivePaths: [...persistedDirectivePaths] });
    }

    pi.on('session_start', async (_event, ctx) => {
      await refreshForCwd(ctx.cwd, ctx.sessionManager);
      if (notifyOnSessionStart && ctx.hasUI && (knownLocalFiles.size > 0 || staticDirectiveFiles.length > 0)) {
        ctx.ui.notify(`Directive roots loaded: ${knownLocalFiles.size + staticDirectiveFiles.length} directive file(s)`, 'info');
      }
    });

    pi.on('resources_discover', async (event, ctx) => {
      if (lastSkillRoots.length === 0) await refreshForCwd(event.cwd, ctx.sessionManager);
      return { skillPaths: skillPathsForRoots(lastSkillRoots) };
    });

    pi.on('before_agent_start', async (event, ctx) => {
      await refreshForCwd(ctx.cwd, ctx.sessionManager);
      const alreadyLoadedPaths = contextFilePathSet(event.systemPromptOptions?.contextFiles);
      const localFiles = await readLocalDirectiveContextFiles([...knownLocalFiles.values()], localGroup);
      const block = buildDirectiveContextBlock([
        ...staticDirectiveFiles,
        ...localFiles,
      ], { alreadyLoadedPaths });
      if (!block) return undefined;
      if (event.systemPrompt.includes(block)) return undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    });

    pi.on('tool_call', async (event, ctx) => {
      if (!writeToolNames.has(String(event.toolName).toLowerCase())) return undefined;
      const targetPath = extractToolPath(event.input);
      if (!targetPath) return undefined;
      const newFiles = await discoverNewForTarget(resolvePathForTool(ctx.cwd, targetPath), ctx.cwd);
      if (newFiles.length === 0) return undefined;
      persistNew(newFiles);
      return { block: true, reason: renderBlockNotice(event.toolName, targetPath, newFiles) };
    });

    pi.on('tool_result', async (event, ctx) => {
      if (!readToolNames.has(String(event.toolName).toLowerCase())) return undefined;
      if (event.isError) return undefined;
      const targetPath = extractToolPath(event.input);
      if (!targetPath) return undefined;
      const newFiles = await discoverNewForTarget(resolvePathForTool(ctx.cwd, targetPath), ctx.cwd);
      if (newFiles.length === 0) return undefined;
      persistNew(newFiles);
      return { content: appendNoticeToContent(event.content, renderAppendNotice(event.toolName, targetPath, newFiles)) };
    });
  };
}

export default createDirectiveRootsExtension();

function rootsForFiles(files: ReadonlyArray<DiscoveredDirectiveFile>): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.dir)) continue;
    seen.add(file.dir);
    roots.push(file.dir);
  }
  return roots;
}

async function readLocalDirectiveContextFiles(files: ReadonlyArray<DiscoveredDirectiveFile>, group: string): Promise<DirectiveContextFile[]> {
  const ordered = [...files].sort((left, right) => pathDepth(left.dir) - pathDepth(right.dir) || directiveRank(left.kind) - directiveRank(right.kind) || left.path.localeCompare(right.path));
  const result: DirectiveContextFile[] = [];
  for (const file of ordered) {
    try {
      const content = await readFile(file.path, 'utf8');
      result.push({ scope: 'project', path: file.path, content, group });
    } catch {
      // A persisted directive may have been deleted. Skip it rather than breaking the turn.
    }
  }
  return result;
}

function restorePersistedDirectivePaths(sessionManager: unknown): Set<string> {
  const paths = new Set<string>();
  const branch = sessionBranch(sessionManager);
  for (const entry of branch) {
    const record = asRecord(entry);
    if (record?.type !== 'custom' || record.customType !== STATE_ENTRY_TYPE) continue;
    const data = asRecord(record.data);
    const loaded = Array.isArray(data?.loadedDirectivePaths) ? data.loadedDirectivePaths : [];
    for (const value of loaded) if (typeof value === 'string' && value.length > 0) paths.add(resolve(value));
  }
  return paths;
}

function sessionBranch(sessionManager: unknown): unknown[] {
  const manager = asRecord(sessionManager);
  const getBranch = manager?.getBranch;
  if (typeof getBranch === 'function') {
    const branch = getBranch.call(sessionManager);
    return Array.isArray(branch) ? branch : [];
  }
  const getEntries = manager?.getEntries;
  if (typeof getEntries === 'function') {
    const entries = getEntries.call(sessionManager);
    return Array.isArray(entries) ? entries : [];
  }
  return [];
}

function contextFilePathSet(contextFiles: unknown): Set<string> {
  const paths = new Set<string>();
  if (!Array.isArray(contextFiles)) return paths;
  for (const file of contextFiles) {
    const record = asRecord(file);
    if (typeof record?.path === 'string') paths.add(record.path);
  }
  return paths;
}

function extractToolPath(input: unknown): string | null {
  const record = asRecord(input);
  if (!record) return null;
  for (const key of ['path', 'file_path', 'filePath']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function resolvePathForTool(cwd: string, path: string): string {
  return resolve(cwd, path.replace(/^@/, ''));
}

function renderBlockNotice(toolName: string, targetPath: string, files: ReadonlyArray<DiscoveredDirectiveFile>): string {
  return [
    '<system-notice>',
    `Before proceeding with ${toolName} at ${targetPath}, new directive files apply to this path:`,
    '',
    ...files.map((file) => `- ${file.path}`),
    '',
    `Read these files and follow their instructions before retrying ${toolName}. These are mid-turn system-prompt updates.`,
    '</system-notice>',
  ].join('\n');
}

function renderAppendNotice(toolName: string, targetPath: string, files: ReadonlyArray<DiscoveredDirectiveFile>): string {
  return [
    '',
    '',
    '<system-notice>',
    `${toolName} at ${targetPath} touched a directory with new directive files:`,
    '',
    ...files.map((file) => `- ${file.path}`),
    '',
    'Read these files next and follow their instructions. They are mid-turn system-prompt updates.',
    '</system-notice>',
  ].join('\n');
}

function appendNoticeToContent(content: unknown, notice: string): ToolResultContent[] {
  if (!Array.isArray(content) || content.length === 0) return [{ type: 'text', text: notice.trimStart() }];
  const next = [...content] as ToolResultContent[];
  const last = next[next.length - 1];
  if (last?.type === 'text') {
    next[next.length - 1] = { ...last, text: `${last.text}${notice}` };
    return next;
  }
  next.push({ type: 'text', text: notice.trimStart() });
  return next;
}

async function resolveBoundary(cwd: string, boundary: DirectiveBoundary | undefined, targetPath = cwd): Promise<string> {
  if (boundary && boundary !== 'filesystem' && boundary !== 'git') return resolve(boundary);
  if (boundary === 'git') return await findGitBoundary(cwd) ?? parse(resolve(targetPath)).root;
  return parse(resolve(targetPath)).root;
}

async function findGitBoundary(cwd: string): Promise<string | null> {
  let cursor = resolve(cwd);
  for (let index = 0; index < 64; index += 1) {
    if (await directoryEntryExists(join(cursor, '.git'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
  return null;
}

async function targetDirectory(path: string): Promise<string> {
  try {
    const targetStat = await stat(path);
    return targetStat.isDirectory() ? path : dirname(path);
  } catch {
    const lastSegment = basename(path);
    return lastSegment.includes('.') ? dirname(path) : path;
  }
}

async function directoryEntryExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    const fileStat = await stat(path);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

function kindFromFilename(filename: DirectiveFilename | string): DirectiveKind {
  if (filename === 'CLAUDE.md') return 'claude';
  if (filename === 'AGENTS.md') return 'agents';
  return 'memory';
}

function directiveRank(kind: DirectiveKind): number {
  if (kind === 'claude') return 0;
  if (kind === 'agents') return 1;
  return 2;
}

function pathDepth(path: string): number {
  return path.split(sep).filter(Boolean).length;
}

function isWithin(path: string, boundary: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedBoundary = resolve(boundary);
  if (normalizedPath === normalizedBoundary) return true;
  if (normalizedBoundary === parse(normalizedBoundary).root) return normalizedPath.startsWith(normalizedBoundary);
  return normalizedPath.startsWith(`${normalizedBoundary}${sep}`);
}

function xmlAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}
