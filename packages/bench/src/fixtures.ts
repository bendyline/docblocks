import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERRIDE = process.env.DOCBENCH_FIXTURES_DIR?.trim();

/**
 * The pack's fixtures: beside `src/` and `dist/` alike, so the same lookup
 * works run from source (tsx) or from the build. `DOCBENCH_FIXTURES_DIR`
 * swaps in another set laid out the same way — a private holdout set, kept
 * out of this repository so product prompts cannot be tuned to it.
 */
export const FIXTURES_DIR = OVERRIDE
  ? path.resolve(OVERRIDE)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function fixturePath(...parts: string[]): string {
  return path.join(FIXTURES_DIR, ...parts);
}

export function readFixture(...parts: string[]): string {
  return fs.readFileSync(fixturePath(...parts), 'utf8');
}

export function readFixtureJson<T>(...parts: string[]): T {
  return JSON.parse(readFixture(...parts)) as T;
}

/** A case id from a fixture file name: `junior-developer.md` → `junior-developer`. */
export function caseId(fileName: string): string {
  return fileName.replace(/\.[^.]+$/u, '');
}

function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? filesUnder(path.join(dir, entry.name))
        : entry.isFile()
          ? [path.join(dir, entry.name)]
          : [],
    );
}

/**
 * Which fixtures a round ran on: `public` for the set in this package, else
 * the override folder's name, with a hash of every file's path and content
 * (line endings normalized, so a Windows checkout hashes as a Unix one).
 * Scores are comparable only between rounds with the same hash.
 */
export function fixtureSet(): { readonly id: string; readonly sha256: string } {
  const hash = createHash('sha256');
  for (const file of filesUnder(FIXTURES_DIR).sort()) {
    const relative = path.relative(FIXTURES_DIR, file).split(path.sep).join('/');
    hash.update(`${relative}\n`);
    hash.update(fs.readFileSync(file, 'utf8').replace(/\r\n/gu, '\n'));
    hash.update('\n');
  }
  return { id: OVERRIDE ? path.basename(FIXTURES_DIR) : 'public', sha256: hash.digest('hex') };
}
