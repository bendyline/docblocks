import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Android's application ID. iOS's bundle ID is set in the Xcode project, because
  // it matches the Mac App Store build for universal purchase.
  appId: 'com.bendyline.docblocks',
  appName: 'DocBlocks',
  webDir: 'dist',
  loggingBehavior: 'none',
  plugins: { SystemBars: { insetsHandling: 'native', initialViewportFitValueHint: 'cover' } },
  server: { androidScheme: 'https' },
  ios: { contentInset: 'never' },
};
export default config;
