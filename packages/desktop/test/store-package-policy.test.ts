import { expect } from 'chai';
import {
  appxManifestViolations,
  installerSignatureViolations,
  masAppEntitlementViolations,
  masChildEntitlementViolations,
  masHelperViolations,
  masInfoViolations,
  masProfileViolations,
  msixPayloadViolations,
} from '../scripts/store-package-policy.js';

const TEAM = 'JXA5M4VK3V';
const NOW = new Date('2026-10-28T00:00:00Z');

const PROFILE = {
  TeamIdentifier: [TEAM],
  Platform: ['OSX'],
  Entitlements: {
    'com.apple.application-identifier': `${TEAM}.com.bendyline.docblocks`,
    'com.apple.developer.team-identifier': TEAM,
  },
  ExpirationDate: '2027-07-20T13:51:43Z',
};

const APP_ENTITLEMENTS = {
  'com.apple.security.app-sandbox': true,
  'com.apple.application-identifier': `${TEAM}.com.bendyline.docblocks`,
  'com.apple.developer.team-identifier': TEAM,
  'com.apple.security.network.client': true,
};

const INFO = {
  CFBundleIdentifier: 'com.bendyline.docblocks',
  CFBundleShortVersionString: '2.7.8',
  CFBundleVersion: '42',
  ITSAppUsesNonExemptEncryption: false,
  LSApplicationCategoryType: 'public.app-category.productivity',
};

