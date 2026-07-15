import { Command } from 'commander';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { renderMarkdownHtml } from '../render-html.js';
import { readContainedFile } from '../contained-file.js';
import { isAllowedPreviewPath } from '../preview-policy.js';
import { decodeUtf8Text } from '@bendyline/docblocks/filesystem';
import { positiveLimit } from '../internal/limits.js';
import { isNodeErrorCode } from '../internal/node-error.js';

export interface ServeOptions {
  port: number;
  dir: string;
  theme?: string;
  host?: string;
  allowNetwork?: boolean;
  /** Extra Host-header names this server answers to, beyond the bind policy. */
  allowedHosts?: readonly string[];
  maxFileBytes?: number;
  maxConcurrentReads?: number;
}

export interface PreviewServer {
  server: Server;
  root: string;
  host: string;
  url: string;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_READS = 16;
const MAX_ALLOWED_HOSTS = 32;
export async function startPreviewServer(opts: ServeOptions): Promise<PreviewServer> {
  const requestedRoot = path.resolve(opts.dir);
  let root: string;
  try {
    root = await realpath(requestedRoot);
  } catch (error: unknown) {
    if (!isMissingPathError(error)) throw error;
    throw new Error(`Directory not found: ${requestedRoot}`);
  }
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`Preview root is not a directory: ${root}`);

