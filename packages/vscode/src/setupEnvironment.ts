import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';

export const DOCBLOCKS_CLI_PACKAGE = '@bendyline/docblocks-cli';
export const DOCBLOCKS_MCP_SERVER_NAME = 'docblocks';

const DOCBLOCKS_MCP_LAUNCH_ARGS = ['exec', '--', 'docblocks', 'mcp'] as const;
const DOCBLOCKS_MCP_WORKSPACE_AUTHORITY_ARGS = [
  '--allow-read',
  '${workspaceFolder}',
  '--allow-write',
  '${workspaceFolder}',
] as const;

export const DOCBLOCKS_MCP_SERVER_CONFIG = {
  type: 'stdio',
  command: 'npm',
  args: [...DOCBLOCKS_MCP_LAUNCH_ARGS, ...DOCBLOCKS_MCP_WORKSPACE_AUTHORITY_ARGS],
  cwd: '${workspaceFolder}',
} as const;

export type SetupVersionCommand = 'node' | 'npm';

export interface CommandInvocation {
  executable: string;
  args: readonly string[];
}

export type PackageJsonInspection =
  | { kind: 'valid'; cliDevDependency: string | null }
  | { kind: 'invalid'; detail: string };

export type McpJsonInspection =
  | { kind: 'valid'; configured: boolean; hasDocBlocksEntry: boolean }
  | { kind: 'invalid'; detail: string };

const INSTALL_CLI_COMMAND = `npm install --save-dev ${DOCBLOCKS_CLI_PACKAGE}`;

/** Windows command shims such as npm.cmd must run through cmd.exe. */
export function createVersionCheckInvocation(
  command: SetupVersionCommand,
  platform: string,
  commandProcessor?: string,
): CommandInvocation {
  if (platform === 'win32' && command === 'npm') {
    return {
      executable: commandProcessor || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd --version'],
    };
  }

  return { executable: command, args: ['--version'] };
}

export function inspectPackageJson(text: string): PackageJsonInspection {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    return { kind: 'invalid', detail: 'package.json must contain valid JSON.' };
  }

  if (!isRecord(value)) {
    return { kind: 'invalid', detail: 'package.json must contain a JSON object.' };
  }

  const devDependencies = value.devDependencies;
  if (devDependencies === undefined) {
    return { kind: 'valid', cliDevDependency: null };
  }
  if (!isRecord(devDependencies)) {
    return { kind: 'invalid', detail: 'package.json devDependencies must be an object.' };
  }

  const cliVersion = devDependencies[DOCBLOCKS_CLI_PACKAGE];
  if (cliVersion === undefined) {
    return { kind: 'valid', cliDevDependency: null };
  }
  if (typeof cliVersion !== 'string' || cliVersion.trim().length === 0) {
    return {
      kind: 'invalid',
      detail: `${DOCBLOCKS_CLI_PACKAGE} must have a non-empty version in devDependencies.`,
    };
  }

  return { kind: 'valid', cliDevDependency: cliVersion.trim() };
}

export function createCliInstallCommands(packageJsonExists: boolean): readonly string[] {
  return packageJsonExists ? [INSTALL_CLI_COMMAND] : ['npm init --yes', INSTALL_CLI_COMMAND];
}

