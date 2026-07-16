import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { getAvailableThemes } from '@bendyline/squisq/schemas';
import { getTransformStyleIds } from '@bendyline/squisq/transform';

const execFileAsync = promisify(execFile);
const CLI_ENTRY = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

describe('CLI machine-readable output contracts', function () {
  this.timeout(20_000);

  it('writes unadorned linked theme and transform IDs to stdout', async () => {
    const themes = await runCli(['themes']);
    expect(readLines(themes.stdout)).to.deep.equal(getAvailableThemes());
    expect(themes.stderr).to.include('Available themes:');

    const transforms = await runCli(['transforms']);
    expect(readLines(transforms.stdout)).to.deep.equal(getTransformStyleIds());
    expect(transforms.stderr).to.include('Available transform styles:');
  });

  it('publishes the exact parse stats keys and Markdown AST for UTF-8 content', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'docblocks-parse-output-'));
    try {
      const input = path.join(root, 'document.txt');
      await writeFile(input, '# Heading\n\nParagraph.\n', 'utf8');
      const parsed = JSON.parse((await runCli(['parse', input])).stdout) as {
        stats: Record<string, unknown>;
        document: unknown;
      };

      expect(parsed.stats).to.deep.equal({
        headingCount: 1,
        paragraphCount: 1,
        blockCount: 2,
      });
      expect(parsed.document).to.be.an('object');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses two conflicting video output paths instead of silently dropping one', async () => {
    let failure: unknown;
    try {
      // `-o` used to win silently, writing a file the caller never named.
      await runCli(['video', 'unused.md', 'positional.mp4', '-o', 'option.mp4']);
    } catch (caught: unknown) {
      failure = caught;
    }

    expect(failure, 'an ambiguous destination must fail').to.be.instanceOf(Error);
    expect(readExitCode(failure)).to.equal(1);
    const stderr = readStderr(failure);
    expect(stderr).to.include('Two output paths were requested');
    expect(stderr).to.include('positional.mp4');
    expect(stderr).to.include('option.mp4');
  });

  it('rejects numeric prefixes instead of silently truncating video options', async () => {
    let failure: unknown;
    try {
      await runCli(['video', 'unused.md', '--fps', '30fps']);
    } catch (caught: unknown) {
      failure = caught;
    }

    expect(failure).to.be.instanceOf(Error);
    expect(readStderr(failure)).to.include('--fps must be a finite number');
  });
});

async function runCli(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

function readLines(value: string): string[] {
  return value.split(/\r?\n/u).filter(Boolean);
}

function readStderr(error: unknown): string {
  if (!error || typeof error !== 'object' || !('stderr' in error)) return '';
  return typeof error.stderr === 'string' ? error.stderr : '';
}

function readExitCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'number' ? error.code : null;
}
