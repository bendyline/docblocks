/**
 * Store submission policy for packaged DocBlocks desktop artifacts.
 *
 * The Mac App Store and Microsoft Store reject packages for properties that
 * electron-builder writes at package time — signing identities, entitlements,
 * the bundle version, the AppX identity — so a configuration check cannot prove
 * them. `check-store-packages.ts` reads the built bytes and applies these rules.
 */

export const MAS_BUNDLE_ID = 'com.bendyline.docblocks';

/**
 * Executables a MAS build ships besides Electron's own. UV is deliberately
 * absent: it only provisions Python for MLX, which store builds withhold.
 */
export const MAS_NATIVE_HELPERS: readonly string[] = ['gezel-apple-fm', 'gezel-llama-server'];

/** Every Microsoft Store submission carries one package per architecture. */
export const MSIX_ARCHITECTURES: readonly string[] = ['x64', 'arm64'];

/** Hardened-runtime exceptions; App Review rejects them in a sandboxed app. */
const HARDENED_RUNTIME_EXCEPTIONS: readonly string[] = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
];

type Dictionary = Record<string, unknown>;

function isRecord(value: unknown): value is Dictionary {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The team a Mac App Store distribution profile authorizes. Every other
 * identity in the package must agree with it, because App Store Connect
 * accepts the upload only under that team.
 */
export function masProfileViolations(
  profile: Dictionary,
  now: Date,
): { team: string | null; violations: string[] } {
  const violations: string[] = [];
  const teams = profile.TeamIdentifier;
  const team =
    Array.isArray(teams) &&
    teams.length === 1 &&
    typeof teams[0] === 'string' &&
    /^[A-Z0-9]{10}$/u.test(teams[0])
      ? teams[0]
      : null;
  if (team === null) violations.push('the profile must name exactly one team');
  if (Array.isArray(profile.Platform) && !profile.Platform.includes('OSX'))
    violations.push('the profile is not a macOS profile');
  if (profile.ProvisionedDevices !== undefined || profile.ProvisionsAllDevices === true)
    violations.push('the profile is for development or direct distribution, not the Mac App Store');
  const entitlements = isRecord(profile.Entitlements) ? profile.Entitlements : {};
  const appId = entitlements['com.apple.application-identifier'];
  if (team !== null && appId !== `${team}.${MAS_BUNDLE_ID}` && appId !== `${team}.*`)
    violations.push(`the profile does not authorize ${MAS_BUNDLE_ID}`);
  if (entitlements['get-task-allow'] === true)
    violations.push('the profile allows debugging (get-task-allow)');
  const expires =
    typeof profile.ExpirationDate === 'string' ? Date.parse(profile.ExpirationDate) : NaN;
  if (!(expires > now.getTime())) violations.push('the profile has expired');
  return { team, violations };
}

/** The main app's signed entitlements. */
export function masAppEntitlementViolations(entitlements: Dictionary, team: string): string[] {
  const violations: string[] = [];
  if (entitlements['com.apple.security.app-sandbox'] !== true)
    violations.push('the App Sandbox is not enabled');
  if (entitlements['get-task-allow'] === true)
    violations.push('the app is signed for debugging (get-task-allow)');
  if (entitlements['com.apple.application-identifier'] !== `${team}.${MAS_BUNDLE_ID}`)
    violations.push(`com.apple.application-identifier must be ${team}.${MAS_BUNDLE_ID}`);
  if (entitlements['com.apple.developer.team-identifier'] !== team)
    violations.push(`com.apple.developer.team-identifier must be ${team}`);
  for (const key of HARDENED_RUNTIME_EXCEPTIONS)
    if (key in entitlements) violations.push(`${key} is a hardened-runtime exception`);
  return violations;
}

/** Electron's helper apps must run inside the parent's sandbox. */
export function masChildEntitlementViolations(entitlements: Dictionary): string[] {
  const violations: string[] = [];
  for (const key of ['com.apple.security.app-sandbox', 'com.apple.security.inherit'])
    if (entitlements[key] !== true) violations.push(`${key} is not enabled`);
  return violations;
}

export function masInfoViolations(
  info: Dictionary,
  expected: { version: string; buildNumber: string },
): string[] {
  const violations: string[] = [];
  if (info.CFBundleIdentifier !== MAS_BUNDLE_ID)
    violations.push(`CFBundleIdentifier must be ${MAS_BUNDLE_ID}`);
  if (info.CFBundleShortVersionString !== expected.version)
    violations.push(`CFBundleShortVersionString must be ${expected.version}`);
  // electron-builder appends a BUILD_NUMBER environment variable to the version
  // (2.7.8.42), which App Store Connect rejects; the input must arrive verbatim.
  if (info.CFBundleVersion !== expected.buildNumber)
    violations.push(`CFBundleVersion must be the string ${expected.buildNumber}`);
  if (info.ITSAppUsesNonExemptEncryption !== false)
    violations.push('ITSAppUsesNonExemptEncryption must be false');
  if (typeof info.LSApplicationCategoryType !== 'string' || !info.LSApplicationCategoryType)
    violations.push('LSApplicationCategoryType is required');
  return violations;
}

export interface BundleEntry {
  readonly name: string;
  readonly type: 'file' | 'symlink' | 'directory' | 'other';
  readonly target?: string;
}

/** `Contents/Helpers` holds the Gezel engines and ggml plugin links, nothing else. */
export function masHelperViolations(entries: readonly BundleEntry[]): string[] {
  const violations: string[] = [];
  for (const entry of entries) {
    if (entry.type === 'file' && MAS_NATIVE_HELPERS.includes(entry.name)) continue;
    if (
      entry.type === 'symlink' &&
      /\.so$/u.test(entry.name) &&
      entry.target === `../Frameworks/${entry.name}`
    )
      continue;
    violations.push(
      entry.name === 'uv'
        ? 'UV must not ship: it installs Python packages at runtime'
        : `unexpected helper ${entry.name}`,
    );
  }
  for (const name of MAS_NATIVE_HELPERS)
    if (!entries.some((entry) => entry.type === 'file' && entry.name === name))
      violations.push(`missing helper ${name}`);
  return violations;
}

/** `pkgutil --check-signature` output for the submitted installer package. */
export function installerSignatureViolations(output: string, team: string): string[] {
  if (/Status: no signature/u.test(output) || !/Certificate Chain:/u.test(output))
    return ['the installer package is unsigned'];
  const leaf = /^\s*1\.\s+(.+?)\s*$/mu.exec(output)?.[1] ?? '';
  const pattern =
    /^(?:3rd Party Mac Developer Installer|Mac Installer Distribution): .+ \(([A-Z0-9]{10})\)$/u;
  const match = pattern.exec(leaf);
  if (!match)
    return [`the installer is signed by "${leaf}", not a Mac Installer Distribution identity`];
  if (match[1] !== team) return [`the installer is signed by team ${match[1]}, not ${team}`];
  return [];
}

export interface AppxExpectation {
  readonly name: string;
  readonly publisher: string;
  readonly displayName: string;
  readonly publisherDisplayName: string;
  readonly version: string;
  readonly architecture: string;
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/**
 * The package identity Partner Center matches against the app reservation.
 * The Store reserves the fourth version field, so it must be zero.
 */
export function appxManifestViolations(manifest: string, expected: AppxExpectation): string[] {
  const identity = /<Identity\b([^>]*)>/u.exec(manifest)?.[1];
  if (identity === undefined) return ['AppxManifest.xml has no Identity element'];
  const attributes = Object.fromEntries(
    [...identity.matchAll(/(\w+)="([^"]*)"/gu)].map(([, key, value]) => [key, decodeXml(value)]),
  );
  const properties = /<Properties>([\s\S]*?)<\/Properties>/u.exec(manifest)?.[1] ?? '';
  const element = (name: string) => {
    const value = new RegExp(`<${name}>([^<]*)</${name}>`, 'u').exec(properties)?.[1];
    return value === undefined ? undefined : decodeXml(value);
  };
  const violations: string[] = [];
  const checks: Array<[string, string | undefined, string]> = [
    ['Identity Name', attributes.Name, expected.name],
    ['Identity Publisher', attributes.Publisher, expected.publisher],
    ['ProcessorArchitecture', attributes.ProcessorArchitecture, expected.architecture],
    ['Identity Version', attributes.Version, `${expected.version}.0`],
    ['DisplayName', element('DisplayName'), expected.displayName],
    ['PublisherDisplayName', element('PublisherDisplayName'), expected.publisherDisplayName],
  ];
  for (const [label, actual, wanted] of checks)
    if (actual !== wanted)
      violations.push(`${label} is ${actual ?? 'missing'}, expected ${wanted}`);
  return violations;
}
