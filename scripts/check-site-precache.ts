import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_PRECACHE_EXTENSIONS, SITE_PRECACHE_MAX_BYTES } from './site-precache-policy.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'packages/site/dist');
const serviceWorkerPath = path.join(distRoot, 'sw.js');
const eligibleExtensions = new Set(SITE_PRECACHE_EXTENSIONS.map((extension) => `.${extension}`));

async function collectEligibleFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectEligibleFiles(entryPath)));
      continue;
    }
    if (!entry.isFile() || !eligibleExtensions.has(path.extname(entry.name).toLowerCase()))
      continue;
    const relative = path.relative(distRoot, entryPath).replace(/\\/gu, '/');
    if (relative === 'sw.js' || /^workbox-[^/]+\.js$/u.test(relative)) continue;
    const size = (await stat(entryPath)).size;
    if (size > SITE_PRECACHE_MAX_BYTES) {
      throw new Error(
        `${relative} is ${(size / 1024 / 1024).toFixed(2)} MiB and would silently fall outside the ` +
          `${SITE_PRECACHE_MAX_BYTES / 1024 / 1024} MiB PWA precache limit.`,
      );
    }
    files.push(relative);
  }
  return files;
}

const serviceWorker = await readFile(serviceWorkerPath, 'utf8');
const manifestUrls = new Set(
  [...serviceWorker.matchAll(/\burl:"([^"]+)"/gu)].map((match) => match[1]),
);
const eligibleFiles = await collectEligibleFiles(distRoot);
const missing = eligibleFiles.filter((file) => !manifestUrls.has(file));
if (missing.length > 0) {
  throw new Error(
    `PWA precache is missing ${missing.length} eligible file(s): ${missing.join(', ')}`,
  );
}

process.stdout.write(`PWA precache contains all ${eligibleFiles.length} eligible site files.\n`);
