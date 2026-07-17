import { expect } from 'chai';
import { configureLinuxCredentialStorage } from '../main/linux-credential-storage.js';

class TestCommandLine {
  readonly switches = new Map<string, string>();

  hasSwitch(name: string): boolean {
    return this.switches.has(name);
  }

  appendSwitch(name: string, value = ''): void {
    this.switches.set(name, value);
  }
}

describe('Linux Chromium credential storage', () => {
  it('uses the non-keyring backend on Linux', () => {
    const commandLine = new TestCommandLine();

    configureLinuxCredentialStorage('linux', commandLine);

    expect(commandLine.switches.get('password-store')).to.equal('basic');
  });

  it('preserves an explicit password-store override on Linux', () => {
    const commandLine = new TestCommandLine();
    commandLine.appendSwitch('password-store', 'gnome-libsecret');

    configureLinuxCredentialStorage('linux', commandLine);

    expect(commandLine.switches.get('password-store')).to.equal('gnome-libsecret');
  });

  it('does not change Chromium storage on other platforms', () => {
    for (const platform of ['darwin', 'win32'] satisfies NodeJS.Platform[]) {
      const commandLine = new TestCommandLine();

      configureLinuxCredentialStorage(platform, commandLine);

      expect(commandLine.switches.size).to.equal(0);
    }
  });
});
