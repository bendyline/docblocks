import { Command } from 'commander';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { renderMarkdownHtml } from '../render-html.js';
import { readContainedFile } from '../contained-file.js';

export interface ServeOptions {
  port: number;
  dir: string;
  theme?: string;
  host?: string;
  allowNetwork?: boolean;
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

export async function startPreviewServer(opts: ServeOptions): Promise<PreviewServer> {
  const requestedRoot = path.resolve(opts.dir);
  const root = await realpath(requestedRoot).catch(() => requestedRoot);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Directory not found: ${root}`);
  }

  const host = validateHost(opts.host ?? DEFAULT_HOST, opts.allowNetwork === true);
  const maxFileBytes = positiveLimit(opts.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'file size');
  const maxConcurrentReads = positiveLimit(
    opts.maxConcurrentReads,
    DEFAULT_MAX_CONCURRENT_READS,
    'concurrent request',
  );
  let activeRequests = 0;
  const server = createServer((req, res) => {
    if (activeRequests >= maxConcurrentReads) {
      sendText(res, 503, 'Server busy');
      return;
    }
    activeRequests += 1;
    handlePreviewRequest(req, res, root, opts.theme, maxFileBytes)
      .catch(() => sendText(res, 500, 'Internal server error'))
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
  .action(
    async (opts: {
      port: string;
      dir: string;
      theme?: string;
      host: string;
      allowNetwork?: boolean;
    }) => {
      try {
        const server = await startPreviewServer({
          port: parsePort(opts.port),
          dir: opts.dir,
          theme: opts.theme,
          host: opts.host,
          allowNetwork: opts.allowNetwork,
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

  const target = await resolveServeTarget(root, req.url ?? '/', maxFileBytes);
  if (target.kind === 'bad-request') {
    sendText(res, 400, 'Bad request');
    return;
  }
  if (target.kind === 'forbidden') {
    sendText(res, 403, 'Forbidden');
    return;
  }
  if (target.kind === 'missing') {
    sendText(res, 404, 'Not found');
    return;
  }
  if (target.kind === 'too-large') {
    sendText(res, 413, 'File too large');
    return;
  }

  if (target.markdown) {
    const markdown = (await readContainedFile(root, target.filePath, maxFileBytes)).toString(
      'utf8',
    );
    const html = await renderMarkdownHtml(markdown, {
      title: path.basename(target.filePath).replace(/\.(md|markdown)$/i, ''),
      sourcePath: target.filePath,
      assetRoot: root,
      themeId,
      mode: 'static',
    });
    sendBody(res, 200, html, 'text/html; charset=utf-8', req.method === 'HEAD');
    return;
  }

  const body = await readContainedFile(root, target.filePath, maxFileBytes);
  sendBody(res, 200, body, contentTypeFor(target.filePath), req.method === 'HEAD');
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
  const physicalRoot = await realpath(path.resolve(root)).catch(() => null);
  if (!physicalRoot) return { kind: 'missing' };
  const decodedPath = decodeRequestPath(requestUrl);
  if (!decodedPath) return { kind: 'bad-request' };
  const requestedPath = decodedPath.replace(/^\/+/, '');
  const candidate = path.resolve(physicalRoot, requestedPath);

  if (!isPathInside(physicalRoot, candidate)) return { kind: 'forbidden' };

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
  } catch {
    return { kind: 'missing' };
  }
  if (!isPathInside(root, physical)) return { kind: 'forbidden' };
  const info = await stat(physical).catch(() => null);
  if (!info) return { kind: 'missing' };
  if (info.isDirectory()) return { kind: 'directory', filePath: physical };
  if (!info.isFile()) return { kind: 'forbidden' };
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

function sendText(res: ServerResponse, status: number, message: string): void {
  sendBody(res, status, `${message}\n`, 'text/plain; charset=utf-8', false);
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
  const host = value.trim().toLowerCase();
  if (!host || host.length > 255 || /[\s/\\\0]/.test(host)) {
    throw new Error('Invalid host');
  }
  if (!allowNetwork && !isLoopbackHost(host)) {
    throw new Error('Non-loopback hosts require --allow-network');
  }
  return host;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) throw new Error(`Invalid ${label} limit`);
  return selected;
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
    default:
      return 'application/octet-stream';
  }
}

function isPathInside(rootAbs: string, candidateAbs: string): boolean {
  const rel = path.relative(path.resolve(rootAbs), path.resolve(candidateAbs));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
