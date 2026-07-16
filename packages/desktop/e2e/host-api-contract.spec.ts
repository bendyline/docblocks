import { test, expect } from './fixtures.js';

test('preload exposes the complete typed host and reaches representative IPC handlers', async ({
  launchApp,
  workspaceDir,
}) => {
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });

  const contract = await window.evaluate(async () => {
    const host = (globalThis as { docBlocksHost?: Record<string, unknown> }).docBlocksHost;
    if (!host) throw new Error('Desktop host is unavailable');
    const functionKeys = (value: unknown) => {
      if (!value || typeof value !== 'object') return [];
      return Object.entries(value)
        .filter((entry) => typeof entry[1] === 'function')
        .map((entry) => entry[0])
        .sort();
    };
    const typedHost = host as {
      env: { platform: string; appVersion: string; isDev: boolean };
      fs: {
        readFile(workspaceId: string, path: string): Promise<string | null>;
        writeFile(workspaceId: string, path: string, content: string): Promise<void>;
        delete(workspaceId: string, path: string): Promise<void>;
      };
      fsV2: {
        open(request: {
          instanceId: string;
          providerId: string;
          label: string;
        }): Promise<{ ok: boolean }>;
        readDirectory(
          instanceId: string,
          path: string,
        ): Promise<{ ok: boolean; value?: unknown[] }>;
        dispose(instanceId: string): Promise<{ ok: boolean }>;
      };
      workspaces: {
        getDefault(): Promise<{ id: string; rootPath: string }>;
      };
      shell: { openExternal(url: string): Promise<void> };
      external: { readText(resourceId: string): Promise<unknown> };
      git: { capabilities(): Promise<{ gitAvailable: boolean }> };
      ffmpeg: { available(): Promise<boolean>; version(): Promise<string | null> };
      updater: { getVersion(): Promise<string> };
    };

    const workspace = await typedHost.workspaces.getDefault();
    await typedHost.fs.writeFile(workspace.id, 'contract-fixture.md', '# IPC contract\n');
    const roundTrip = await typedHost.fs.readFile(workspace.id, 'contract-fixture.md');
    await typedHost.fs.delete(workspace.id, 'contract-fixture.md');
    const instanceId = `contract-${Date.now()}`;
    const opened = await typedHost.fsV2.open({
      instanceId,
      providerId: workspace.id,
      label: 'Contract workspace',
    });
    const root = opened.ok
      ? await typedHost.fsV2.readDirectory(instanceId, '')
      : { ok: false, value: undefined };
    const disposed = opened.ok ? await typedHost.fsV2.dispose(instanceId) : { ok: false };

    const rejected: string[] = [];
    for (const [label, operation] of [
      ['external', () => typedHost.external.readText('unknown-grant')],
      ['shell', () => typedHost.shell.openExternal('javascript:alert(1)')],
    ] as const) {
      try {
        await operation();
      } catch {
        rejected.push(label);
      }
    }

    return {
      topLevel: Object.keys(host).sort(),
      env: typedHost.env,
      methods: Object.fromEntries(
        [
          'fs',
          'fsV2',
          'external',
          'workspaces',
          'shell',
          'exports',
          'ffmpeg',
          'git',
          'updater',
          'lifecycle',
        ].map((key) => [key, functionKeys(host[key])]),
      ),
      workspace,
      roundTrip,
      opened,
      root,
      disposed,
      rejected,
      git: await typedHost.git.capabilities(),
      ffmpegAvailable: await typedHost.ffmpeg.available(),
      ffmpegVersion: await typedHost.ffmpeg.version(),
      updaterVersion: await typedHost.updater.getVersion(),
    };
  });

  expect(contract.topLevel).toEqual([
    'env',
    'exports',
    'external',
    'ffmpeg',
    'fs',
    'fsV2',
    'git',
    'lifecycle',
    'onMenuCommand',
    'onOpenRequest',
    'shell',
    'updater',
    'workspaces',
  ]);
  expect(contract.methods.fs).toEqual([
    'commitFile',
    'createDirectory',
    'delete',
    'exists',
    'readBinary',
    'readDirectory',
    'readFile',
    'rename',
    'stat',
    'watch',
    'writeBinary',
    'writeFile',
  ]);
  expect(contract.methods.fsV2).toEqual([
    'createDirectory',
    'dispose',
    'move',
    'onWatchMessage',
    'open',
    'readDirectory',
    'readFile',
    'remove',
    'snapshot',
    'stat',
    'watchSubscribe',
    'watchUnsubscribe',
    'writeFile',
  ]);
  expect(contract.methods.external).toEqual([
    'commitBinary',
    'commitText',
    'readBinary',
    'readText',
    'revoke',
    'writeBinary',
    'writeText',
  ]);
  expect(contract.methods.workspaces).toEqual([
    'getDefault',
    'list',
    'pickFolder',
    'register',
    'unregister',
  ]);
  expect(contract.methods.shell).toEqual(['openExternal', 'revealInFolder']);
  expect(contract.methods.exports).toEqual(['pickTarget', 'resolveTarget', 'save']);
  expect(contract.methods.ffmpeg).toEqual(['available', 'version']);
  expect(contract.methods.updater).toEqual([
    'checkForUpdates',
    'getVersion',
    'onStatus',
    'quitAndInstall',
  ]);
  expect(contract.methods.lifecycle).toEqual([
    'onCancelClose',
    'onPrepareClose',
    'requestWindowClose',
  ]);
  expect(contract.methods.git).toEqual([
    'capabilities',
    'checkoutBranch',
    'clone',
    'commit',
    'commitFiles',
    'createBranch',
    'createPullRequest',
    'detectRepo',
    'discard',
    'fetch',
    'init',
    'listBranches',
    'listRemotes',
    'log',
    'onStatusChanged',
    'pull',
    'push',
    'readFileAtRevision',
    'stage',
    'status',
    'unstage',
  ]);
  expect(contract.workspace.rootPath).toBe(workspaceDir);
  expect(contract.roundTrip).toBe('# IPC contract\n');
  expect(contract.opened.ok).toBe(true);
  expect(contract.root.ok).toBe(true);
  expect(contract.disposed.ok).toBe(true);
  expect(contract.rejected).toEqual(['external', 'shell']);
  expect(typeof contract.git.gitAvailable).toBe('boolean');
  expect(typeof contract.ffmpegAvailable).toBe('boolean');
  expect(
    contract.ffmpegVersion === null || contract.ffmpegVersion.startsWith('ffmpeg version'),
  ).toBe(true);
  expect(contract.updaterVersion).toMatch(/^\d+\.\d+\.\d+/u);
});