export function inspectMcpJson(text: string): McpJsonInspection {
  const errors: ParseError[] = [];
  const value = parse(text.replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;

  if (errors.length > 0 || !isRecord(value)) {
    return { kind: 'invalid', detail: '.vscode/mcp.json must contain a valid JSON object.' };
  }

  const servers = value.servers;
  if (servers === undefined) {
    return { kind: 'valid', configured: false, hasDocBlocksEntry: false };
  }
  if (!isRecord(servers)) {
    return { kind: 'invalid', detail: '.vscode/mcp.json servers must be an object.' };
  }

  const server = servers[DOCBLOCKS_MCP_SERVER_NAME];
  if (server === undefined) {
    return { kind: 'valid', configured: false, hasDocBlocksEntry: false };
  }

  return {
    kind: 'valid',
    configured: isLocalDocBlocksMcpServer(server),
    hasDocBlocksEntry: true,
  };
}

export function upsertDocBlocksMcpServer(text: string | null): string {
  if (text === null) {
    return `${JSON.stringify(
      { servers: { [DOCBLOCKS_MCP_SERVER_NAME]: DOCBLOCKS_MCP_SERVER_CONFIG } },
      null,
      2,
    )}\n`;
  }

  const inspection = inspectMcpJson(text);
  if (inspection.kind === 'invalid') throw new Error(inspection.detail);

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol };
  const root = parse(text, [], { allowTrailingComma: true, disallowComments: false }) as unknown;
  const existingServer =
    isRecord(root) && isRecord(root.servers) ? root.servers[DOCBLOCKS_MCP_SERVER_NAME] : undefined;

  let updated = text;
  if (isRecord(existingServer)) {
    const args = [
      ...DOCBLOCKS_MCP_SERVER_CONFIG.args,
      ...extractExistingDocBlocksMcpArgs(existingServer),
    ];
    const properties: ReadonlyArray<readonly [string, unknown]> = [
      ['type', DOCBLOCKS_MCP_SERVER_CONFIG.type],
      ['command', DOCBLOCKS_MCP_SERVER_CONFIG.command],
      ['args', args],
      ['cwd', DOCBLOCKS_MCP_SERVER_CONFIG.cwd],
    ];
    for (const [property, value] of properties) {
      updated = applyEdits(
        updated,
        modify(updated, ['servers', DOCBLOCKS_MCP_SERVER_NAME, property], value, {
          formattingOptions,
        }),
      );
    }
  } else {
    updated = applyEdits(
      updated,
      modify(updated, ['servers', DOCBLOCKS_MCP_SERVER_NAME], DOCBLOCKS_MCP_SERVER_CONFIG, {
        formattingOptions,
      }),
    );
  }

  return updated.endsWith('\n') ? updated : `${updated}${eol}`;
}

function extractExistingDocBlocksMcpArgs(server: Record<string, unknown>): string[] {
  const args = server.args;
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === 'string'))
    return [];

  let existingMcpArgs: string[] | null = null;

  if (server.command === 'docblocks' && args[0] === 'mcp') {
    existingMcpArgs = args.slice(1);
  }

  const packageIndex = args.indexOf(DOCBLOCKS_CLI_PACKAGE);
  if (packageIndex >= 0 && args[packageIndex + 1] === 'mcp') {
    existingMcpArgs = args.slice(packageIndex + 2);
  }

  if (
    server.command === 'npm' &&
    DOCBLOCKS_MCP_LAUNCH_ARGS.every((arg, index) => args[index] === arg)
  ) {
    existingMcpArgs = args.slice(DOCBLOCKS_MCP_LAUNCH_ARGS.length);
  }

  if (existingMcpArgs === null) return [];
  const customArgs = existingMcpArgs;
  if (DOCBLOCKS_MCP_WORKSPACE_AUTHORITY_ARGS.every((arg, index) => customArgs[index] === arg)) {
    return customArgs.slice(DOCBLOCKS_MCP_WORKSPACE_AUTHORITY_ARGS.length);
  }
  return customArgs;
}

function isLocalDocBlocksMcpServer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type !== undefined && value.type !== 'stdio') return false;
  if (value.command !== 'npm') return false;
  if (value.cwd !== undefined && value.cwd !== '${workspaceFolder}') return false;
  const args = value.args;
  if (!Array.isArray(args) || args.length < DOCBLOCKS_MCP_SERVER_CONFIG.args.length) {
    return false;
  }

  return DOCBLOCKS_MCP_SERVER_CONFIG.args.every((arg, index) => args[index] === arg);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
