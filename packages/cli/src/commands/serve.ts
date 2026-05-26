import { Command } from 'commander';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { renderMarkdownHtml } from '../render-html.js';

export interface ServeOptions {
  port: number;
  dir: string;
  theme?: string;
}

export interface PreviewServer {
  server: Server;
  root: string;
  url: string;
}

export async function startPreviewServer(opts: ServeOptions): Promise<PreviewServer> {
  const root = path.resolve(opts.dir);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Directory not found: ${root}`);
  }

  const server = createServer((req, res) => {
    handlePreviewRequest(req, res, root, opts.theme).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      sendText(res, 500, `Internal server error: ${message}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  return { server, root, url: `http://localhost:${port}/` };
}

export const serveCommand = new Command('serve')
  .description('Start a local dev server for previewing markdown files')
  .option('-p, --port <port>', 'port to listen on', '3000')
  .option('-d, --dir <dir>', 'directory to serve', '.')
  .option('-t, --theme <id>', 'Squisq theme ID to apply')
  .action(async (opts: { port: string; dir: string; theme?: string }) => {
    try {
      const server = await startPreviewServer({
        port: parsePort(opts.port),
        dir: opts.dir,
        theme: opts.theme,
      });
      console.error(`Serving ${server.root} at ${server.url}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exitCode = 1;
    }
  });

async function handlePreviewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  themeId: string | undefined,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  const target = await resolveServeTarget(root, req.url ?? '/');
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

  if (target.markdown) {
    const markdown = await readFile(target.filePath, 'utf-8');
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

  const body = await readFile(target.filePath);
  sendBody(res, 200, body, contentTypeFor(target.filePath), req.method === 'HEAD');
}

type ServeTarget =
  | { kind: 'file'; filePath: string; markdown: boolean }
  | { kind: 'missing' }
  | { kind: 'forbidden' }
  | { kind: 'bad-request' };

export async function resolveServeTarget(root: string, requestUrl: string): Promise<ServeTarget> {
  const decodedPath = decodeRequestPath(requestUrl);
  if (!decodedPath) return { kind: 'bad-request' };
  const requestedPath = decodedPath.replace(/^\/+/, '');
  const candidate = path.resolve(root, requestedPath);

  if (!isPathInside(root, candidate)) return { kind: 'forbidden' };

  const direct = await fileTarget(candidate);
  if (direct) return direct;

  const dirIndex = await directoryIndexTarget(candidate);
  if (dirIndex) return dirIndex;

  if (/\.html?$/i.test(candidate)) {
    const markdownTarget = await fileTarget(candidate.replace(/\.html?$/i, '.md'));
    if (markdownTarget) return markdownTarget;
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

async function fileTarget(filePath: string): Promise<ServeTarget | null> {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return null;
  return { kind: 'file', filePath, markdown: /\.(md|markdown)$/i.test(filePath) };
}

async function directoryIndexTarget(dirPath: string): Promise<ServeTarget | null> {
  const info = await stat(dirPath).catch(() => null);
  if (!info?.isDirectory()) return null;

  for (const fileName of ['index.html', 'index.htm', 'index.md', 'index.markdown']) {
    const target = await fileTarget(path.join(dirPath, fileName));
    if (target) return target;
  }

  return null;
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
  if (headOnly) {
    res.end();
    return;
  }
  res.end(body);
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
