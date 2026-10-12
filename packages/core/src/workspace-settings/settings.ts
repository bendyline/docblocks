/**
 * Workspace-scoped settings persisted in `<workspace root>/.docblocks/workspace.json`.
 *
 * The file travels with the folder (git, sync, zip download), so every
 * surface — the shell, the VS Code extension host, and the CLI — reads the
 * same exact-shape document through this module. It is a persisted wire
 * payload: it enters as `unknown`, only the exact v1 shape is accepted, and
 * a file written by a newer DocBlocks is reported as unsupported rather than
 * half-applied.
 */

import { parseWorkspacePath, type WorkspacePath } from '../filesystem/workspace-path.js';

export const WORKSPACE_SETTINGS_DIRECTORY = '.docblocks';
export const WORKSPACE_SETTINGS_PATH = '.docblocks/workspace.json';
export const WORKSPACE_SETTINGS_VERSION = 1;

export const DEFAULT_CATALOG_TITLE = 'Documents';
export const DEFAULT_CATALOG_HTML_PATH = 'index.html';
export const DEFAULT_CATALOG_JSON_PATH = 'catalog.json';

export const WORKSPACE_SETTINGS_LIMITS = {
  maxFileBytes: 64 * 1024,
  maxTitleCharacters: 256,
  maxPathCharacters: 1024,
  maxSchemaCharacters: 2048,
  maxExcludes: 64,
  minKeep: 1,
  maxKeep: 1000,
} as const;

/** Theme ids are data: unknown ids render as the standard theme. */
export const WORKSPACE_THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const CATALOG_SORT_ORDERS = ['title', 'path', 'date'] as const;
export type CatalogSortOrder = (typeof CATALOG_SORT_ORDERS)[number];

export const CATALOG_JSON_CONTENT_MODES = ['metadata', 'markdown'] as const;
export type CatalogJsonContent = (typeof CATALOG_JSON_CONTENT_MODES)[number];

export interface WorkspaceDocumentSettings {
  /** Theme for documents whose frontmatter names none. */
  readonly defaultTheme?: string;
}

export interface WorkspaceVersionHistorySettings {
  /** Absent inherits the app-wide preference. */
  readonly enabled?: boolean;
  /** Snapshots kept per document (keep-last-n prune policy). */
  readonly keep?: number;
}

export interface WorkspaceCatalogHtmlSettings {
  readonly enabled?: boolean;
  readonly path?: string;
  /** Overrides `documents.defaultTheme` for the catalog page only. */
  readonly theme?: string;
}

export interface WorkspaceCatalogJsonSettings {
  readonly enabled?: boolean;
  readonly path?: string;
  readonly content?: CatalogJsonContent;
}

export interface WorkspaceCatalogSettings {
  readonly title?: string;
  readonly sort?: CatalogSortOrder;
  /** Workspace-relative folder or file prefixes left out of the catalog. */
  readonly exclude?: readonly string[];
  readonly html?: WorkspaceCatalogHtmlSettings;
  readonly json?: WorkspaceCatalogJsonSettings;
}

export interface WorkspaceSettings {
  readonly $schema?: string;
  readonly version: typeof WORKSPACE_SETTINGS_VERSION;
  readonly documents?: WorkspaceDocumentSettings;
  readonly versionHistory?: WorkspaceVersionHistorySettings;
  readonly catalog?: WorkspaceCatalogSettings;
}

export const EMPTY_WORKSPACE_SETTINGS: WorkspaceSettings = Object.freeze({
  version: WORKSPACE_SETTINGS_VERSION,
});

export type WorkspaceSettingsParseResult =
  | { readonly status: 'ok'; readonly settings: WorkspaceSettings }
  | { readonly status: 'invalid' | 'unsupported-version'; readonly message: string };

class WorkspaceSettingsShapeError extends Error {}

function fail(message: string): never {
  throw new WorkspaceSettingsShapeError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  const unknownKey = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknownKey !== undefined) fail(`${label} has an unknown field "${unknownKey}".`);
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
  return value;
}

function optionalTheme(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !WORKSPACE_THEME_ID_PATTERN.test(value)) {
    fail(`${label} must be a theme id such as "warm-earth".`);
  }
  return value;
}

