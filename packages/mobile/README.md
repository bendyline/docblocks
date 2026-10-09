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
npm run mobile:test:ios:ai -- simulator SIMULATOR_UDID
npm run mobile:test:ios:ai -- device DEVICE_UDID YOUR_TEAM
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

See [the implementation plan and qualification record](../../docs/mobile-plan.md) for device evidence and remaining physical-device/store qualification. Broad physical-device AI performance and store qualification remain open.

## On-device AI

Open **Settings → AI assistance → Use AI features**. An already available system model or imported model can be selected immediately. Otherwise choose **Add model…**, then **Download model**. The download size is shown before starting. Keep the app open; interrupted GGUF downloads resume when explicitly requested again. Cancel download or switch AI off to stop work. Downloaded models belong to DocBlocks, not to a separate Gezel installation.

The Model picker includes **Apple Foundation Models** on iOS and **Gemini Nano (Android ML Kit)** on Android alongside downloaded models. A system model stays visible when it is unavailable, with the OS's explanation; only ready models can be selected. Apple manages its model through Apple Intelligence in system Settings. ML Kit preparation is available through **Add model…** when the device reports that it can download the model. Returning from system Settings refreshes readiness. A saved model that becomes unavailable is preserved and fails with its reason instead of silently switching providers.

Apple Foundation Models requires iOS 26+ and Apple Intelligence-capable hardware with Apple Intelligence enabled. The attached iPhone 14 Pro Max is not eligible; downloaded GGUF models remain a separate option. See [Apple's requirements](https://support.apple.com/en-ie/121115) and [ML Kit's readiness states](https://developers.google.com/ml-kit/genai/prompt/android/get-started). These choices already exist in the Gezel SDK's `app.models()` contract; the DocBlocks host preserves their readiness metadata for the shared Settings UI.

The writing, review, and diagram controls (Illustrate document, Insert diagram) use `host.ai`; diagram suggestions make one model call at a time and size their prompts for a 4,096-token context. Mobile supports local text generation and explicit model preparation/downloads, including Apple Foundation Models and Android ML Kit when the OS reports them available. It does not expose cloud fallback, speech, image generation, workspace indexing, or arbitrary file access. Selected unavailable models fail visibly. AI is off by default; persisted opt-in reconnects on launch without downloading weights. Backgrounding cancels generation, pauses downloads, and releases model memory. Replies use a bounded context/output budget and only the sampling controls advertised by inventory.

Mobile uses Gezel's shared `createEmbedding` / `streamText` contract, with `connectEmbeddingRuntime` supplying the native transport. Gezel owns model descriptors and selection, the catalog, download validation/progress/cancellation, context budgets, answer filtering, and connection suspension/cleanup. DocBlocks owns only its preferences, one-operation policy, request deadline, and translation to `host.ai`. The Settings and writing/review/diagram UI are the same shared React components as desktop. Native engine phase and token progress reach the same host events as desktop.

Gezel derives advertised reply limits and request validation from one budget contract, using the installed model's native fitted context window when available. A review may request a larger reply budget, but the host caps it to that descriptor. The SDK retains the native prompt reserve, so choosing the advertised maximum cannot itself cause an “outside the provider limits” rejection. Native tokenization still checks the actual document length.

When native inventory advertises structured chat, the SDK uses llama.cpp's model templates and response parser, as desktop does. This makes sampling and reasoning controls available without provider-name checks in DocBlocks. Mobile requests `reasoningEffort: 'none'` when supported to reserve its small reply budget for the editor answer. Review and diagrams match desktop's reasoning policy; desktop writing retains its separately evaluated policy and larger budgets. Older bridges retain text generation without falsely advertising the newer controls.

The five Gezel packages are matched, unpublished `-docblocks.2` previews packed from the sibling source. Their iOS and Android runtimes use the verified **[native v0.1.48 release](https://github.com/bendyline/gezel/releases/tag/native-v0.1.48)**, including prebuilt llama.cpp; no desktop daemon or Node service is shipped. Supported binaries are arm64 (iOS device/simulator and Android). The tarballs and provenance are checked in under `vendor/`; clean `npm ci` and native builds need no sibling checkout. `native-release.json` pins both release archives and the Swift/Java Capacitor bridge sources from that release's commit, so newer unreleased bridge methods cannot accidentally require a newer runtime. The model snapshot comes directly from Gezel's Gilde projection; native code verifies downloaded weights.

To refresh explicitly, download both release archives listed in `vendor/native-release.json` into a directory, then run:

```sh
node packages/mobile/scripts/refresh-gezel.mjs ../gezel /path/to/native-release-archives
npm install -w docblocks-mobile \
  ./packages/mobile/vendor/bendyline-gezk-1.0.2-docblocks.2.tgz \
  ./packages/mobile/vendor/bendyline-gezel-1.2.2-docblocks.2.tgz \
  ./packages/mobile/vendor/bendyline-gezel-client-1.2.2-docblocks.2.tgz \
  ./packages/mobile/vendor/bendyline-gezel-app-sdk-1.1.2-docblocks.2.tgz \
  ./packages/mobile/vendor/bendyline-gezel-capacitor-0.1.0-docblocks.2.tgz
npm run generate:notices
npm run mobile:sync:ios
npm run mobile:sync:android
npm run mobile:check
```

The script holds Gezel's dependency-read lease, builds the portable packages, stages hash-verified release binaries and matching bridge sources in a temporary package, and runs Gezel's installed-package verifier. It leaves the producer's native staging and dependency tree unchanged. Review the generated version pins and provenance, then rerun native qualification. `mobile:check` verifies the installed native inventories, preview versions, tarball hashes, lockfile integrity, and plugin inclusion. The SDK changes must be published and the previews replaced with exact public versions before release.

Native AI tests use tiny **synthetic** weights only in `com.bendyline.docblocks.mobile.tests`, separate from personal documents. They verify real engine generation and the Settings/host/App SDK path, not answer quality. The fixture was generated by Gezel's `gezel-llama-tests --write-fixture` and is excluded from release packages. The iOS command builds a temporary project named **DocBlocks AI Test** with a test-only runner, clears the temporary model selection during cleanup, records Settings and streaming results, and saves a screenshot/report under `reports/mobile-native/`. It covers write, review, and illustrate requests, progress events, opt-out, and exactly one terminal event. Android uses its isolated instrumentation harness. Adapter tests cover opt-in, cancellation, downloads, system-provider routing and preparation, memory limits, and answer handling.

Add `--download` to either platform's AI test command for an explicit real-model check. This downloads roughly 550 MB of pinned Qwen3.5 0.8B weights into the isolated test app, verifies them natively, and runs a rewrite request. Android also supports `--installed` to repeat against an existing download. This remains a functional check rather than an answer-quality benchmark.

On iOS, `--download --review` also opens **Review document** on the complete default document and requires a readable review in the shared UI. Add `--model=catalog:qwen3.5-2b-q4` to check Qwen 3.5 2B on a physical device; this model exceeds the native simulator's test-model size limit. The report records the review request size, completion, elapsed time and a screenshot. Without an explicit model, the iOS runner reuses an installed downloaded model before choosing the smallest catalog download.

The v0.1.48 iOS simulator and connected iPhone 14 Pro Max passed the synthetic app test. The simulator also downloaded Qwen3.5 and completed real text generation. The iPhone correctly reports Apple Foundation Models as unavailable because its hardware does not support Apple Intelligence, while offering downloadable models. Seven upstream native runtime tests passed on the simulator. Actual Apple/ML Kit generation and broad physical-device performance still require separate qualification. See [the qualification record](../../docs/mobile-plan.md).

CI mirrors Gezel's Xcode 27 runner and arm64 build-only Android job. A maintainer `workflow_dispatch` additionally runs the device, editor, and synthetic AI suites on an `android-arm64` runner using the explicit repository variable `DOCBLOCKS_ANDROID_TEST_DEVICE`. Configure that runner and serial before dispatching. Run the offline editor check separately on an emulator with `--offline`; hosted Linux x86 emulators do not qualify the production engine.
