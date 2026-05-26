import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

interface BundleSurface {
  name: string;
  htmlPath: string;
  assetsDir: string;
  entryBudgetBytes: number;
  monacoBudgetBytes: number;
}

const surfaces: BundleSurface[] = [
  {
    name: 'site',
    htmlPath: 'packages/site/dist/index.html',
    assetsDir: 'packages/site/dist/assets',
    entryBudgetBytes: 2_200_000,
    monacoBudgetBytes: 2_800_000,
  },
  {
    name: 'desktop renderer',
    htmlPath: 'packages/desktop/dist/renderer/index.html',
    assetsDir: 'packages/desktop/dist/renderer/assets',
    entryBudgetBytes: 2_200_000,
    monacoBudgetBytes: 2_800_000,
  },
];

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

function resolveEntryAsset(html: string): string {
  const match = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/);
  if (!match) {
    throw new Error('Could not find module entry script in index.html');
  }
  return path.basename(match[1]);
}

async function findAssetByPrefix(assetsDir: string, prefix: string): Promise<string | null> {
  const entries = await readdir(assetsDir);
  return entries.find((entry) => entry.startsWith(prefix) && entry.endsWith('.js')) ?? null;
}

async function assertSurface(surface: BundleSurface): Promise<string[]> {
  const html = await readFile(surface.htmlPath, 'utf8');
  const messages: string[] = [];

  for (const deferredName of ['monaco-slim', 'standalone-source']) {
    if (html.includes(deferredName)) {
      throw new Error(`${surface.name}: ${deferredName} is referenced from index.html`);
    }
  }

  const entryAsset = resolveEntryAsset(html);
  const entryPath = path.join(surface.assetsDir, entryAsset);
  const entrySize = (await stat(entryPath)).size;
  if (entrySize > surface.entryBudgetBytes) {
    throw new Error(
      `${surface.name}: entry ${entryAsset} is ${formatBytes(entrySize)}, above ${formatBytes(
        surface.entryBudgetBytes,
      )}`,
    );
  }
  messages.push(`${surface.name}: entry ${entryAsset} ${formatBytes(entrySize)}`);

  const monacoAsset = await findAssetByPrefix(surface.assetsDir, 'monaco-slim-');
  if (!monacoAsset) {
    throw new Error(`${surface.name}: missing deferred monaco-slim chunk`);
  }
  const monacoSize = (await stat(path.join(surface.assetsDir, monacoAsset))).size;
  if (monacoSize > surface.monacoBudgetBytes) {
    throw new Error(
      `${surface.name}: ${monacoAsset} is ${formatBytes(monacoSize)}, above ${formatBytes(
        surface.monacoBudgetBytes,
      )}`,
    );
  }
  messages.push(`${surface.name}: deferred ${monacoAsset} ${formatBytes(monacoSize)}`);

  return messages;
}

const results = await Promise.all(surfaces.map((surface) => assertSurface(surface)));

for (const line of results.flat()) {
  process.stdout.write(`${line}\n`);
}
