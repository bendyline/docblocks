/**
 * The ordered release gate run by `npm run all`.
 *
 * Keep this as data so the runner can invoke the repository-pinned npm without
 * relying on the npm version that happened to launch the outer lifecycle.
 */
export const canonicalGateScripts = [
  'check:dependency-governance',
  'check:dependency-audit',
  'build',
  'bundle:size',
  'check:site-precache',
  'check:site-fonts',
  'check:desktop-config',
  'check:vscode-package',
  'check:notices',
  'check:assurance',
  'lint',
  'format:check',
  'typecheck',
  'check:packages',
  'coverage:critical',
  'test',
  'test:e2e:all',
] as const;

export function canonicalGateArguments(script: string): readonly string[] {
  return script === 'test' ? ['test'] : ['run', script];
}

export function canonicalGateCommand(script: string): string {
  return `npm ${canonicalGateArguments(script).join(' ')}`;
}
