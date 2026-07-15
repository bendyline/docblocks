import { expect } from 'chai';
import { HOST_WIRE_LIMITS } from '@bendyline/docblocks/host';
import {
  parseExtensionToWebviewMessage,
  parseWebviewToExtensionMessage,
} from '@bendyline/docblocks/vscode';
import { ExportTargetGrantRegistry } from '../src/exportGrants.js';
import { selectRememberedExactExportTarget } from '../src/exportTargetPolicy.js';
import { parseDocumentResourcePath, parseMediaRef } from '../src/mediaPaths.js';
import { parseSetupWebviewMessage } from '../src/setupMessages.js';

describe('VS Code authority boundary', () => {
  it('uses one-shot panel/document scoped export grants', () => {
    let nextId = 0;
    const grants = new ExportTargetGrantRegistry<string>({
      createGrantId: () => `grant-${++nextId}`,
      now: () => 100,
    });
    const panelA = { panelId: 'panel-a', documentUri: 'file:///workspace/a.md' };
    const panelB = { panelId: 'panel-b', documentUri: 'file:///workspace/a.md' };
    const grant = grants.issue(panelA, 'file:///exports/a.pdf', 'a.pdf');

    expect(() => grants.peek(panelB, grant.grantId)).to.throw('invalid, expired, or already used');
    expect(grants.consume(panelA, grant.grantId)).to.equal('file:///exports/a.pdf');
    expect(() => grants.consume(panelA, grant.grantId)).to.throw(
      'invalid, expired, or already used',
    );
  });

  it('expires grants and revokes every grant for a closing panel', () => {
    let now = 0;
    let nextId = 0;
    const grants = new ExportTargetGrantRegistry<string>({
      createGrantId: () => `grant-${++nextId}`,
      now: () => now,
      ttlMs: 10,
    });
    const scope = { panelId: 'panel-a', documentUri: 'file:///workspace/a.md' };
    const expired = grants.issue(scope, 'first', 'first.pdf');
    now = 10;
    expect(() => grants.consume(scope, expired.grantId)).to.throw(
      'invalid, expired, or already used',
    );

    const closing = grants.issue(scope, 'second', 'second.pdf');
    grants.revokeScope(scope);
    expect(() => grants.consume(scope, closing.grantId)).to.throw(
      'invalid, expired, or already used',
    );
  });

  it('rejects raw export targets, unknown fields, and oversized envelopes', () => {
    expect(
      parseWebviewToExtensionMessage({
        type: 'saveExport',
        requestId: 1,
        filename: 'document.pdf',
        dataBase64: '',
        mimeType: 'application/pdf',
        targetPath: 'file:///forged.pdf',
      }),
    ).to.equal(null);
    expect(parseWebviewToExtensionMessage({ type: 'ready', extra: true })).to.equal(null);
    expect(
      parseWebviewToExtensionMessage({
        type: 'resolveMedia',
        requestId: 1,
        ref: 'x'.repeat(HOST_WIRE_LIMITS.pathCharacters + 1),
      }),
    ).to.equal(null);
    expect(
      parseWebviewToExtensionMessage({
        type: 'saveExport',
        requestId: 1,
        filename: '../escape.pdf',
        dataBase64: '',
        mimeType: 'application/pdf',
        grantId: null,
      }),
    ).to.equal(null);
  });

  it('accepts only an opaque grant ID for an export write', () => {
    expect(
      parseWebviewToExtensionMessage({
        type: 'saveExport',
        requestId: 1,
        filename: 'document.pdf',
        dataBase64: 'cGRm',
        mimeType: 'application/pdf',
        grantId: 'export_123',
      }),
    ).to.deep.equal({
      type: 'saveExport',
      requestId: 1,
      filename: 'document.pdf',
      dataBase64: 'cGRm',
      mimeType: 'application/pdf',
      grantId: 'export_123',
    });
  });

  it('validates editor settings in both protocol directions', () => {
    expect(parseWebviewToExtensionMessage({ type: 'setAutoSave', enabled: false })).to.deep.equal({
      type: 'setAutoSave',
      enabled: false,
    });
    expect(
      parseWebviewToExtensionMessage({ type: 'setAutoSave', enabled: false, extra: true }),
    ).to.equal(null);
    expect(
      parseWebviewToExtensionMessage({ type: 'setAccentColor', accentColor: 'green' }),
    ).to.deep.equal({ type: 'setAccentColor', accentColor: 'green' });
    expect(
      parseWebviewToExtensionMessage({ type: 'setAccentColor', accentColor: 'chartreuse' }),
    ).to.equal(null);
    expect(
      parseWebviewToExtensionMessage({
        type: 'setWriteCanvasSettings',
        settings: { textSize: 20, lineSpacing: 1.8 },
      }),
    ).to.deep.equal({
      type: 'setWriteCanvasSettings',
      settings: { textSize: 20, lineSpacing: 1.8 },
    });
    expect(
      parseWebviewToExtensionMessage({
        type: 'setWriteCanvasSettings',
        settings: { textSize: 100, lineSpacing: 1.8 },
      }),
    ).to.equal(null);

    expect(
      parseExtensionToWebviewMessage({
        type: 'editorSettings',
        settings: {
          autoSave: true,
          accentColor: 'purple',
          writeCanvasSettings: { textSize: 18, lineSpacing: 2 },
        },
      }),
    ).to.deep.equal({
      type: 'editorSettings',
      settings: {
        autoSave: true,
        accentColor: 'purple',
        writeCanvasSettings: { textSize: 18, lineSpacing: 2 },
      },
    });
    expect(
      parseExtensionToWebviewMessage({
        type: 'editorSettings',
        settings: {
          autoSave: 'yes',
          accentColor: 'purple',
          writeCanvasSettings: { textSize: 18, lineSpacing: 2 },
        },
      }),
    ).to.equal(null);
  });

  it('auto-resolves only an exact remembered target for an allowlisted export format', () => {
    const rememberedPdf = 'file:///exports/approved-report.pdf';
    const stored = {
      lastUri: 'file:///exports/previous.docx',
      byExtension: {
        pdf: rememberedPdf,
        json: 'file:///workspace/package.json',
      },
    };

    expect(selectRememberedExactExportTarget(stored, 'new-report.pdf')).to.equal(rememberedPdf);
    expect(selectRememberedExactExportTarget(stored, 'new-report.docx')).to.equal(null);
    expect(selectRememberedExactExportTarget(stored, '.env')).to.equal(null);
    expect(selectRememberedExactExportTarget(stored, 'package.json')).to.equal(null);
  });

  it('does not turn a remembered directory or mismatched persisted URI into export authority', () => {
    expect(
      selectRememberedExactExportTarget(
        { lastUri: 'file:///exports/previous.pdf' },
        'client-chosen.pdf',
      ),
    ).to.equal(null);
    expect(
      selectRememberedExactExportTarget(
        { byExtension: { pdf: 'file:///exports/.env' } },
        'client-chosen.pdf',
      ),
    ).to.equal(null);
  });

  it('validates host responses before the webview consumes them', () => {
    expect(
      parseExtensionToWebviewMessage({
        type: 'exportTargetResolved',
        requestId: 7,
        target: { grantId: 'export_123', displayLabel: 'document.pdf' },
      }),
    ).to.deep.equal({
      type: 'exportTargetResolved',
      requestId: 7,
      target: { grantId: 'export_123', displayLabel: 'document.pdf' },
    });
    expect(
      parseExtensionToWebviewMessage({
        type: 'exportTargetResolved',
        requestId: 7,
        target: {
          grantId: 'export_123',
          displayLabel: 'document.pdf',
          rawTarget: 'file:///forged.pdf',
        },
      }),
    ).to.equal(null);
    expect(
      parseExtensionToWebviewMessage({
        type: 'sessionState',
        sessionId: 'session-a',
        status: 'conflict',
        revision: 2,
        persistedRevision: 1,
        acknowledgedClientRevision: 1,
        documentVersion: 3,
        error: null,
        conflict: {
          localBaseDocumentVersion: 1,
          externalDocumentVersion: 3,
          localBytes: 12,
          externalBytes: 9,
          localEditedAt: 1_000,
          externalObservedAt: 2_000,
          externalIsDirty: true,
        },
      }),
    ).to.deep.equal({
      type: 'sessionState',
      sessionId: 'session-a',
      status: 'conflict',
      revision: 2,
      persistedRevision: 1,
      acknowledgedClientRevision: 1,
      documentVersion: 3,
      error: null,
      conflict: {
        localBaseDocumentVersion: 1,
        externalDocumentVersion: 3,
        localBytes: 12,
        externalBytes: 9,
        localEditedAt: 1_000,
        externalObservedAt: 2_000,
        externalIsDirty: true,
      },
    });
    expect(
      parseExtensionToWebviewMessage({
        type: 'sessionState',
        sessionId: 'session-a',
        status: 'saved',
        revision: 1,
        persistedRevision: 2,
        acknowledgedClientRevision: 1,
        documentVersion: 2,
        error: null,
        conflict: null,
      }),
    ).to.equal(null);
    expect(
      parseExtensionToWebviewMessage({
        type: 'workspaceFileError',
        requestId: 1,
        message: 'x'.repeat(HOST_WIRE_LIMITS.messageCharacters + 1),
      }),
    ).to.equal(null);
  });

  it('maps reads only to the exact document or its fixed sidecar', () => {
    expect(parseDocumentResourcePath('guide.md', 'guide.md')).to.deep.equal({
      kind: 'document',
    });
    expect(parseDocumentResourcePath('secret.txt', 'guide.md')).to.deep.equal({
      kind: 'media',
      key: 'guide_files/secret.txt',
    });
    expect(parseDocumentResourcePath('other/secret.txt', 'guide.md')).to.deep.equal({
      kind: 'media',
      key: 'guide_files/other/secret.txt',
    });
    expect(parseDocumentResourcePath('../secret.txt', 'guide.md')).to.equal(null);
    expect(parseDocumentResourcePath('other.md', 'guide.md')).to.equal(null);
  });

  it('rejects path aliases that can become traversal or alternate data streams', () => {
    expect(parseMediaRef('photo.jpg:secret', 'guide.md')).to.equal(null);
    expect(parseMediaRef('folder./photo.jpg', 'guide.md')).to.equal(null);
    expect(parseMediaRef(' folder/photo.jpg', 'guide.md')).to.equal(null);
    expect(parseMediaRef('photo%00.jpg', 'guide.md')).to.equal(null);
  });

  it('allows only fixed setup actions and rejects ambient URLs or shell text', () => {
    expect(parseSetupWebviewMessage({ type: 'openNodeDownload' })).to.deep.equal({
      type: 'openNodeDownload',
    });
    expect(parseSetupWebviewMessage({ type: 'openLink', url: 'javascript:alert(1)' })).to.equal(
      null,
    );
    expect(parseSetupWebviewMessage({ type: 'installCli', command: 'malicious command' })).to.equal(
      null,
    );
    expect(parseSetupWebviewMessage({ type: 'configureMcp' })).to.deep.equal({
      type: 'configureMcp',
    });
    expect(parseSetupWebviewMessage({ type: 'configureMcp', path: '../mcp.json' })).to.equal(null);
    expect(parseSetupWebviewMessage({ type: 'initProject' })).to.equal(null);
  });
});
