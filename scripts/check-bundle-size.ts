import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

interface BundleSurface {
  name: string;
  htmlPath: string;
  assetsDir: string;
  entryBudgetBytes: number;
  editorBudgetBytes: number;
  monacoBudgetBytes: number;
}

const surfaces: BundleSurface[] = [
  {
    name: 'site',
    htmlPath: 'packages/site/dist/index.html',
    assetsDir: 'packages/site/dist/assets',
    // Retain the post-DocumentSession cap; the editor and provider families
    // are feature/backend chunks and are checked as deferred boundaries.
    entryBudgetBytes: 2_375_000,
    editorBudgetBytes: 1_100_000,
    monacoBudgetBytes: 4_000_000,
  },
  {
    name: 'desktop renderer',
    htmlPath: 'packages/desktop/dist/renderer/index.html',
    assetsDir: 'packages/desktop/dist/renderer/assets',
    entryBudgetBytes: 2_375_000,
    editorBudgetBytes: 1_100_000,
    monacoBudgetBytes: 4_000_000,
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

  for (const deferredName of [
    'LazyEditorShell-',
    'indexeddb-',
    'native-',
    'memory-',
    'electron-',
    'monaco-',
    'standalone-source',
  ]) {
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

  const editorAsset = await findAssetByPrefix(surface.assetsDir, 'LazyEditorShell-');
  if (!editorAsset) {
    throw new Error(`${surface.name}: missing deferred editor chunk`);
  }
  const editorSize = (await stat(path.join(surface.assetsDir, editorAsset))).size;
  if (editorSize > surface.editorBudgetBytes) {
    throw new Error(
      `${surface.name}: ${editorAsset} is ${formatBytes(editorSize)}, above ${formatBytes(
        surface.editorBudgetBytes,
      )}`,
    );
  }
  messages.push(`${surface.name}: deferred ${editorAsset} ${formatBytes(editorSize)}`);

  const monacoAsset = await findAssetByPrefix(surface.assetsDir, 'monaco-');
  if (!monacoAsset) {
    throw new Error(`${surface.name}: missing deferred monaco chunk`);
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
