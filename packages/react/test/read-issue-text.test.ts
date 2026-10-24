import { expect } from 'chai';
import type { FsErrorCode } from '@bendyline/docblocks/filesystem';
import { readIssueText } from '../src/FileExplorer/read-issue-text.js';
import type { FileTreeReadIssue } from '../src/FileExplorer/useFileTree.js';

function issue(
  code: FsErrorCode,
  message: string,
  directoryPath = '',
  path = directoryPath,
): FileTreeReadIssue {
  return { directoryPath, path, code, message, retryable: true };
}

describe('readIssueText', () => {
  it('never repeats a raw browser storage message', () => {
    const text = readIssueText(
      issue(
        'disposed',
        "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
      ),
    );
    expect(text).to.equal("Your documents couldn't be loaded.");
  });

  it('speaks about a nested folder rather than the whole workspace', () => {
    expect(readIssueText(issue('io', 'EIO: i/o error, scandir', 'docs'))).to.equal(
      "This folder couldn't be opened.",
    );
    expect(readIssueText(issue('not-found', 'Directory not found.', 'docs'))).to.equal(
      "This folder can't be found.",
    );
  });

  it('names the one entry that failed inside the listing', () => {
    expect(
      readIssueText(issue('io', 'UNKNOWN: unknown error, read', 'docs', 'docs/Plan.md')),
    ).to.equal("docs/Plan.md couldn't be read.");
    expect(
      readIssueText(issue('permission-denied', 'EACCES: permission denied', '', 'Plan.md')),
    ).to.equal("DocBlocks doesn't have permission to open Plan.md.");
  });

  it('explains conditions the user can act on', () => {
    expect(readIssueText(issue('quota-exceeded', 'QuotaExceededError'))).to.equal(
      'Your device is out of storage space.',
    );
    expect(readIssueText(issue('permission-denied', 'NotAllowedError'))).to.equal(
      "DocBlocks doesn't have permission to open this workspace.",
    );
  });
});
