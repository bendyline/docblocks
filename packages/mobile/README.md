# DocBlocks mobile

Capacitor 8.5.2 packages the shared DocBlocks shell for iOS 16.4+ and Android 9/API 28+. Documents save through the existing `DocumentSession` and a native filesystem v2 backend. The web preview uses its own browser workspace.

## Build and run

Use the repository's Node/npm versions. The bundled Gezel system-provider adapters require Xcode 27+ on macOS, or Android SDK 36 and JDK 21. Set `ANDROID_HOME` and `JAVA_HOME` when the tools are not in their standard locations. These commands do not install SDKs.

```sh
npm run mobile:build
npm run mobile:check
npm run mobile:dev
npm run ios       # build, sync, open Xcode
npm run android   # build, sync, open Android Studio
```

To install on an iPhone, select the device and development team in Xcode and Run. The application ID is `com.bendyline.docblocks.mobile`. Signing credentials and team IDs are not checked in. CLI equivalent, after `npm run mobile:sync:ios`:

```sh
xcodebuild -project packages/mobile/ios/App/App.xcodeproj -scheme App \
  -configuration Debug -destination 'id=DEVICE_UDID' \
  -derivedDataPath reports/mobile-ios DEVELOPMENT_TEAM=YOUR_TEAM \
  -allowProvisioningUpdates build
xcrun devicectl device install app --device DEVICE_UDID \
  reports/mobile-ios/Build/Products/Debug-iphoneos/App.app
xcrun devicectl device process launch --device DEVICE_UDID com.bendyline.docblocks.mobile
```

Install updates in place; do not uninstall the personal app to troubleshoot it. The phone must be unlocked for launch. Android's equivalent is `adb -s DEVICE_ID install -r app-debug.apk`, using the APK under `android/app/build/outputs/apk/debug/` after building `:app:assembleDebug`.

## Storage and file flows

- **On this device** is app-private and offline. Uninstalling removes it. Use a picked work folder or export/backup to keep a separate copy.
- **Open a folder** uses Files security-scoped bookmarks on iOS and persisted document-tree grants on Android. Native code owns the grants; JavaScript sees workspace IDs and labels. Unavailable grants stay listed, and opening them fails visibly.
- Files are limited to 16 MiB, bridge chunks to 256 KiB, tree inspections and snapshots to 32 MiB/10,000 entries, and concurrent transfers to four. Oversized operations fail visibly. Desktop limits are unchanged.
- Native mutations serialize within the app. Conditional writes detect changes at commit time. Cloud providers can change concurrently and may reject rename/move; durability and atomicity are process-scoped, best effort. There is no native watcher. Returning to the app re-observes the active document.
- Markdown **Open With** imports an editable copy under `Inbox/`. The system file picker also supports the shared shell's imports and `.dbk` workflows. External originals are not retargeted automatically.
- **Save** stages a file and opens the system destination picker. **Share file** opens a separate share sheet. Android reports that the sheet was presented, not that a recipient saved the file. Cancelling retains the export dialog. Android share copies expire after 24 hours.
- Native calls are accepted only from the packaged editor's main frame. Authored blob/about frames cannot call the bridge or navigate the main WebView into privileged local content.

