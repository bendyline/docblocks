/** Build-only injection into an isolated app; production sources and user documents are untouched. */
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { setTimeout } from 'node:timers';
const args = process.argv.slice(2);
const [platform, device, team] = args.filter((value) => !value.startsWith('--'));
const download = process.argv.includes('--download');
const review = args.includes('--review');
const model = args.find((value) => value.startsWith('--model='))?.slice('--model='.length);
if ((review || model) && !download) throw new Error('--review and --model require --download');
if (model && !/^catalog:[a-z0-9.-]+$/.test(model)) throw new Error('Expected a catalog model ID');
if (!['simulator', 'device'].includes(platform) || !device || (platform === 'device' && !team))
  throw new Error(
    'Usage: ios-ai-smoke.mjs simulator|device <explicit device ID> [development team] [--download [--model=catalog:ID] [--review]]',
  );
const mobile = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(mobile, '../..');
const require = createRequire(new URL('../package.json', import.meta.url));
const sdk = path.dirname(require.resolve('@bendyline/gezel-capacitor/package.json'));
const appId = 'com.bendyline.docblocks.mobile.tests';
const runId = randomUUID();
const reports = path.join(root, 'reports/mobile-native');
await mkdir(reports, { recursive: true });
const work = await mkdtemp(path.join(reports, `ios-ai-${platform}-`));
const run = (tool, args, options = {}) =>
  execFileSync(tool, args, { encoding: 'utf8', timeout: 120_000, ...options });
await cp(path.join(mobile, 'ios'), path.join(work, 'ios'), { recursive: true });
await cp(path.join(mobile, 'native/ios'), path.join(work, 'native/ios'), {
  recursive: true,
  filter: (source) => !source.includes('/.build'),
});
const project = path.join(work, 'ios/App');
run('/usr/libexec/PlistBuddy', [
  '-c',
  'Set :CFBundleDisplayName DocBlocks AI Test',
  path.join(project, 'App/Info.plist'),
]);
const scene = path.join(project, 'App/SceneDelegate.swift');
await writeFile(
  scene,
  (await readFile(scene, 'utf8')).replace(
    'window?.makeKeyAndVisible()',
    'window?.makeKeyAndVisible()\n        DocBlocksAiSmoke.start(window?.rootViewController)',
  ) +
    '\n' +
    (await readFile(path.join(mobile, 'native/ios-smoke/Smoke.swift'), 'utf8'))
      .replace('RUN_ID', runId)
      .replace('DOWNLOAD_MODEL', download ? 'true' : 'false'),
);
const packageFile = path.join(project, 'CapApp-SPM/Package.swift');
await writeFile(
  packageFile,
  (await readFile(packageFile, 'utf8')).replace(
    /(name: "BendylineGezelCapacitor", path: )"[^"]+"/,
    `$1${JSON.stringify(sdk)}`,
  ),
);
const projectFile = path.join(project, 'App.xcodeproj/project.pbxproj');
await writeFile(
  projectFile,
  (await readFile(projectFile, 'utf8')).replaceAll(
    'PRODUCT_BUNDLE_IDENTIFIER = com.bendyline.docblocks.mobile;',
    `PRODUCT_BUNDLE_IDENTIFIER = ${appId};`,
  ),
);
await cp(
  path.join(mobile, 'native/ios-smoke/ai-smoke.js'),
  path.join(project, 'App/public/ai-smoke.js'),
);
await writeFile(
  path.join(project, 'App/public/ai-smoke-options.json'),
  JSON.stringify({ model: model ?? null, review }),
);
await cp(
  path.join(mobile, 'android/app/src/androidTest/assets/mobile-ai-fixture.gguf'),
  path.join(project, 'App/public/mobile-ai-fixture.gguf'),
);
const derived = path.join(work, 'derived');
const destination = `${platform === 'simulator' ? 'platform=iOS Simulator' : 'platform=iOS'},id=${device}`;
const build = spawnSync(
  'xcodebuild',
  [
    '-project',
    path.join(project, 'App.xcodeproj'),
    '-scheme',
    'App',
    '-configuration',
    'Debug',
    '-destination',
    destination,
    '-derivedDataPath',
    derived,
    ...(team
      ? [`DEVELOPMENT_TEAM=${team}`, '-allowProvisioningUpdates']
      : ['CODE_SIGNING_ALLOWED=NO']),
    'build',
  ],
  { encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 ** 2 },
);
await writeFile(path.join(work, 'build.log'), `${build.stdout}\n${build.stderr}`);
if (build.status !== 0)
  throw new Error(`Build failed; see ${work}/build.log\n${build.stdout?.slice(-4000)}`);
const app = path.join(
  derived,
  'Build/Products',
  platform === 'simulator' ? 'Debug-iphonesimulator/App.app' : 'Debug-iphoneos/App.app',
);
if (platform === 'simulator') {
  run('xcrun', ['simctl', 'install', device, app]);
  run('xcrun', ['simctl', 'launch', '--terminate-running-process', device, appId]);
} else {
  run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', device, app]);
  run('xcrun', [
    'devicectl',
    'device',
    'process',
    'launch',
    '--terminate-existing',
    '--device',
    device,
    appId,
  ]);
}
let report;
for (let attempt = 0; attempt < (download ? 1800 : 90); attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  try {
    if (platform === 'simulator') {
      const container = run('xcrun', ['simctl', 'get_app_container', device, appId, 'data']).trim();
      report = JSON.parse(await readFile(path.join(container, 'Documents/ai-smoke.json'), 'utf8'));
      await cp(
        path.join(container, 'Documents/ai-settings.png'),
        path.join(work, 'ai-settings.png'),
      ).catch(() => {});
      if (review)
        await cp(
          path.join(container, 'Documents/ai-review.png'),
          path.join(work, 'ai-review.png'),
        ).catch(() => {});
    } else {
      run(
        'xcrun',
        [
          'devicectl',
          'device',
          'copy',
          'from',
          '--device',
          device,
          '--domain-type',
          'appDataContainer',
          '--domain-identifier',
          appId,
          '--source',
          'Documents/ai-smoke.json',
          '--destination',
          path.join(work, 'ai-smoke.json'),
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      report = JSON.parse(await readFile(path.join(work, 'ai-smoke.json'), 'utf8'));
      try {
        run('xcrun', [
          'devicectl',
          'device',
          'copy',
          'from',
          '--device',
          device,
          '--domain-type',
          'appDataContainer',
          '--domain-identifier',
          appId,
          '--source',
          'Documents/ai-settings.png',
          '--destination',
          path.join(work, 'ai-settings.png'),
        ]);
      } catch {
        /* A screenshot is supplementary; the structured report determines success. */
      }
      if (review && report.runId === runId && report.ok) {
        run('xcrun', [
          'devicectl',
          'device',
          'copy',
          'from',
          '--device',
          device,
          '--domain-type',
          'appDataContainer',
          '--domain-identifier',
          appId,
          '--source',
          'Documents/ai-review.png',
          '--destination',
          path.join(work, 'ai-review.png'),
        ]);
      }
    }
    if (report.runId !== runId) {
      report = undefined;
      continue;
    }
    break;
  } catch {
    /* The report appears after the native and editor checks finish. */
  }
}
await writeFile(
  path.join(work, 'ai-smoke.json'),
  JSON.stringify(
    report ?? { ok: false, error: 'Timed out waiting for the test app report' },
    null,
    2,
  ) + '\n',
);
process.stdout.write(`${work}\n${JSON.stringify(report, null, 2)}\n`);
if (!report?.ok) throw new Error('iOS AI smoke failed; inspect the report above.');
