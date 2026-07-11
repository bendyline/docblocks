import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectGit, resetDetectionForTests } from '../../main/git/detect.js';

const CONFIG_ENVIRONMENT_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'] as const;

type ConfigEnvironmentKey = (typeof CONFIG_ENVIRONMENT_KEYS)[number];

export interface GitTestEnvironment {
  readonly bin: string;
  readonly configDirectory: string;
  readonly globalConfigPath: string;
  readonly systemConfigPath: string;
  dispose(): void;
}

/**
 * Detect Git with deterministic, platform-portable empty configuration files.
 *
 * Git for Windows rejects Node's `os.devNull` (`\\.\nul`) when it is supplied
 * through GIT_CONFIG_GLOBAL or GIT_CONFIG_SYSTEM. Real empty files isolate the
 * fixtures from user configuration without making a present Git look absent.
 */
export async function createGitTestEnvironment(): Promise<GitTestEnvironment | null> {
  const configDirectory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'docblocks-git-config-'),
  );
  const globalConfigPath = path.join(configDirectory, 'global.gitconfig');
  const systemConfigPath = path.join(configDirectory, 'system.gitconfig');
  fs.writeFileSync(globalConfigPath, '');
  fs.writeFileSync(systemConfigPath, '');

  const previousEnvironment: Record<ConfigEnvironmentKey, string | undefined> = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
  };

  process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
  process.env.GIT_CONFIG_SYSTEM = systemConfigPath;
  resetDetectionForTests();

  const detected = await detectGit();
  if (detected === null) {
    restoreEnvironment(previousEnvironment);
    fs.rmSync(configDirectory, { recursive: true, force: true });
    resetDetectionForTests();
    return null;
  }

  let disposed = false;
  return {
    bin: detected.path,
    configDirectory,
    globalConfigPath,
    systemConfigPath,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      restoreEnvironment(previousEnvironment);
      fs.rmSync(configDirectory, { recursive: true, force: true });
      resetDetectionForTests();
    },
  };
}

/** Run fixture setup through the same detected binary exercised by production. */
export function runFixtureGit(bin: string, cwd: string, ...args: string[]): void {
  execFileSync(bin, args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    },
    stdio: 'ignore',
  });
}

export function initializeFixtureRepository(bin: string, directory: string): void {
  runFixtureGit(bin, directory, 'init');
  runFixtureGit(bin, directory, 'config', 'user.email', 't@example.com');
  runFixtureGit(bin, directory, 'config', 'user.name', 'Test');
  runFixtureGit(bin, directory, 'config', 'commit.gpgsign', 'false');
}

function restoreEnvironment(
  previousEnvironment: Readonly<Record<ConfigEnvironmentKey, string | undefined>>,
): void {
  for (const key of CONFIG_ENVIRONMENT_KEYS) {
    const value = previousEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
