import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'chai';
import {
  APP_ID,
  STORE_SECRETS,
  configureProject,
  decodeSecret,
  exportOptions,
  missingSecrets,
  parseKeychains,
  profileSettings,
} from '../scripts/store-signing.mjs';

// Store-signing failure cases run without keys or native SDKs. The store
// release workflow's native jobs provide the Gradle/Xcode integration coverage.
const certificate = Buffer.from('fixture certificate');
const fingerprint = createHash('sha1').update(certificate).digest('hex').toUpperCase();
const identities = `  1) ${fingerprint} "Apple Distribution: Bendyline, LLC (TEAM123456)"\n     1 valid identities found`;
const project = readFileSync(
  path.join(process.cwd(), 'packages/mobile/ios/App/App.xcodeproj/project.pbxproj'),
  'utf8',
);

function storeProfile(overrides: Record<string, unknown> = {}) {
  return {
    uuid: '01234567-89ab-cdef-0123-456789abcdef',
    expirationDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    teamIdentifier: ['TEAM123456'],
    applicationIdentifierPrefix: ['TEAM123456'],
    entitlements: {
      'application-identifier': `TEAM123456.${APP_ID}`,
      'com.apple.developer.team-identifier': 'TEAM123456',
      'get-task-allow': false,
    },
    provisionedDevices: undefined,
    provisionsAllDevices: false,
    developerCertificates: [certificate],
    ...overrides,
  };
}

describe('mobile store signing', () => {
  it('requires only the selected platform secrets, accepting a local keystore path', () => {
    for (const platform of ['android', 'ios'] as const) {
      const names = STORE_SECRETS[platform];
      const env: Record<string, string> = Object.fromEntries(names.map((name) => [name, 'set']));
      expect(missingSecrets(platform, env)).to.deep.equal([]);
      delete env[names[0]];
      expect(missingSecrets(platform, env)).to.deep.equal([names[0]]);
    }
    const local: Record<string, string> = {
      ANDROID_UPLOAD_KEYSTORE_PATH: 'upload.keystore',
      ANDROID_UPLOAD_KEYSTORE_PASSWORD: 'set',
      ANDROID_UPLOAD_KEY_ALIAS: 'set',
      ANDROID_UPLOAD_KEY_PASSWORD: 'set',
    };
    expect(missingSecrets('android', local)).to.deep.equal([]);
  });

  it('decodes base64 secrets into private files and rejects anything else', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'docblocks-store-test-'));
    try {
      const file = path.join(directory, 'secret');
      decodeSecret('SECRET', file, { SECRET: 'aGVs\nbG8=' });
      expect(readFileSync(file, 'utf8')).to.equal('hello');
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).to.equal(0o600);
      for (const value of [undefined, '', 'not base64!', 'aGVsbG8']) {
        expect(() => decodeSecret('SECRET', file, { SECRET: value })).to.throw(/SECRET/u);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps a valid App Store profile and its export manual', () => {
    const settings = profileSettings(storeProfile(), identities);
    expect(settings).to.deep.equal({
      team: 'TEAM123456',
      profile: '01234567-89ab-cdef-0123-456789abcdef',
      certificate: fingerprint,
    });
    const options = exportOptions(settings);
    expect(options.method).to.equal('app-store-connect');
    expect(options.destination).to.equal('export');
    expect(options.signingStyle).to.equal('manual');
    expect(options.manageAppVersionAndBuildNumber).to.equal(false);
    expect(options.provisioningProfiles).to.deep.equal({ [APP_ID]: settings.profile });
  });

  it('rejects development, ad hoc, enterprise, expired, and foreign profiles', () => {
    const entitlements = storeProfile().entitlements;
    for (const [overrides, reason] of [
      [{ provisionedDevices: ['00008110-000000000000001E'] }, /not a development/u],
      [{ provisionsAllDevices: true }, /not a development/u],
      [{ expirationDate: new Date('2020-01-01T00:00:00Z') }, /expired/u],
      [{ entitlements: { ...entitlements, 'get-task-allow': true } }, /Development profiles/u],
      [
        { entitlements: { ...entitlements, 'application-identifier': 'TEAM123456.com.other.app' } },
        /explicitly registered/u,
      ],
      [
        { entitlements: { ...entitlements, 'com.apple.developer.team-identifier': 'OTHER' } },
        /team is inconsistent/u,
      ],
      [{ uuid: 'not-a-uuid' }, /UUID/u],
    ] as const) {
      expect(() => profileSettings(storeProfile(overrides), identities)).to.throw(reason);
    }
  });

  it('requires exactly one Apple Distribution identity the profile authorizes', () => {
    for (const listed of [
      '',
      identities.replace('Apple Distribution', 'Apple Development'),
      identities.replace(fingerprint, 'F'.repeat(40)),
    ]) {
      expect(() => profileSettings(storeProfile(), listed)).to.throw(
        /one valid Apple Distribution/u,
      );
    }
    const second = Buffer.from('second certificate');
    const both = `${identities}\n  2) ${createHash('sha1').update(second).digest('hex').toUpperCase()} "Apple Distribution: Bendyline, LLC (TEAM123456)"`;
    expect(() =>
      profileSettings(storeProfile({ developerCertificates: [certificate, second] }), both),
    ).to.throw(/one valid Apple Distribution/u);
  });

  it('changes signing only in the App Release configuration and fails closed', () => {
    const settings = profileSettings(storeProfile(), identities);
    const signed = configureProject(project, settings);
    const [before] = project.split('504EC3181FED79650016851F /* Release */ = {');
    expect(signed.startsWith(before), 'everything before App Release is unchanged').to.equal(true);
    expect(signed.match(/CODE_SIGN_STYLE = "Manual";/gu)).to.have.length(1);
    expect(signed).to.include('CODE_SIGN_STYLE = Automatic;');
    expect(signed).to.include(`PROVISIONING_PROFILE_SPECIFIER = "${settings.profile}";`);
    expect(signed).to.include(`CODE_SIGN_IDENTITY = "${fingerprint}";`);
    expect(signed.split('/* End XCBuildConfiguration section */')[1]).to.equal(
      project.split('/* End XCBuildConfiguration section */')[1],
    );
    expect(() => configureProject(project.replaceAll(APP_ID, 'com.other.app'), settings)).to.throw(
      /exactly one DocBlocks App Release/u,
    );
  });

  it('restores the keychain search list it read', () => {
    expect(
      parseKeychains(
        '    "/Users/runner/Library/Keychains/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n',
      ),
    ).to.deep.equal([
      '/Users/runner/Library/Keychains/login.keychain-db',
      '/Library/Keychains/System.keychain',
    ]);
  });
});
