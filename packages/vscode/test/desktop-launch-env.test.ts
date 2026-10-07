import { expect } from 'chai';
import { stripInheritedEditorEnvironment } from '../desktop-e2e/launch-env.js';

describe('desktop extension-host launch environment', () => {
  it('drops the variable that turns VS Code into plain Node', () => {
    // Set by every VS Code extension host. Inherited, it makes the VS Code under
    // test run the workspace folder as a script and exit before any window opens.
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' };
    expect(stripInheritedEditorEnvironment(env)).to.deep.equal(['ELECTRON_RUN_AS_NODE']);
    expect(env).to.deep.equal({ PATH: '/usr/bin' });
  });

  it("drops the parent editor's sockets and caches", () => {
    const env: NodeJS.ProcessEnv = {
      VSCODE_IPC_HOOK: '/tmp/parent.sock',
      VSCODE_PID: '9092',
      VSCODE_NLS_CONFIG: '{}',
      HOME: '/Users/someone',
    };
    expect(stripInheritedEditorEnvironment(env)).to.deep.equal([
      'VSCODE_IPC_HOOK',
      'VSCODE_NLS_CONFIG',
      'VSCODE_PID',
    ]);
    expect(env).to.deep.equal({ HOME: '/Users/someone' });
  });

  it("keeps the runner's own version override", () => {
    const env: NodeJS.ProcessEnv = { VSCODE_DESKTOP_TEST_VERSION: '1.90.2' };
    expect(stripInheritedEditorEnvironment(env)).to.deep.equal([]);
    expect(env.VSCODE_DESKTOP_TEST_VERSION).to.equal('1.90.2');
  });

  it('changes nothing when started from a plain shell, as CI is', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', CI: 'true' };
    expect(stripInheritedEditorEnvironment(env)).to.deep.equal([]);
    expect(env).to.deep.equal({ PATH: '/usr/bin', CI: 'true' });
  });
});