  const host = validateHost(opts.host ?? DEFAULT_HOST, opts.allowNetwork === true);
  const allowedHosts = validateAllowedHosts(opts.allowedHosts ?? []);
  const maxFileBytes = positiveLimit(
    opts.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
    'preview file size',
  );
  const maxConcurrentReads = positiveLimit(
    opts.maxConcurrentReads,
    DEFAULT_MAX_CONCURRENT_READS,
    'preview concurrent request',
  );
  let activeRequests = 0;
  const server = createServer((req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : opts.port;
    if (!isAllowedPreviewRequestAuthority(req.headers.host, host, port, allowedHosts)) {
      // A bare 421 is undiagnosable, and `localhost` vs `127.0.0.1` is the
      // most common way to hit this. Explain the policy in the body instead.
      // Rejections are deliberately not logged: on an --allow-network server
      // any unauthenticated client could otherwise flood the terminal.
      sendText(
        res,
        421,
        misdirectedRequestMessage(req.headers.host, host, port, allowedHosts),
        req.method === 'HEAD',
      );
      return;
    }
    if (activeRequests >= maxConcurrentReads) {
      sendText(res, 503, 'Server busy', req.method === 'HEAD');
      return;
    }
    activeRequests += 1;
    handlePreviewRequest(req, res, root, opts.theme, maxFileBytes)
      .catch((error: unknown) => {
        // A dev server exists to give feedback. Swallowing the cause left a
        // bad theme id, a parser crash, or an asset failure showing a bare
        // "Internal server error" in the browser and nothing in the terminal.
        reportPreviewFailure(req, error);
        if (!res.headersSent) sendText(res, 500, 'Internal server error', req.method === 'HEAD');
        else res.end();
      })
      .finally(() => {
        activeRequests -= 1;
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  return { server, root, host, url: `http://${urlHost(host)}:${port}/` };
}

export const serveCommand = new Command('serve')
  .description('Start a local dev server for previewing markdown files')
  .option('-p, --port <port>', 'port to listen on', '3000')
  .option('-d, --dir <dir>', 'directory to serve', '.')
  .option('-t, --theme <id>', 'Squisq theme ID to apply')
  .option('--host <host>', 'interface to bind (loopback by default)', DEFAULT_HOST)
  .option('--allow-network', 'allow a non-loopback --host')
  .option('--allow-host <host...>', 'additional Host header names this server answers to')
  .action(
    async (opts: {
      port: string;
      dir: string;
      theme?: string;
      host: string;
      allowNetwork?: boolean;
      allowHost?: string[];
    }) => {
      try {
        const server = await startPreviewServer({
          port: parsePort(opts.port),
          dir: opts.dir,
          theme: opts.theme,
          host: opts.host,
          allowNetwork: opts.allowNetwork,
          allowedHosts: opts.allowHost,
        });
        console.error(`Serving ${server.root} at ${server.url}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        process.exitCode = 1;
      }
    },
  );

async function handlePreviewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  themeId: string | undefined,
  maxFileBytes: number,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  const headOnly = req.method === 'HEAD';

  const target = await resolveServeTarget(root, req.url ?? '/', maxFileBytes);
  if (target.kind === 'bad-request') {
    sendText(res, 400, 'Bad request', headOnly);
    return;
  }
  if (target.kind === 'forbidden') {
    sendText(res, 403, 'Forbidden', headOnly);
    return;
  }
  if (target.kind === 'missing') {
    sendText(res, 404, 'Not found', headOnly);
    return;
  }
  if (target.kind === 'too-large') {
    sendText(res, 413, 'File too large', headOnly);
    return;
  }

  if (target.markdown) {
    const markdown = decodeUtf8Text(await readContainedFile(root, target.filePath, maxFileBytes), {
      label: 'Preview document',
      path: target.filePath,
    });
    const html = await renderMarkdownHtml(markdown, {
      title: path.basename(target.filePath).replace(/\.(md|markdown)$/i, ''),
      sourcePath: target.filePath,
      assetRoot: root,
      themeId,
      mode: 'static',
      allowReferencedAsset: ({ assetRoot, requestedPath, physicalPath }) =>
        isAllowedPreviewPath(assetRoot, requestedPath, physicalPath, 'embedded-image'),
    });
    sendBody(res, 200, html, 'text/html; charset=utf-8', headOnly);
    return;
  }

  const body = await readContainedFile(root, target.filePath, maxFileBytes);
  sendBody(res, 200, body, contentTypeFor(target.filePath), headOnly);
}

type ServeTarget =
  | { kind: 'file'; filePath: string; markdown: boolean }
  | { kind: 'missing' }
  | { kind: 'forbidden' }
  | { kind: 'too-large' }
  | { kind: 'bad-request' };

export async function resolveServeTarget(
  root: string,
  requestUrl: string,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
): Promise<ServeTarget> {
  if (requestUrl.length > 8_192 || requestUrl.includes('\0')) return { kind: 'bad-request' };
  let physicalRoot: string;
  try {
    physicalRoot = await realpath(path.resolve(root));
  } catch (error: unknown) {
    if (isMissingPathError(error)) return { kind: 'missing' };
    if (isPermissionError(error)) return { kind: 'forbidden' };
    throw error;
  }
  const decodedPath = decodeRequestPath(requestUrl);
  if (!decodedPath) return { kind: 'bad-request' };
  const requestedPath = decodedPath.replace(/^\/+/, '');
  const candidate = path.resolve(physicalRoot, requestedPath);

  if (!isAllowedPreviewPath(physicalRoot, candidate, candidate, 'directory')) {
    return { kind: 'forbidden' };
  }

  const direct = await inspectTarget(physicalRoot, candidate, maxFileBytes);
  if (direct.kind === 'file') return direct;
  if (direct.kind === 'forbidden' || direct.kind === 'too-large') return direct;

  if (direct.kind === 'directory') {
    const dirIndex = await directoryIndexTarget(physicalRoot, direct.filePath, maxFileBytes);
    if (dirIndex.kind !== 'missing') return dirIndex;
  }

  if (/\.html?$/i.test(candidate)) {
    const markdownTarget = await inspectTarget(
      physicalRoot,
      candidate.replace(/\.html?$/i, '.md'),
      maxFileBytes,
    );
    if (markdownTarget.kind !== 'directory' && markdownTarget.kind !== 'missing') {
      return markdownTarget;
    }
  }

  return { kind: 'missing' };
}

function decodeRequestPath(requestUrl: string): string {
  const pathOnly = requestUrl.split(/[?#]/, 1)[0] || '/';
  try {
    return decodeURIComponent(pathOnly);
  } catch {
    return '';
  }
}

type InspectedTarget =
  | { kind: 'file'; filePath: string; markdown: boolean }
  | { kind: 'directory'; filePath: string }
  | { kind: 'missing' }
  | { kind: 'forbidden' }
  | { kind: 'too-large' };

async function inspectTarget(
  root: string,
  candidate: string,
  maxFileBytes: number,
): Promise<InspectedTarget> {
  let physical: string;
  try {
    physical = await realpath(candidate);
  } catch (error: unknown) {
    if (isMissingPathError(error)) return { kind: 'missing' };
    if (isPermissionError(error)) return { kind: 'forbidden' };
    throw error;
  }
  let info;
  try {
    info = await stat(physical);
  } catch (error: unknown) {
    if (isMissingPathError(error)) return { kind: 'missing' };
    if (isPermissionError(error)) return { kind: 'forbidden' };
    throw error;
  }
  if (info.isDirectory()) {
    return isAllowedPreviewPath(root, candidate, physical, 'directory')
      ? { kind: 'directory', filePath: physical }
      : { kind: 'forbidden' };
  }
  if (!info.isFile()) return { kind: 'forbidden' };
  if (!isAllowedPreviewPath(root, candidate, physical, 'document-or-asset')) {
    return { kind: 'forbidden' };
  }
  if (info.size > maxFileBytes) return { kind: 'too-large' };
  return { kind: 'file', filePath: physical, markdown: /\.(md|markdown)$/i.test(physical) };
}

async function directoryIndexTarget(
  root: string,
  dirPath: string,
  maxFileBytes: number,
): Promise<ServeTarget> {
  for (const fileName of ['index.html', 'index.htm', 'index.md', 'index.markdown']) {
    const target = await inspectTarget(root, path.join(dirPath, fileName), maxFileBytes);
    if (target.kind === 'file' || target.kind === 'forbidden' || target.kind === 'too-large') {
      return target;
    }
  }

  return { kind: 'missing' };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function sendText(res: ServerResponse, status: number, message: string, headOnly = false): void {
  sendBody(res, status, `${message}\n`, 'text/plain; charset=utf-8', headOnly);
}

function sendBody(
  res: ServerResponse,
  status: number,
  body: string | Uint8Array,
  contentType: string,
  headOnly: boolean,
): void {
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
  if (headOnly) {
    res.end();
    return;
  }
  res.end(body);
}

function validateHost(value: string, allowNetwork: boolean): string {
  const rawHost = value.trim().toLowerCase();
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  if (
    !host ||
    host.length > 255 ||
    /[\s/\\\0]/.test(host) ||
    (isIP(host) === 0 && !isValidHostname(host))
  ) {
    throw new Error('Invalid host');
  }
  if (!allowNetwork && !isLoopbackHost(host)) {
    throw new Error('Non-loopback hosts require --allow-network');
  }
  return host;
}

function validateAllowedHosts(values: readonly string[]): readonly string[] {
  if (values.length > MAX_ALLOWED_HOSTS) {
    throw new Error(`At most ${MAX_ALLOWED_HOSTS} --allow-host values are supported`);
  }
  // Each value is an explicit grant, so it only has to be a well-formed
  // authority name; --allow-network governs the bind, not this allowlist.
  return Object.freeze(values.map((value) => validateHost(value, true)));
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

/**
 * Host-header policy — the server's DNS-rebinding defense.
 *
 * A rebinding attack needs a *name*: the attacker's page is served from
 * `evil.example`, whose DNS record is re-pointed at this server, so the browser
 * sends `Host: evil.example` while the page's origin stays `evil.example` and
 * can read our responses. Refusing to answer to a Host we were not reached by
 * breaks that, and every rule below preserves it:
 *
 * - **Loopback binds** accept any loopback alias (`localhost`, `127.0.0.0/8`,
 *   `::1`). These name only the local machine and cannot be pointed elsewhere
 *   by DNS, so treating them as interchangeable grants no attacker anything —
 *   it only stops rejecting the `localhost:3000` a user actually typed. A
 *   public name that merely resolves to 127.0.0.1 is still refused.
 * - **Wildcard binds** (`0.0.0.0`, `::`) cannot know their own hostnames, so
 *   they accept IP-literal Hosts of either family plus loopback aliases. An IP
 *   literal is not rebindable: reaching us with `Host: 192.168.1.5` requires an
 *   origin of `http://192.168.1.5:<port>`, which the same-origin policy already
 *   isolates from the attacker's page. Blanket-accepting any Host under
 *   `--allow-network` was rejected: it would surrender the defense entirely on
 *   exactly the servers that are reachable by other machines.
 * - **A specific non-loopback bind** answers only to that exact host.
 * - `--allow-host` adds names the operator states this server is reached by.
 *   The grant is explicit and per-name, so an arbitrary attacker name is still
 *   refused.
 */
export function isAllowedPreviewRequestAuthority(
  header: string | undefined,
  configuredHost: string,
  configuredPort: number,
  allowedHosts: readonly string[] = [],
): boolean {
  const authority = parseRequestAuthority(header);
  if (!authority || authority.port !== configuredPort) return false;
  if (allowedHosts.includes(authority.host)) return true;
  if (isWildcardHost(configuredHost)) {
    return isIP(authority.host) !== 0 || isLoopbackHost(authority.host);
  }
  if (isLoopbackHost(configuredHost)) return isLoopbackHost(authority.host);
  return authority.host === configuredHost;
}

function misdirectedRequestMessage(
  header: string | undefined,
  configuredHost: string,
  configuredPort: number,
  allowedHosts: readonly string[],
): string {
  // Only a parsed authority is echoed. parseRequestAuthority accepts nothing
  // but hostname/IP characters and a numeric port, so nothing attacker-shaped
  // reaches this text/plain, nosniff response.
  const authority = parseRequestAuthority(header);
  const received = authority ? `"${authority.host}:${authority.port}"` : 'malformed';
  const accepted = isWildcardHost(configuredHost)
    ? ['any IP-literal address of this machine', 'loopback: localhost, 127.0.0.0/8, ::1']
    : isLoopbackHost(configuredHost)
      ? ['loopback: localhost, 127.0.0.0/8, ::1']
      : [configuredHost];
  return [
    'Misdirected request',
    '',
    `This preview server is bound to ${configuredHost}:${configuredPort} and does not answer to the`,
    `Host header it received (${received}). The check blocks DNS-rebinding attacks and`,
    'cannot be disabled.',
    '',
    `Accepted Host names on port ${configuredPort}:`,
    ...[...accepted, ...allowedHosts.map((value) => `${value} (--allow-host)`)].map(
      (value) => `  - ${value}`,
    ),
    '',
    'Reach this server by one of those names, or restart it with',
    '--allow-host <name> to add the name you are using.',
  ].join('\n');
}

function reportPreviewFailure(req: IncomingMessage, error: unknown): void {
  const target = (req.url ?? '/').slice(0, 200);
  console.error(`Error: preview request failed: ${req.method ?? 'GET'} ${target}`);
  for (let cause: unknown = error, depth = 0; cause !== undefined && depth < 5; depth += 1) {
    console.error(`  ${describePreviewFailure(cause)}`);
    cause = cause instanceof Error ? (cause as Error & { cause?: unknown }).cause : undefined;
  }
}

function describePreviewFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.stack ?? `${error.name}: ${error.message}`;
}

function parseRequestAuthority(header: string | undefined): { host: string; port: number } | null {
  if (!header || header.length > 512 || /[\s,\\/\0]/.test(header)) return null;

  let host: string;
  let portText = '';
  let hasPortSeparator = false;
  if (header.startsWith('[')) {
    const closingBracket = header.indexOf(']');
    if (closingBracket < 0) return null;
    host = header.slice(1, closingBracket).toLowerCase();
    const remainder = header.slice(closingBracket + 1);
    if (remainder && !remainder.startsWith(':')) return null;
    hasPortSeparator = remainder.startsWith(':');
    portText = remainder.slice(1);
    if (isIP(host) !== 6) return null;
  } else {
    const separator = header.lastIndexOf(':');
    if (separator >= 0) {
      if (header.indexOf(':') !== separator) return null;
      hasPortSeparator = true;
      host = header.slice(0, separator).toLowerCase();
      portText = header.slice(separator + 1);
    } else {
      host = header.toLowerCase();
    }
    if (isIP(host) === 0 && !isValidHostname(host)) return null;
  }

  if (hasPortSeparator && !/^\d{1,5}$/.test(portText)) return null;
  const port = portText ? Number(portText) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function isValidHostname(host: string): boolean {
  return (
    host.length <= 253 &&
    !host.endsWith('.') &&
    host.split('.').every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))
  );
}

function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.ttf':
      return 'font/ttf';
    case '.otf':
      return 'font/otf';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.ogg':
      return 'audio/ogg';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    default:
      return 'application/octet-stream';
  }
}

function isMissingPathError(error: unknown): boolean {
  return isNodeErrorCode(error, ['ENOENT', 'ENOTDIR']);
}

function isPermissionError(error: unknown): boolean {
  return isNodeErrorCode(error, ['EACCES', 'EPERM']);
}
