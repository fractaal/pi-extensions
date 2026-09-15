export const CONTEXT_WINDOW_SCHEMA_VERSION = 1 as const;
export const CONTEXT_WINDOW_STATE_ENTRY = 'pi-context-window-state-v1';
export const CONTEXT_WINDOW_STATE_EVENT = 'pi-context-window:state';
export const CONTEXT_WINDOW_STATE_REQUEST_EVENT = 'pi-context-window:request-state';
export const CONTEXT_WINDOW_GLOBAL_DEFAULTS_FILE = 'context-window-defaults.json';
export const CONTEXT_WINDOW_SURFACE_KIND = 'pi-context-window';
export const CONTEXT_WINDOW_ACTION_ID = 'context-window';
export const CONTEXT_WINDOW_DEFAULT_ACTION_ID = 'context-window-default';
export const CONTEXT_WINDOW_MINIMUM_TOKENS = 16_000;

export interface ContextWindowModel {
  provider: string;
  modelId: string;
}

export interface ContextWindowState {
  schemaVersion: typeof CONTEXT_WINDOW_SCHEMA_VERSION;
  revision: number;
  model: ContextWindowModel;
  maxWindow: number;
  sessionOverride: number | null;
  globalDefault: number | null;
  effectiveWindow: number;
}

export interface ContextWindowDefaults {
  schemaVersion: typeof CONTEXT_WINDOW_SCHEMA_VERSION;
  defaults: Record<string, number>;
}

export type ContextWindowActionInput = {
  schemaVersion: typeof CONTEXT_WINDOW_SCHEMA_VERSION;
  scope: 'session' | 'global';
  value: number | 'default';
};

export function modelKey(model: ContextWindowModel): string {
  return `${model.provider}/${model.modelId}`;
}

export function effectiveContextWindow(
  maxWindow: number,
  sessionOverride: number | null,
  globalDefault: number | null,
): number {
  if (!Number.isSafeInteger(maxWindow) || maxWindow <= 0) throw new Error('Model context window must be a positive safe integer.');
  const requested = sessionOverride ?? globalDefault ?? maxWindow;
  if (!Number.isSafeInteger(requested) || requested <= 0) throw new Error('Context window override must be a positive safe integer.');
  return Math.min(maxWindow, requested);
}

export function isContextWindowModel(value: unknown): value is ContextWindowModel {
  return record(value) !== null
    && nonEmptyString(record(value)?.provider)
    && nonEmptyString(record(value)?.modelId);
}

export function isContextWindowState(value: unknown): value is ContextWindowState {
  const raw = record(value);
  if (!raw || raw.schemaVersion !== CONTEXT_WINDOW_SCHEMA_VERSION || !isNonnegativeSafeInteger(raw.revision)) return false;
  if (!isContextWindowModel(raw.model)) return false;
  if (!isPositiveSafeInteger(raw.maxWindow)) return false;
  if (!isNullablePositiveSafeInteger(raw.sessionOverride) || !isNullablePositiveSafeInteger(raw.globalDefault)) return false;
  if (!isPositiveSafeInteger(raw.effectiveWindow)) return false;
  return raw.effectiveWindow === effectiveContextWindow(raw.maxWindow, raw.sessionOverride, raw.globalDefault);
}

export function parseContextWindowState(value: unknown): ContextWindowState | null {
  return isContextWindowState(value) ? structuredClone(value) : null;
}

export function parseContextWindowActionInput(value: unknown): ContextWindowActionInput | null {
  const raw = record(value);
  if (!raw || raw.schemaVersion !== CONTEXT_WINDOW_SCHEMA_VERSION || (raw.scope !== 'session' && raw.scope !== 'global')) return null;
  if (raw.value === 'default') return { schemaVersion: CONTEXT_WINDOW_SCHEMA_VERSION, scope: raw.scope, value: 'default' };
  return isPositiveSafeInteger(raw.value)
    ? { schemaVersion: CONTEXT_WINDOW_SCHEMA_VERSION, scope: raw.scope, value: raw.value }
    : null;
}

export function parseContextWindowDefaults(value: unknown): ContextWindowDefaults | null {
  const raw = record(value);
  const rawDefaults = record(raw?.defaults);
  if (!raw || raw.schemaVersion !== CONTEXT_WINDOW_SCHEMA_VERSION || !rawDefaults) return null;
  const defaults: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawDefaults)) {
    if (!key || !isPositiveSafeInteger(value)) return null;
    defaults[key] = value;
  }
  return { schemaVersion: CONTEXT_WINDOW_SCHEMA_VERSION, defaults };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNullablePositiveSafeInteger(value: unknown): value is number | null {
  return value === null || isPositiveSafeInteger(value);
}
