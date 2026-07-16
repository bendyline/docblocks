import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runParse } from '../src/commands/parse.js';

describe('CLI parse budgets', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'docblocks-parse-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('returns bounded AST JSON for a normal document', async () => {
    const input = path.join(directory, 'input.md');
    await writeFile(input, '# Heading\n\nParagraph', 'utf8');
    const parsed = JSON.parse(await runParse(input));
    expect(parsed.stats).to.include({ headingCount: 1, paragraphCount: 1 });
  });

  it('rejects oversized input before parsing', async () => {
    const input = path.join(directory, 'input.md');
    await writeFile(input, '# too large', 'utf8');
    let caught: unknown;
    try {
      await runParse(input, { maxInputBytes: 2 });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include('input exceeds');
  });

  it('rejects JSON that exceeds the output budget', async () => {
    const input = path.join(directory, 'input.md');
    await writeFile(input, '# Heading', 'utf8');
    let caught: unknown;
    try {
      await runParse(input, { maxOutputBytes: 2 });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include('output exceeds');
  });
});