function optionalTitle(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > WORKSPACE_SETTINGS_LIMITS.maxTitleCharacters ||
    hasControlCharacter(value)
  ) {
    fail(
      `${label} must be non-empty text of at most ${WORKSPACE_SETTINGS_LIMITS.maxTitleCharacters} characters.`,
    );
  }
  return value;
}

function optionalEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${label} must be one of ${allowed.map((option) => `"${option}"`).join(', ')}.`);
  }
  return value as T;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function boundedPath(value: unknown, label: string): WorkspacePath {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > WORKSPACE_SETTINGS_LIMITS.maxPathCharacters
  ) {
    fail(`${label} must be a workspace-relative path.`);
  }
  let path: WorkspacePath;
  try {
    path = parseWorkspacePath(value);
  } catch {
    fail(`${label} must be a workspace-relative path without "." or ".." segments.`);
  }
  if (!path) fail(`${label} must not be the workspace root.`);
  return path;
}

export type CatalogOutputKind = 'html' | 'json';

const OUTPUT_EXTENSIONS: Record<CatalogOutputKind, readonly string[]> = {
  html: ['.html', '.htm'],
  json: ['.json'],
};

/**
 * Validate a configured catalog output path. Outputs may never land inside
 * hidden folders, outside-in companions, or the shared player runtime, and
 * must carry the extension of what they contain.
 */
export function validateCatalogOutputPath(value: unknown, kind: CatalogOutputKind): WorkspacePath {
  const label = `catalog.${kind}.path`;
  const path = boundedPath(value, label);
  const lower = path.toLowerCase();
  if (!OUTPUT_EXTENSIONS[kind].some((extension) => lower.endsWith(extension))) {
    fail(`${label} must end with ${OUTPUT_EXTENSIONS[kind].join(' or ')}.`);
  }
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment.startsWith('.')) fail(`${label} must not be inside a hidden folder.`);
  }
  for (const directory of segments.slice(0, -1)) {
    if (directory.toLowerCase().endsWith('_files')) {
      fail(`${label} must not be inside a document's _files folder.`);
    }
    if (directory === '_squisq') fail(`${label} must not be inside the _squisq folder.`);
    if (directory === 'node_modules') fail(`${label} must not be inside node_modules.`);
  }
  return path;
}

/** Try-form for UI validation messages. */
export function checkCatalogOutputPath(
  value: unknown,
  kind: CatalogOutputKind,
): { ok: true; path: WorkspacePath } | { ok: false; message: string } {
  try {
    return { ok: true, path: validateCatalogOutputPath(value, kind) };
  } catch (error) {
    return { ok: false, message: shapeMessage(error) };
  }
}

function parseExclude(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail('catalog.exclude must be a list of folder or file paths.');
  if (value.length > WORKSPACE_SETTINGS_LIMITS.maxExcludes) {
    fail(`catalog.exclude may list at most ${WORKSPACE_SETTINGS_LIMITS.maxExcludes} paths.`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  value.forEach((entry, index) => {
    const path = boundedPath(entry, `catalog.exclude[${index}]`);
    if (!seen.has(path)) {
      seen.add(path);
      result.push(path);
    }
  });
  return result;
}

function parseKeep(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < WORKSPACE_SETTINGS_LIMITS.minKeep ||
    value > WORKSPACE_SETTINGS_LIMITS.maxKeep
  ) {
    fail(
      `versionHistory.keep must be a whole number from ${WORKSPACE_SETTINGS_LIMITS.minKeep} to ${WORKSPACE_SETTINGS_LIMITS.maxKeep}.`,
    );
  }
  return value;
}

function compact<T extends object>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, field]) => field !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

