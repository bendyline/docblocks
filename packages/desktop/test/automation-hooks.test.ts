import { expect } from 'chai';
import path from 'node:path';
import {
  automationPrivilegesAllowed,
  automationRequested,
  hasAutomationStamp,
  readAppManifest,
} from '../main/automation-hooks.js';

describe('automation hooks', () => {
  it('treats only a non-empty DOCBLOCKS_E2E_DEFAULT_ROOT as an automated run', () => {
    expect(automationRequested({})).to.equal(false);
    expect(automationRequested({ DOCBLOCKS_E2E_DEFAULT_ROOT: '' })).to.equal(false);
    expect(automationRequested({ DOCBLOCKS_E2E_DEFAULT_ROOT: '/tmp/run' })).to.equal(true);
  });

  it('recognises the dist:dir stamp whether electron-builder writes a boolean or a string', () => {
    expect(hasAutomationStamp({ docblocksAutomationHooks: true })).to.equal(true);
    expect(hasAutomationStamp({ docblocksAutomationHooks: 'true' })).to.equal(true);
    expect(hasAutomationStamp({ docblocksAutomationHooks: false })).to.equal(false);
    expect(hasAutomationStamp({ docblocksAutomationHooks: 1 })).to.equal(false);
    expect(hasAutomationStamp({ name: 'docblocks-desktop' })).to.equal(false);
    expect(hasAutomationStamp(null)).to.equal(false);
  });

  it('never relaxes a prompt in a release package, even when the environment asks', () => {
    expect(
      automationPrivilegesAllowed({
        requested: true,
        isPackaged: true,
        manifest: { name: 'docblocks-desktop', version: '2.7.2' },
      }),
    ).to.equal(false);
  });

  it('relaxes prompts for automated runs of dist:dir packages and unpackaged builds', () => {
    expect(
      automationPrivilegesAllowed({
        requested: true,
        isPackaged: true,
        manifest: { docblocksAutomationHooks: true },
      }),
    ).to.equal(true);
    expect(
      automationPrivilegesAllowed({ requested: true, isPackaged: false, manifest: null }),
    ).to.equal(true);
  });

  it('keeps every prompt when no automated run was requested', () => {
    expect(
      automationPrivilegesAllowed({
        requested: false,
        isPackaged: true,
        manifest: { docblocksAutomationHooks: true },
      }),
    ).to.equal(false);
    expect(
      automationPrivilegesAllowed({ requested: false, isPackaged: false, manifest: null }),
    ).to.equal(false);
  });

  it('reads the app manifest and treats an unreadable one as unstamped', () => {
    const appPath = path.resolve('/app.asar');
    const files: Record<string, string> = {
      [path.join(appPath, 'package.json')]: '{"docblocksAutomationHooks":true}',
    };
    const read = (file: string): string => {
      const text = files[file];
      if (text === undefined) throw new Error(`ENOENT: ${file}`);
      return text;
    };
    expect(readAppManifest(appPath, read)).to.deep.equal({ docblocksAutomationHooks: true });
    expect(readAppManifest(path.resolve('/missing'), read)).to.equal(null);
    expect(readAppManifest(appPath, () => 'not json')).to.equal(null);
  });
});
