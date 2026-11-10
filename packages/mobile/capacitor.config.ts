import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Android's application ID. iOS's bundle ID is set in the Xcode project, because
  // it matches the Mac App Store build for universal purchase.
  appId: 'com.bendyline.docblocks',
  appName: 'DocBlocks',
  webDir: 'dist',
  loggingBehavior: 'none',
  // The WebView's own color before the page paints: the launch splash brown,
  // so the native splash hands off to index.html's without a black or white
  // frame between them.
  backgroundColor: '#231F18',
  // Android insets are DocBlocks' own: SystemInsets.java pads the window for the
  // bars and the keyboard. Capacitor's handling counted the navigation bar twice
  // above the keyboard on Android 14 and earlier with WebView 140+. SystemBars
  // still sets the bars' icon style.
  plugins: { SystemBars: { insetsHandling: 'disable' } },
  server: { androidScheme: 'https' },
  ios: { contentInset: 'never' },
};
export default config;
