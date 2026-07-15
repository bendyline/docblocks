import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

interface BundleSurface {
  name: string;
  htmlPath: string;
  entryDir: string;
  assetsDir: string;
  entryBudgetBytes: number;
  chunkBudgets: readonly BundleChunkBudget[];
  aggregateBudget?: {
    directory: string;
    extensions: readonly string[];
    budgetBytes: number;
  };
}

interface BundleChunkBudget {
  label: string;
  prefix: string;
  budgetBytes: number;
}

const surfaces: BundleSurface[] = [
  {
    name: 'site',
    htmlPath: 'packages/site/dist/index.html',
    entryDir: 'packages/site/dist/assets',
    assetsDir: 'packages/site/dist/assets',
    // Retain the post-DocumentSession cap; the editor and provider families
    // are feature/backend chunks and are checked as deferred boundaries.
    entryBudgetBytes: 2_375_000,
    chunkBudgets: [
      // Squisq 2.1 adds Mermaid rendering while keeping the Mermaid runtime
      // itself in deferred chunks.
      { label: 'deferred editor', prefix: 'LazyEditorShell-', budgetBytes: 1_225_000 },
      { label: 'deferred monaco', prefix: 'monaco-', budgetBytes: 4_000_000 },
    ],
  },
  {
    name: 'desktop renderer',
    htmlPath: 'packages/desktop/dist/renderer/index.html',
    entryDir: 'packages/desktop/dist/renderer/assets',
    assetsDir: 'packages/desktop/dist/renderer/assets',
    entryBudgetBytes: 2_375_000,
    chunkBudgets: [
      // Squisq 2.1 adds Mermaid rendering while keeping the Mermaid runtime
      // itself in deferred chunks.
      { label: 'deferred editor', prefix: 'LazyEditorShell-', budgetBytes: 1_225_000 },
      { label: 'deferred monaco', prefix: 'monaco-', budgetBytes: 4_000_000 },
    ],
  },
  {
    name: 'VS Code webview',
    htmlPath: 'packages/vscode/dist/webview/index.html',
    entryDir: 'packages/vscode/dist/webview',
    assetsDir: 'packages/vscode/dist/webview/assets',
    // The webview has no shell chrome, but it still defers Squisq until the
    // extension has supplied a document and the renderer bridges are ready.
    // Squisq 2.1's Mermaid-aware renderer adds a small amount of entry code;
    // the diagram implementations remain deferred.
    entryBudgetBytes: 1_425_000,
    chunkBudgets: [
      { label: 'deferred editor', prefix: 'LazyEditorShell-', budgetBytes: 1_250_000 },
      { label: 'deferred monaco', prefix: 'monaco-', budgetBytes: 4_000_000 },
      {
        label: 'deferred standalone editor source',
        prefix: 'standalone-source',
        // Includes the linked Squisq ZIP/OOXML cooperative-cancellation path
        // and the Squisq 2.1 standalone Mermaid renderer source.
        budgetBytes: 4_800_000,
      },
      { label: 'deferred TypeScript worker', prefix: 'ts.worker-', budgetBytes: 6_200_000 },
    ],
    // Catch growth spread over the many Monaco language chunks as well as a
    // regression in any one named boundary. Fonts are excluded because they
    // are separately versioned static assets rather than executable payload.
    aggregateBudget: {
      directory: 'packages/vscode/dist/webview',
      extensions: ['.js', '.css'],
      // Mermaid's diagram families are separate deferred chunks, but the
      // aggregate gate still accounts for their complete shipped footprint.
      budgetBytes: 25_000_000,
    },
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

async function sumFilesWithExtensions(
  directory: string,
  extensions: readonly string[],
): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return sumFilesWithExtensions(entryPath, extensions);
      }
      if (!entry.isFile() || !extensions.includes(path.extname(entry.name))) {
        return 0;
      }
      return (await stat(entryPath)).size;
    }),
  );
  return sizes.reduce((total, size) => total + size, 0);
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
  const entryPath = path.join(surface.entryDir, entryAsset);
  const entrySize = (await stat(entryPath)).size;
  if (entrySize > surface.entryBudgetBytes) {
    throw new Error(
      `${surface.name}: entry ${entryAsset} is ${formatBytes(entrySize)}, above ${formatBytes(
        surface.entryBudgetBytes,
      )}`,
    );
  }
  messages.push(`${surface.name}: entry ${entryAsset} ${formatBytes(entrySize)}`);

  for (const chunkBudget of surface.chunkBudgets) {
    const asset = await findAssetByPrefix(surface.assetsDir, chunkBudget.prefix);
    if (!asset) {
      throw new Error(`${surface.name}: missing ${chunkBudget.label} chunk`);
    }
    const size = (await stat(path.join(surface.assetsDir, asset))).size;
    if (size > chunkBudget.budgetBytes) {
      throw new Error(
        `${surface.name}: ${asset} is ${formatBytes(size)}, above ${formatBytes(
          chunkBudget.budgetBytes,
        )}`,
      );
    }
    messages.push(`${surface.name}: ${chunkBudget.label} ${asset} ${formatBytes(size)}`);
  }

  if (surface.aggregateBudget) {
    const aggregateSize = await sumFilesWithExtensions(
      surface.aggregateBudget.directory,
      surface.aggregateBudget.extensions,
    );
    if (aggregateSize > surface.aggregateBudget.budgetBytes) {
      throw new Error(
        `${surface.name}: aggregate ${surface.aggregateBudget.extensions.join('/')} output is ${formatBytes(
          aggregateSize,
        )}, above ${formatBytes(surface.aggregateBudget.budgetBytes)}`,
      );
    }
    messages.push(
      `${surface.name}: aggregate ${surface.aggregateBudget.extensions.join('/')} ${formatBytes(
        aggregateSize,
      )}`,
    );
  }

  return messages;
}

const results = await Promise.all(surfaces.map((surface) => assertSurface(surface)));

for (const line of results.flat()) {
  process.stdout.write(`${line}\n`);
}