/** Parse an already-decoded settings value with the exact v1 shape. */
export function parseWorkspaceSettings(value: unknown): WorkspaceSettings {
  const root = isRecord(value) ? value : fail('Workspace settings must be a JSON object.');
  const version = root.version;
  if (typeof version === 'number' && Number.isInteger(version) && version > 1) {
    throw new UnsupportedWorkspaceSettingsVersionError(version);
  }
  exactRecord(root, 'Workspace settings', [
    '$schema',
    'version',
    'documents',
    'versionHistory',
    'catalog',
  ]);
  if (version !== WORKSPACE_SETTINGS_VERSION) fail('Workspace settings must have "version": 1.');

  let $schema: string | undefined;
  if (root.$schema !== undefined) {
    if (
      typeof root.$schema !== 'string' ||
      root.$schema.length > WORKSPACE_SETTINGS_LIMITS.maxSchemaCharacters
    ) {
      fail('$schema must be a bounded string.');
    }
    $schema = root.$schema;
  }

  let documents: WorkspaceDocumentSettings | undefined;
  if (root.documents !== undefined) {
    const record = exactRecord(root.documents, 'documents', ['defaultTheme']);
    documents = compact({
      defaultTheme: optionalTheme(record.defaultTheme, 'documents.defaultTheme'),
    });
  }

  let versionHistory: WorkspaceVersionHistorySettings | undefined;
  if (root.versionHistory !== undefined) {
    const record = exactRecord(root.versionHistory, 'versionHistory', ['enabled', 'keep']);
    versionHistory = compact({
      enabled: optionalBoolean(record.enabled, 'versionHistory.enabled'),
      keep: parseKeep(record.keep),
    });
  }

  let catalog: WorkspaceCatalogSettings | undefined;
  if (root.catalog !== undefined) {
    const record = exactRecord(root.catalog, 'catalog', [
      'title',
      'sort',
      'exclude',
      'html',
      'json',
    ]);
    let html: WorkspaceCatalogHtmlSettings | undefined;
    if (record.html !== undefined) {
      const htmlRecord = exactRecord(record.html, 'catalog.html', ['enabled', 'path', 'theme']);
      html = compact({
        enabled: optionalBoolean(htmlRecord.enabled, 'catalog.html.enabled'),
        path:
          htmlRecord.path === undefined
            ? undefined
            : validateCatalogOutputPath(htmlRecord.path, 'html'),
        theme: optionalTheme(htmlRecord.theme, 'catalog.html.theme'),
      });
    }
    let json: WorkspaceCatalogJsonSettings | undefined;
    if (record.json !== undefined) {
      const jsonRecord = exactRecord(record.json, 'catalog.json', ['enabled', 'path', 'content']);
      json = compact({
        enabled: optionalBoolean(jsonRecord.enabled, 'catalog.json.enabled'),
        path:
          jsonRecord.path === undefined
            ? undefined
            : validateCatalogOutputPath(jsonRecord.path, 'json'),
        content: optionalEnum(
          jsonRecord.content,
          'catalog.json.content',
          CATALOG_JSON_CONTENT_MODES,
        ),
      });
    }
    catalog = compact({
      title: optionalTitle(record.title, 'catalog.title'),
      sort: optionalEnum(record.sort, 'catalog.sort', CATALOG_SORT_ORDERS),
      exclude: parseExclude(record.exclude),
      html,
      json,
    });
    const htmlPath = (html?.path ?? DEFAULT_CATALOG_HTML_PATH).toLowerCase();
    const jsonPath = (json?.path ?? DEFAULT_CATALOG_JSON_PATH).toLowerCase();
    if (htmlPath === jsonPath) fail('catalog.html.path and catalog.json.path must differ.');
  }

  return {
    ...($schema !== undefined ? { $schema } : {}),
    version: WORKSPACE_SETTINGS_VERSION,
    ...(documents ? { documents } : {}),
    ...(versionHistory ? { versionHistory } : {}),
    ...(catalog ? { catalog } : {}),
  };
}

export class UnsupportedWorkspaceSettingsVersionError extends Error {
  public constructor(public readonly version: number) {
    super(
      `These workspace settings were written by a newer version of DocBlocks (settings version ${version}). Update DocBlocks to use or change them.`,
    );
    this.name = 'UnsupportedWorkspaceSettingsVersionError';
  }
}

