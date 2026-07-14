import { expect } from 'chai';
import {
  createCliInstallCommands,
  createVersionCheckInvocation,
  inspectMcpJson,
  inspectPackageJson,
  upsertDocBlocksMcpServer,
} from '../src/setupEnvironment.js';

describe('VS Code setup environment', () => {
  it('runs the Windows npm shim through the command processor', () => {
    expect(
      createVersionCheckInvocation('npm', 'win32', 'C:\\Windows\\System32\\cmd.exe'),
    ).to.deep.equal({
      executable: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd --version'],
    });
  });

  it('runs ordinary executables directly', () => {
    expect(createVersionCheckInvocation('node', 'win32')).to.deep.equal({
      executable: 'node',
      args: ['--version'],
    });
    expect(createVersionCheckInvocation('npm', 'linux')).to.deep.equal({
      executable: 'npm',
      args: ['--version'],
    });
  });

  it('finds DocBlocks CLI only in devDependencies', () => {
    expect(
      inspectPackageJson(
        JSON.stringify({ devDependencies: { '@bendyline/docblocks-cli': '^0.2.0' } }),
      ),
    ).to.deep.equal({ kind: 'valid', cliDevDependency: '^0.2.0' });
    expect(
      inspectPackageJson(
        JSON.stringify({ dependencies: { '@bendyline/docblocks-cli': '^0.2.0' } }),
      ),
    ).to.deep.equal({ kind: 'valid', cliDevDependency: null });
  });

  it('rejects malformed package manifests', () => {
    expect(inspectPackageJson('{')).to.deep.equal({
      kind: 'invalid',
      detail: 'package.json must contain valid JSON.',
    });
    expect(inspectPackageJson(JSON.stringify({ devDependencies: [] }))).to.deep.equal({
      kind: 'invalid',
      detail: 'package.json devDependencies must be an object.',
    });
  });

  it('initializes a package before installing the workspace dev dependency when needed', () => {
    expect(createCliInstallCommands(false)).to.deep.equal([
      'npm init --yes',
      'npm install --save-dev @bendyline/docblocks-cli',
    ]);
    expect(createCliInstallCommands(true)).to.deep.equal([
      'npm install --save-dev @bendyline/docblocks-cli',
    ]);
  });

  it('recognizes a workspace-local DocBlocks MCP server', () => {
    const configured = JSON.stringify({
      servers: {
        docblocks: {
          type: 'stdio',
          command: 'npm',
          args: ['exec', '--', 'docblocks', 'mcp'],
          cwd: '${workspaceFolder}',
        },
      },
    });
    expect(inspectMcpJson(configured)).to.deep.equal({
      kind: 'valid',
      configured: true,
      hasDocBlocksEntry: true,
    });

    expect(
      inspectMcpJson(
        JSON.stringify({
          servers: {
            docblocks: {
              command: 'npx',
              args: ['-y', '@bendyline/docblocks-cli', 'mcp'],
            },
          },
        }),
      ),
    ).to.deep.equal({ kind: 'valid', configured: false, hasDocBlocksEntry: true });
  });

  it('adds DocBlocks without discarding existing MCP servers or comments', () => {
    const existing = `{
  // Keep the team's existing server.
  "servers": {
    "example": { "command": "example-server" }
  }
}\n`;
    const updated = upsertDocBlocksMcpServer(existing);

    expect(updated).to.contain("// Keep the team's existing server.");
    expect(updated).to.contain('"example"');
    expect(inspectMcpJson(updated)).to.deep.equal({
      kind: 'valid',
      configured: true,
      hasDocBlocksEntry: true,
    });
  });

  it('creates a complete MCP config when the workspace has none', () => {
    const created = upsertDocBlocksMcpServer(null);
    expect(inspectMcpJson(created)).to.deep.equal({
      kind: 'valid',
      configured: true,
      hasDocBlocksEntry: true,
    });
  });

  it('keeps custom DocBlocks MCP options while switching to the workspace CLI', () => {
    const existing = `{
  "servers": {
    "docblocks": {
      // Keep explicit authority narrow.
      "command": "npx",
      "args": ["-y", "@bendyline/docblocks-cli", "mcp", "--allow-read", "./docs"],
      "env": { "DOCBLOCKS_MODE": "team" }
    }
  }
}\n`;
    const updated = upsertDocBlocksMcpServer(existing);

    expect(updated).to.contain('// Keep explicit authority narrow.');
    expect(updated).to.contain('"DOCBLOCKS_MODE": "team"');
    expect(updated).to.contain('"--allow-read"');
    expect(updated).to.contain('"./docs"');
    expect(inspectMcpJson(updated)).to.deep.equal({
      kind: 'valid',
      configured: true,
      hasDocBlocksEntry: true,
    });
  });
});
