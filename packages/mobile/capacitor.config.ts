import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bendyline.docblocks.mobile',
  appName: 'DocBlocks',
  webDir: 'dist',
  loggingBehavior: 'none',
  plugins: { SystemBars: { insetsHandling: 'native', initialViewportFitValueHint: 'cover' } },
  server: { androidScheme: 'https' },
  ios: { contentInset: 'never' },
};
export default config;