The iOS privacy manifest declares file metadata access for app-owned and explicitly selected files, disk-space checks before model downloads, and elapsed-time measurements, using [Apple's required reasons](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype). DocBlocks configures no analytics service. Gezel includes Google ML Kit and Play Services dependencies on Android; their terms and native notices ship with the app and their data disclosures require store review.

## Native assurance

```sh
npm run mobile:test:ios       # Swift unit tests and shared v2 contract over real Swift
npm run mobile:test:android   # shared v2 contract over real Java
npm run mobile:test:available # native suites runnable on this host; included in npm run all
```

Android's document-provider and app-sandbox contracts run on a device or emulator with a dedicated application ID. They never clear the personal application's data:

```sh
cd packages/mobile/android
./gradlew --no-daemon -PdocblocksTestApp :app:assembleDebug :app:assembleDebugAndroidTest
cd ../../..
npm run mobile:test:android:device -- emulator-5554
npm run mobile:test:android:editor -- emulator-5554 --offline
npm run mobile:test:android:ai -- emulator-5554
```

The `contractTest` source set is included only with `-PdocblocksTestApp`. Its provider and authenticated loopback harness are absent from production release artifacts. The editor smoke test checks native autosave, restart persistence, Monaco, and bridge isolation. `--offline` requires an emulator and restores its previous airplane mode and Wi-Fi state after the test. Results are saved under `reports/mobile-native/`.

## Release artifacts

```sh
npm run mobile:package -- ios 1
npm run mobile:package -- android 1
```

These commands rebuild, verify offline assets/fonts/notices, sync, and create **unsigned** Xcode archives or APK/AAB artifacts under a unique `reports/mobile-release/` directory. Verification compares every bundled web file's SHA-256 with the current Vite output, checks bridge configuration, privacy metadata, and test-code exclusion. Build numbers are explicit positive integers. The locked native dependency inventory and component notices ship in the payload. Store submission review remains a release gate; signing and upload are separate owner-controlled steps.

See [the implementation plan and qualification record](../../docs/mobile-plan.md) for device evidence and remaining physical-device/store qualification. Physical-device AI performance and store qualification remain open.

## On-device AI

Open **Settings → AI assistance → Use AI features**. An already available system model or imported model can be selected immediately. Otherwise choose **Add model…**, then **Download model**. The download size is shown before starting. Keep the app open; interrupted GGUF downloads resume when explicitly requested again. Cancel download or switch AI off to stop work. Downloaded models belong to DocBlocks, not to a separate Gezel installation.

The Model picker includes **Apple Foundation Models** on iOS and **Gemini Nano (Android ML Kit)** on Android alongside downloaded models. A system model stays visible when it is unavailable, with the OS's explanation; only ready models can be selected. Apple manages its model through Apple Intelligence in system Settings. ML Kit preparation is available through **Add model…** when the device reports that it can download the model. Returning from system Settings refreshes readiness. A saved model that becomes unavailable is preserved and fails with its reason instead of silently switching providers.

Apple Foundation Models requires iOS 26+ and Apple Intelligence-capable hardware with Apple Intelligence enabled. The attached iPhone 14 Pro Max is not eligible; downloaded GGUF models remain a separate option. See [Apple's requirements](https://support.apple.com/en-ie/121115) and [ML Kit's readiness states](https://developers.google.com/ml-kit/genai/prompt/android/get-started). These choices already exist in the Gezel SDK's `app.models()` contract; the DocBlocks host preserves their readiness metadata for the shared Settings UI.

The writing, review, and diagram controls (Illustrate document, Insert diagram) use `host.ai`; diagram suggestions make one model call at a time and size their prompts for a 4,096-token context. Mobile supports local text generation and explicit model preparation/downloads, including Apple Foundation Models and Android ML Kit when the OS reports them available. It does not expose cloud fallback, speech, image generation, workspace indexing, or arbitrary file access. Selected unavailable models fail visibly. AI is off by default; persisted opt-in reconnects on launch without downloading weights. Backgrounding cancels generation, pauses downloads, and releases model memory. Replies use provider-default sampling and a bounded context/output budget.

`@bendyline/gezel-capacitor` is an unpublished SDK preview packed from the sibling source. Its verified iOS and Android provider runtimes use **0.1.0-local.18**, including prebuilt llama.cpp; no desktop daemon or Node service is shipped. Supported binaries are arm64 (iOS device/simulator and Android). The tarball and provenance are checked in under `vendor/`; clean `npm ci` and native builds need no sibling checkout. Public App SDK 1.1.2 and core 1.2.2 supply the portable transport and boundary schemas. The model snapshot is projected by Gezel from Gilde 0.1.80, retaining immutable revisions and SHA-256 hashes. Native code verifies downloaded weights.

To refresh the preview explicitly, first stage matching verified native artifacts in Gezel following its Capacitor README, then run:

```sh
node --import tsx packages/mobile/scripts/refresh-gezel.mjs ../gezel
npm install ./packages/mobile/vendor/bendyline-gezel-capacitor-0.1.0.tgz -w docblocks-mobile
```

The script holds Gezel's dependency-read lease, runs its prepack integrity checks, and refreshes source hashes/catalog provenance. Review SDK version pins, regenerate notices, sync, and rerun qualification. `mobile:check` verifies native file hashes and plugin inclusion. The preview includes upstream fixes for Capacitor discovery in hoisted npm workspaces, lazy native runtime creation after opt-in, and removal of leading model reasoning envelopes from streamed answers. Source hashes record these fixes; no `node_modules` patch is required.

The native AI test installs tiny **synthetic** weights only into `.tests` and verifies real engine generation plus the Settings/host/App SDK path; it does not assess answer quality. The fixture was generated by Gezel's `gezel-llama-tests --write-fixture` (see its native/mobile README), and is excluded from release packages. Two native instrumentation cases check lazy startup and real generation; 22 adapter cases cover opt-in, cancellation, download integrity, system-provider routing and preparation, memory limits, and answer handling. System-provider tests inject native replies; actual Apple/ML Kit generation still requires supported hardware for qualification.

For an explicit real-model qualification, add `--download` to the AI test command. This downloads roughly 550 MB of pinned Qwen3.5 0.8B weights into the isolated test app through Settings, verifies them natively, and runs a rewrite. Use `--installed` to repeat against that already downloaded model. A 6 GiB arm64 API 36 emulator completed this flow and returned a clean rewrite; the default 2.5 GiB emulator correctly rejected generation for insufficient memory. This is a functional check, not a physical-device performance or answer-quality benchmark.

CI mirrors Gezel's Xcode 27 runner and arm64 build-only Android job. A maintainer `workflow_dispatch` additionally runs the device, editor, and synthetic AI suites on an `android-arm64` runner using the explicit repository variable `DOCBLOCKS_ANDROID_TEST_DEVICE`. Configure that runner and serial before dispatching. Run the offline editor check separately on an emulator with `--offline`; hosted Linux x86 emulators do not qualify the production engine.