function shapeMessage(error: unknown): string {
  if (error instanceof WorkspaceSettingsShapeError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Workspace settings are invalid.';
}

/** Decode the settings file text. Never throws for malformed content. */
export function parseWorkspaceSettingsText(text: string): WorkspaceSettingsParseResult {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (new TextEncoder().encode(source).byteLength > WORKSPACE_SETTINGS_LIMITS.maxFileBytes) {
    return {
      status: 'invalid',
      message: `${WORKSPACE_SETTINGS_PATH} is larger than ${WORKSPACE_SETTINGS_LIMITS.maxFileBytes / 1024} KiB.`,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return {
      status: 'invalid',
      message: `${WORKSPACE_SETTINGS_PATH} is not valid JSON${
        error instanceof Error ? `: ${error.message}` : '.'
      }`,
    };
  }
  try {
    return { status: 'ok', settings: parseWorkspaceSettings(value) };
  } catch (error) {
    if (error instanceof UnsupportedWorkspaceSettingsVersionError) {
      return { status: 'unsupported-version', message: error.message };
    }
    return { status: 'invalid', message: shapeMessage(error) };
  }
}

/** Deterministic, git-friendly serialization: fixed key order, two-space indent, final newline. */
export function serializeWorkspaceSettings(settings: WorkspaceSettings): string {
  const normalized = parseWorkspaceSettings(settings);
  const ordered: Record<string, unknown> = {};
  if (normalized.$schema !== undefined) ordered.$schema = normalized.$schema;
  ordered.version = normalized.version;
  if (normalized.documents) {
    ordered.documents = pick(normalized.documents, ['defaultTheme']);
  }
  if (normalized.versionHistory) {
    ordered.versionHistory = pick(normalized.versionHistory, ['enabled', 'keep']);
  }
  if (normalized.catalog) {
    const catalog = normalized.catalog;
    ordered.catalog = {
      ...pick(catalog, ['title', 'sort', 'exclude']),
      ...(catalog.html ? { html: pick(catalog.html, ['enabled', 'path', 'theme']) } : {}),
      ...(catalog.json ? { json: pick(catalog.json, ['enabled', 'path', 'content']) } : {}),
    };
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function pick<T extends object>(value: T, keys: readonly (keyof T)[]): Partial<T> {
  const result: Partial<T> = {};
  for (const key of keys) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}

// ── Patches ────────────────────────────────────────────────────────────────

type FieldPatch<T> = { readonly [K in keyof T]?: T[K] | null };

/**
 * A field-level change set. `null` removes a field (falling back to the
 * inherited/default behavior); omitted fields are left untouched. Saving a
 * patch rather than a whole document lets a conflicting concurrent edit be
 * merged by re-applying the patch on top of the newer file.
 */
export interface WorkspaceSettingsPatch {
  readonly documents?: FieldPatch<WorkspaceDocumentSettings>;
  readonly versionHistory?: FieldPatch<WorkspaceVersionHistorySettings>;
  readonly catalog?: FieldPatch<Omit<WorkspaceCatalogSettings, 'html' | 'json'>> & {
    readonly html?: FieldPatch<WorkspaceCatalogHtmlSettings>;
    readonly json?: FieldPatch<WorkspaceCatalogJsonSettings>;
  };
}

function patchFields<T extends object>(
  base: T | undefined,
  patch: FieldPatch<T> | undefined,
): T | undefined {
  if (!patch) return base;
  const next: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return compact(next as T);
}

/** Apply a patch and re-validate the result. Throws a shape error on invalid output. */
export function applyWorkspaceSettingsPatch(
  base: WorkspaceSettings | null,
  patch: WorkspaceSettingsPatch,
): WorkspaceSettings {
  const current = base ?? EMPTY_WORKSPACE_SETTINGS;
  const catalogPatch = patch.catalog;
  let catalog = current.catalog;
  if (catalogPatch) {
    const { html: htmlPatch, json: jsonPatch, ...topPatch } = catalogPatch;
    const top = patchFields<WorkspaceCatalogSettings>(
      current.catalog ? pick(current.catalog, ['title', 'sort', 'exclude']) : undefined,
      topPatch,
    );
    catalog = compact({
      ...(top ?? {}),
      html: patchFields(current.catalog?.html, htmlPatch),
      json: patchFields(current.catalog?.json, jsonPatch),
    });
  }
  return parseWorkspaceSettings({
    ...(current.$schema !== undefined ? { $schema: current.$schema } : {}),
    version: WORKSPACE_SETTINGS_VERSION,
    ...optionalSection('documents', patchFields(current.documents, patch.documents)),
    ...optionalSection('versionHistory', patchFields(current.versionHistory, patch.versionHistory)),
    ...optionalSection('catalog', catalog),
  });
}

function optionalSection(key: string, value: object | undefined): Record<string, object> {
  return value ? { [key]: value } : {};
}

/** Field-level difference from `before` to `after`, suitable for {@link applyWorkspaceSettingsPatch}. */
export function diffWorkspaceSettings(
  before: WorkspaceSettings | null,
  after: WorkspaceSettings,
): WorkspaceSettingsPatch {
  const base = before ?? EMPTY_WORKSPACE_SETTINGS;
  const documents = diffFields(base.documents, after.documents, ['defaultTheme']);
  const versionHistory = diffFields(base.versionHistory, after.versionHistory, ['enabled', 'keep']);
  const top = diffFields<Omit<WorkspaceCatalogSettings, 'html' | 'json'>>(
    base.catalog,
    after.catalog,
    ['title', 'sort', 'exclude'],
  );
  const html = diffFields(base.catalog?.html, after.catalog?.html, ['enabled', 'path', 'theme']);
  const json = diffFields(base.catalog?.json, after.catalog?.json, ['enabled', 'path', 'content']);
  const catalog =
    top || html || json
      ? { ...(top ?? {}), ...(html ? { html } : {}), ...(json ? { json } : {}) }
      : undefined;
  return {
    ...(documents ? { documents } : {}),
    ...(versionHistory ? { versionHistory } : {}),
    ...(catalog ? { catalog } : {}),
  };
}

function diffFields<T extends object>(
  before: T | undefined,
  after: T | undefined,
  keys: readonly (keyof T)[],
): FieldPatch<T> | undefined {
  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    const previous = before?.[key];
    const next = after?.[key];
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    patch[key as string] = next === undefined ? null : next;
  }
  return Object.keys(patch).length > 0 ? (patch as FieldPatch<T>) : undefined;
}

export function isEmptyWorkspaceSettingsPatch(patch: WorkspaceSettingsPatch): boolean {
  return !patch.documents && !patch.versionHistory && !patch.catalog;
}

/** Exact-shape parser for patches received over a wire boundary (VS Code postMessage). */
export function parseWorkspaceSettingsPatch(value: unknown): WorkspaceSettingsPatch {
  const root = exactRecord(value, 'Workspace settings patch', [
    'documents',
    'versionHistory',
    'catalog',
  ]);
  const nullable = (field: unknown, parse: (input: unknown) => unknown): unknown =>
    field === null ? null : parse(field);
  const result: Record<string, unknown> = {};
  if (root.documents !== undefined) {
    const record = exactRecord(root.documents, 'documents', ['defaultTheme']);
    result.documents =
      compact({
        defaultTheme: nullable(record.defaultTheme, (input) =>
          optionalTheme(input, 'documents.defaultTheme'),
        ),
      }) ?? {};
  }
  if (root.versionHistory !== undefined) {
    const record = exactRecord(root.versionHistory, 'versionHistory', ['enabled', 'keep']);
    result.versionHistory =
      compact({
        enabled: nullable(record.enabled, (input) =>
          optionalBoolean(input, 'versionHistory.enabled'),
        ),
        keep: nullable(record.keep, parseKeep),
      }) ?? {};
  }
  if (root.catalog !== undefined) {
    const record = exactRecord(root.catalog, 'catalog', [
      'title',
      'sort',
      'exclude',
      'html',
      'json',
    ]);
    const catalog: Record<string, unknown> = {
      ...(compact({
        title: nullable(record.title, (input) => optionalTitle(input, 'catalog.title')),
        sort: nullable(record.sort, (input) =>
          optionalEnum(input, 'catalog.sort', CATALOG_SORT_ORDERS),
        ),
        exclude: nullable(record.exclude, parseExclude),
      }) ?? {}),
    };
    if (record.html !== undefined) {
      const html = exactRecord(record.html, 'catalog.html', ['enabled', 'path', 'theme']);
      catalog.html =
        compact({
          enabled: nullable(html.enabled, (input) =>
            optionalBoolean(input, 'catalog.html.enabled'),
          ),
          path: nullable(html.path, (input) => validateCatalogOutputPath(input, 'html')),
          theme: nullable(html.theme, (input) => optionalTheme(input, 'catalog.html.theme')),
        }) ?? {};
    }
    if (record.json !== undefined) {
      const json = exactRecord(record.json, 'catalog.json', ['enabled', 'path', 'content']);
      catalog.json =
        compact({
          enabled: nullable(json.enabled, (input) =>
            optionalBoolean(input, 'catalog.json.enabled'),
          ),
          path: nullable(json.path, (input) => validateCatalogOutputPath(input, 'json')),
          content: nullable(json.content, (input) =>
            optionalEnum(input, 'catalog.json.content', CATALOG_JSON_CONTENT_MODES),
          ),
        }) ?? {};
    }
    result.catalog = catalog;
  }
  return result as WorkspaceSettingsPatch;
}

/** Try-form of {@link applyWorkspaceSettingsPatch} for UI validation. */
export function tryApplyWorkspaceSettingsPatch(
  base: WorkspaceSettings | null,
  patch: WorkspaceSettingsPatch,
): { ok: true; settings: WorkspaceSettings } | { ok: false; message: string } {
  try {
    return { ok: true, settings: applyWorkspaceSettingsPatch(base, patch) };
  } catch (error) {
    return { ok: false, message: shapeMessage(error) };
  }
}

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * True when settings change nothing about how DocBlocks treats the folder: no
 * default theme, no version-history choice, and no catalog output turned on.
 * Fields that only configure a disabled output (a catalog title, path, order,
 * or page theme) are inert. Such settings are never worth creating a
 * `.docblocks/` folder for.
 */
export function isDefaultWorkspaceSettings(
  settings: WorkspaceSettings | null | undefined,
): boolean {
  return (
    settings?.documents?.defaultTheme === undefined &&
    settings?.versionHistory?.enabled === undefined &&
    settings?.versionHistory?.keep === undefined &&
    settings?.catalog?.html?.enabled !== true &&
    settings?.catalog?.json?.enabled !== true
  );
}

/** The workspace default theme, or undefined to use the built-in default. */
export function resolveWorkspaceDefaultThemeId(
  settings: WorkspaceSettings | null | undefined,
): string | undefined {
  return settings?.documents?.defaultTheme;
}

/**
 * The theme a renderer should be told about explicitly. Every Squisq
 * exporter lets an explicit theme beat the document's own frontmatter, so a
 * workspace default may only be passed when the document names no theme.
 */
export function resolveFallbackThemeId(
  frontmatterThemeId: string | undefined,
  settings: WorkspaceSettings | null | undefined,
): string | undefined {
  if (frontmatterThemeId) return undefined;
  return resolveWorkspaceDefaultThemeId(settings);
}

/** `true`/`false` when the workspace decides, `undefined` to inherit. */
export function resolveWorkspaceVersioningEnabled(
  settings: WorkspaceSettings | null | undefined,
): boolean | undefined {
  return settings?.versionHistory?.enabled;
}

export interface ResolvedCatalogOutputs {
  readonly title: string;
  readonly sort: CatalogSortOrder;
  readonly exclude: readonly string[];
  readonly html: { readonly path: WorkspacePath; readonly themeId: string | undefined } | null;
  readonly json: { readonly path: WorkspacePath; readonly content: CatalogJsonContent } | null;
}

/** Effective catalog configuration, or null when no output is enabled. */
export function resolveCatalogOutputs(
  settings: WorkspaceSettings | null | undefined,
): ResolvedCatalogOutputs | null {
  const catalog = settings?.catalog;
  const htmlEnabled = catalog?.html?.enabled === true;
  const jsonEnabled = catalog?.json?.enabled === true;
  if (!htmlEnabled && !jsonEnabled) return null;
  return {
    title: catalog?.title ?? DEFAULT_CATALOG_TITLE,
    sort: catalog?.sort ?? 'title',
    exclude: catalog?.exclude ?? [],
    html: htmlEnabled
      ? {
          path: validateCatalogOutputPath(catalog?.html?.path ?? DEFAULT_CATALOG_HTML_PATH, 'html'),
          themeId: catalog?.html?.theme ?? settings?.documents?.defaultTheme,
        }
      : null,
    json: jsonEnabled
      ? {
          path: validateCatalogOutputPath(catalog?.json?.path ?? DEFAULT_CATALOG_JSON_PATH, 'json'),
          content: catalog?.json?.content ?? 'metadata',
        }
      : null,
  };
}