/** The shape electron-builder's AppX target writes. */
function appxManifest(
  architecture: string,
  version = '2.7.8.0',
  minVersion = '10.0.17763.0',
  capabilities: readonly string[] = ['runFullTrust', 'microphone', 'webcam'],
): string {
  const declared = capabilities
    .map((name) =>
      name === 'runFullTrust'
        ? `  <rescap:Capability Name="${name}"/>`
        : `  <DeviceCapability Name="${name}"/>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <Identity Name="BendylineLLC.DocBlocks" ProcessorArchitecture="${architecture}" Publisher="CN=791A4319-B5A9-4402-928A-D644A8E3351D" Version="${version}" />
  <Properties>
    <DisplayName>DocBlocks</DisplayName>
    <PublisherDisplayName>Bendyline, LLC</PublisherDisplayName>
    <Logo>assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="${minVersion}" MaxVersionTested="${minVersion}" />
  </Dependencies>
  <Capabilities>
${declared}
</Capabilities>
  <Applications>
    <Application Id="DocBlocks" Executable="app\\DocBlocks.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Something else" />
    </Application>
  </Applications>
</Package>`;
}

const APPX = {
  name: 'BendylineLLC.DocBlocks',
  publisher: 'CN=791A4319-B5A9-4402-928A-D644A8E3351D',
  displayName: 'DocBlocks',
  publisherDisplayName: 'Bendyline, LLC',
  version: '2.7.8',
  architecture: 'arm64',
  minVersion: '10.0.17763.0',
};

function pkgutil(leaf: string): string {
  return `Package "DocBlocks-2.7.8-mac-arm64.pkg":
   Status: signed by a certificate trusted by macOS
   Certificate Chain:
    1. ${leaf}
       Expires: 2027-07-20 13:00:00 +0000
       ------------------------------------------------------------------------
    2. Apple Worldwide Developer Relations Certification Authority
       Expires: 2030-02-20 00:00:00 +0000
`;
}

describe('store package policy', () => {
  describe('Mac App Store provisioning profile', () => {
    it('returns the team of a current distribution profile for the app', () => {
      expect(masProfileViolations(PROFILE, NOW)).to.deep.equal({ team: TEAM, violations: [] });
    });

    it('rejects development, Developer ID, expired, foreign and debuggable profiles', () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ ...PROFILE, ProvisionedDevices: ['00008120-001145001A40C01E'] }, 'development'],
        [{ ...PROFILE, ProvisionsAllDevices: true }, 'direct distribution'],
        [{ ...PROFILE, ExpirationDate: '2026-01-01T00:00:00Z' }, 'expired'],
        [{ ...PROFILE, Platform: ['iOS'] }, 'not a macOS profile'],
        [
          {
            ...PROFILE,
            Entitlements: { 'com.apple.application-identifier': `${TEAM}.com.example.other` },
          },
          'does not authorize',
        ],
        [
          { ...PROFILE, Entitlements: { ...PROFILE.Entitlements, 'get-task-allow': true } },
          'debugging',
        ],
      ];
      for (const [profile, reason] of cases)
        expect(masProfileViolations(profile, NOW).violations.join('\n')).to.contain(reason);
      expect(masProfileViolations({ ...PROFILE, TeamIdentifier: [] }, NOW).team).to.equal(null);
    });
  });

  describe('Mac App Store app', () => {
    it('accepts a sandboxed app signed for the profile team', () => {
      expect(masAppEntitlementViolations(APP_ENTITLEMENTS, TEAM)).to.deep.equal([]);
    });

    it('rejects a missing sandbox, debugging, another team and hardened-runtime exceptions', () => {
      const violations = masAppEntitlementViolations(
        {
          'com.apple.application-identifier': `5B7Y53BF56.com.bendyline.docblocks`,
          'get-task-allow': true,
          'com.apple.security.cs.allow-jit': true,
        },
        TEAM,
      ).join('\n');
      for (const reason of [
        'App Sandbox',
        'get-task-allow',
        'application-identifier',
        'team-identifier',
        'allow-jit',
      ])
        expect(violations).to.contain(reason);
    });

    it('requires Electron helpers to inherit the sandbox', () => {
      const inherited = {
        'com.apple.security.app-sandbox': true,
        'com.apple.security.inherit': true,
      };
      expect(masChildEntitlementViolations(inherited)).to.deep.equal([]);
      expect(
        masChildEntitlementViolations({ 'com.apple.security.app-sandbox': true }),
      ).to.deep.equal(['com.apple.security.inherit is not enabled']);
    });

    it('requires the exact build number and the export-compliance declaration', () => {
      const expected = { version: '2.7.8', buildNumber: '42' };
      expect(masInfoViolations(INFO, expected)).to.deep.equal([]);
      // electron-builder appends a BUILD_NUMBER environment variable to the version.
      expect(masInfoViolations({ ...INFO, CFBundleVersion: '2.7.8.42' }, expected)).to.have.length(
        1,
      );
      expect(masInfoViolations({ ...INFO, CFBundleVersion: 42 }, expected)).to.have.length(1);
      const { ITSAppUsesNonExemptEncryption: _, ...undeclared } = INFO;
      expect(masInfoViolations(undeclared, expected)).to.deep.equal([
        'ITSAppUsesNonExemptEncryption must be false',
      ]);
    });

    it('allows only the Gezel engines and ggml plugin links as helpers, never UV', () => {
      const helpers = [
        { name: 'gezel-apple-fm', type: 'file' as const },
        { name: 'gezel-llama-server', type: 'file' as const },
        {
          name: 'libggml-metal.so',
          type: 'symlink' as const,
          target: '../Frameworks/libggml-metal.so',
        },
      ];
      expect(masHelperViolations(helpers)).to.deep.equal([]);
      expect(masHelperViolations([...helpers, { name: 'uv', type: 'file' }])).to.deep.equal([
        'UV must not ship: it installs Python packages at runtime',
      ]);
      expect(
        masHelperViolations([
          helpers[0],
          { name: 'libggml-metal.so', type: 'symlink', target: '/tmp/libggml-metal.so' },
        ]),
      ).to.deep.equal(['unexpected helper libggml-metal.so', 'missing helper gezel-llama-server']);
    });

    it('requires the installer to be signed by a Mac Installer Distribution identity of the team', () => {
      for (const leaf of [
        `3rd Party Mac Developer Installer: Bendyline, LLC (${TEAM})`,
        `Mac Installer Distribution: Bendyline, LLC (${TEAM})`,
      ])
        expect(installerSignatureViolations(pkgutil(leaf), TEAM)).to.deep.equal([]);
      expect(
        installerSignatureViolations(
          pkgutil(`Developer ID Installer: Bendyline, LLC (${TEAM})`),
          TEAM,
        )[0],
      ).to.contain('not a Mac Installer Distribution identity');
      expect(
        installerSignatureViolations(
          pkgutil('3rd Party Mac Developer Installer: Other (5B7Y53BF56)'),
          TEAM,
        ),
      ).to.deep.equal([`the installer is signed by team 5B7Y53BF56, not ${TEAM}`]);
      expect(
        installerSignatureViolations('Package "x.pkg":\n   Status: no signature\n', TEAM),
      ).to.deep.equal(['the installer package is unsigned']);
    });
  });

  describe('Microsoft Store package', () => {
    it('accepts the reserved identity for the requested architecture', () => {
      expect(appxManifestViolations(appxManifest('arm64'), APPX)).to.deep.equal([]);
    });

    it('rejects another architecture, a nonzero revision and a changed identity', () => {
      expect(appxManifestViolations(appxManifest('x64'), APPX)).to.deep.equal([
        'ProcessorArchitecture is x64, expected arm64',
      ]);
      expect(appxManifestViolations(appxManifest('arm64', '2.7.8.42'), APPX)).to.deep.equal([
        'Identity Version is 2.7.8.42, expected 2.7.8.0',
      ]);
      expect(
        appxManifestViolations(appxManifest('arm64', '2.7.8.0', '10.0.16299.0'), APPX),
      ).to.deep.equal(['MinVersion is 10.0.16299.0, expected 10.0.17763.0']);
      expect(
        appxManifestViolations(appxManifest('arm64'), { ...APPX, publisherDisplayName: 'Other' }),
      ).to.deep.equal(['PublisherDisplayName is Bendyline, LLC, expected Other']);
      expect(appxManifestViolations('<Package />', APPX)).to.deep.equal([
        'AppxManifest.xml has no Identity element',
      ]);
    });

    it('requires exactly the full-trust, microphone and webcam capabilities', () => {
      const manifest = (capabilities: string[]) =>
        appxManifest('arm64', '2.7.8.0', '10.0.17763.0', capabilities);
      expect(appxManifestViolations(manifest(['runFullTrust']), APPX)).to.deep.equal([
        'Capabilities lack microphone, webcam',
      ]);
      expect(
        appxManifestViolations(
          manifest(['runFullTrust', 'broadFileSystemAccess', 'microphone', 'webcam']),
          APPX,
        ),
      ).to.deep.equal(['Capabilities include unexpected broadFileSystemAccess']);
    });

    it('rejects UV anywhere in the package', () => {
      const engines = 'app/resources/gezel-native/win32-x64';
      expect(
        msixPayloadViolations([
          `${engines}/gezel-service-host.exe`,
          `${engines}/THIRD_PARTY_LICENSES/native/LICENSE-uv-MIT.txt`,
          '',
        ]),
      ).to.deep.equal([]);
      expect(msixPayloadViolations([`${engines}/uv.exe\r`])).to.deep.equal([
        'UV must not ship: it installs Python packages at runtime',
      ]);
    });
  });
});
