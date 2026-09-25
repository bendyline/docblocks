import { expect } from 'chai';
import path from 'node:path';

import {
  resolveGezelHostRuntime,
  type HostRuntimeEnvironment,
} from '../main/ai/gezel-host-runtime.js';

const RESOURCES = path.resolve('/opt/DocBlocks/resources');
const HOME = path.resolve('/home/writer');
const SERVICE_CHECKOUT = path.resolve('/src/gezel/packages/service');
const SERVICE_ENTRY = path.join(SERVICE_CHECKOUT, 'dist', 'bin', 'gezeld.js');

function environment(
  overrides: Partial<HostRuntimeEnvironment> & { files?: readonly string[] } = {},
): HostRuntimeEnvironment {
  const files = new Set(overrides.files ?? []);
  return {
    isPackaged: false,
    resourcesPath: RESOURCES,
    env: {},
    platform: 'linux',
    homedir: HOME,
    exists: (candidate) => files.has(candidate),
    readText: async (file) => {
      if (file.endsWith('package.json')) return JSON.stringify({ version: '1.1.2' });
      throw new Error(`no ${file}`);
    },
    ...overrides,
  };
}

describe('Gezel host runtime', () => {
  it('uses the runtime a packaged build ships', async () => {
    const root = path.join(RESOURCES, 'gezel-host');
    const nodePath = path.join(root, 'node', 'node');
    const daemonEntry = path.join(root, 'service', 'dist', 'bin', 'gezeld.js');
    const runtime = await resolveGezelHostRuntime(
      environment({ isPackaged: true, files: [nodePath, daemonEntry] }),
    );
    expect(runtime).to.deep.equal({ nodePath, daemonEntry, version: '1.1.2', source: 'bundled' });
  });

  it('hands the daemon the engines a packaged build ships beside it', async () => {
    const root = path.join(RESOURCES, 'gezel-host');
    const nodePath = path.join(root, 'node', 'node');
    const daemonEntry = path.join(root, 'service', 'dist', 'bin', 'gezeld.js');
    const nativeBinDir = path.join(root, 'native-bin');
    const runtime = await resolveGezelHostRuntime(
      environment({ isPackaged: true, files: [nodePath, daemonEntry, nativeBinDir] }),
    );
    expect(runtime?.nativeBinDir).to.equal(nativeBinDir);
  });

  it('uses development engines only from an absolute, existing directory', async () => {
    const managedNode = path.join(HOME, '.gezel', 'bin', 'node');
    const engines = path.resolve('/src/gezel/packages/app/native-bin');
    const base = {
      DOCBLOCKS_GEZEL_SERVICE_ENTRY: SERVICE_ENTRY,
    };
    const files = [SERVICE_ENTRY, managedNode, engines];
    let runtime = await resolveGezelHostRuntime(
      environment({ env: { ...base, DOCBLOCKS_GEZEL_NATIVE_BIN_DIR: engines }, files }),
    );
    expect(runtime?.nativeBinDir).to.equal(engines);
    runtime = await resolveGezelHostRuntime(
      environment({ env: { ...base, DOCBLOCKS_GEZEL_NATIVE_BIN_DIR: 'native-bin' }, files }),
    );
    expect(runtime).to.not.have.property('nativeBinDir');
  });

  it('cannot host from a packaged build that ships no runtime', async () => {
    expect(await resolveGezelHostRuntime(environment({ isPackaged: true }))).to.equal(null);
  });

  it('never lets an environment variable choose what a packaged build runs', async () => {
    const runtime = await resolveGezelHostRuntime(
      environment({
        isPackaged: true,
        env: { DOCBLOCKS_GEZEL_SERVICE_ENTRY: SERVICE_ENTRY, PATH: '/usr/bin' },
        files: [SERVICE_ENTRY, path.join('/usr/bin', 'node')],
      }),
    );
    expect(runtime).to.equal(null);
  });

  it('develops against a service checkout and the Node a Gezel install keeps', async () => {
    const managedNode = path.join(HOME, '.gezel', 'bin', 'node');
    const runtime = await resolveGezelHostRuntime(
      environment({
        env: { DOCBLOCKS_GEZEL_SERVICE_ENTRY: SERVICE_ENTRY, PATH: '/usr/bin' },
        files: [SERVICE_ENTRY, managedNode, path.join('/usr/bin', 'node')],
      }),
    );
    expect(runtime).to.deep.equal({
      nodePath: managedNode,
      daemonEntry: SERVICE_ENTRY,
      version: '1.1.2',
      source: 'development',
    });
  });

  it('falls back to node on PATH, and honours an explicit development Node', async () => {
    const onPath = path.join('/usr/local/bin', 'node');
    let runtime = await resolveGezelHostRuntime(
      environment({
        env: { DOCBLOCKS_GEZEL_SERVICE_ENTRY: SERVICE_ENTRY, PATH: `/usr/bin:/usr/local/bin` },
        files: [SERVICE_ENTRY, onPath],
      }),
    );
    expect(runtime?.nodePath).to.equal(onPath);

    const explicit = path.resolve('/opt/node24/bin/node');
    runtime = await resolveGezelHostRuntime(
      environment({
        env: { DOCBLOCKS_GEZEL_SERVICE_ENTRY: SERVICE_ENTRY, DOCBLOCKS_GEZEL_NODE_PATH: explicit },
        files: [SERVICE_ENTRY, explicit],
      }),
    );
    expect(runtime?.nodePath).to.equal(explicit);
  });

  it('cannot host in development without a service entry or a Node', async () => {
    expect(await resolveGezelHostRuntime(environment({ env: { PATH: '/usr/bin' } }))).to.equal(
      null,
    );
    expect(
      await resolveGezelHostRuntime(
        environment({
          env: { DOCBLOCKS_GEZEL_SERVICE_ENTRY: SERVICE_ENTRY },
          files: [SERVICE_ENTRY],
        }),
      ),
    ).to.equal(null);
    expect(
      await resolveGezelHostRuntime(
        environment({ env: { DOCBLOCKS_GEZEL_SERVICE_ENTRY: 'relative/gezeld.js' } }),
      ),
    ).to.equal(null);
  });
});
