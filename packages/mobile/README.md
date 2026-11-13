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

To install on an iPhone, select the device and development team in Xcode and Run. The bundle ID is `com.bendyline.docblocks`, shared with the Mac App Store build for universal purchase, and the Android application ID is the same. Signing credentials and team IDs are not checked in. CLI equivalent, after `npm run mobile:sync:ios`:

```sh
xcodebuild -project packages/mobile/ios/App/App.xcodeproj -scheme App \
  -configuration Debug -destination 'id=DEVICE_UDID' \
  -derivedDataPath reports/mobile-ios DEVELOPMENT_TEAM=YOUR_TEAM \
  -allowProvisioningUpdates build
xcrun devicectl device install app --device DEVICE_UDID \
  reports/mobile-ios/Build/Products/Debug-iphoneos/App.app
xcrun devicectl device process launch --device DEVICE_UDID com.bendyline.docblocks
```

Install updates in place; do not uninstall the personal app to troubleshoot it. The phone must be unlocked for launch. Android's equivalent is `adb -s DEVICE_ID install -r app-debug.apk`, using the APK under `android/app/build/outputs/apk/debug/` after building `:app:assembleDebug`.

## Storage and file flows

- **iOS** opens **iCloud Drive › DocBlocks** (the `iCloud.com.bendyline.docblocks` container) when the person is signed in to iCloud, and **On My iPhone › DocBlocks** otherwise. Both are visible in the Files app, and existing installs keep their last workspace. Device storage is removed when the app is uninstalled. The AI test app never joins the container.
- iCloud listings never download. Files iCloud has not downloaded keep their names and are fetched, for up to 15 seconds, when opened, changed, moved, or removed. A snapshot or export that needs them asks to retry while they download. Each conflicting version iCloud keeps is saved beside the file as `name (conflict from Device date).md`, so nothing is chosen silently.
- **Android** opens the system folder picker once, on first launch, already inside a `Documents/DocBlocks` folder it has created (`SuggestedFolder.java`), so keeping documents there is **Use this folder**, then **Allow**. Android grants lasting access to a shared folder only through that picker, so this step cannot be skipped. The folder becomes the default workspace, survives reinstalling (the picker reopens it), and is visible to other apps and sync tools. Backing out keeps documents in app-private storage, which uninstalling removes. While that workspace is open the file sidebar says so and offers **Move to a folder…**, which copies everything into a picked folder, switches to it, removes the private copies and makes the folder the default. Forgetting the default folder makes device storage the default again.
- **Open a folder** uses Files security-scoped bookmarks on iOS and persisted document-tree grants on Android. Native code owns the grants; JavaScript sees workspace IDs and labels. Unavailable grants stay listed, and opening them fails visibly.
- Files are limited to 16 MiB (exports saved or shared from the app, such as rendered video, to 1 GiB, since they stream into a temporary file), bridge chunks to 256 KiB, tree inspections and snapshots to 32 MiB/10,000 entries, and concurrent transfers to four. Oversized operations fail visibly. Desktop limits are unchanged.
- Native mutations serialize within the app. Conditional writes detect changes at commit time. Cloud providers can change concurrently and may reject rename/move; durability and atomicity are process-scoped, best effort. There is no native watcher. Returning to the app re-observes the active document.
- Markdown **Open With** imports an editable copy under `Inbox/`. The system file picker also supports the shared shell's imports and `.dbk` workflows. External originals are not retargeted automatically.
- **Save** stages a file and opens the system destination picker. **Share file** opens a separate share sheet. Android reports that the sheet was presented, not that a recipient saved the file. Cancelling retains the export dialog. Android share copies expire after 24 hours.
- Native calls are accepted only from the packaged editor's main frame. Authored blob/about frames cannot call the bridge or navigate the main WebView into privileged local content.

The iOS privacy manifest declares file metadata access for app-owned and explicitly selected files, disk-space checks before model downloads, and elapsed-time measurements, using [Apple's required reasons](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype). DocBlocks configures no analytics service. Its Android build excludes the Google ML Kit dependency Gezel's runtime would otherwise bring, and with it Play Services and Google's telemetry transport.

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

These commands rebuild, verify offline assets/fonts/notices, sync, and create **unsigned** Xcode archives or APK/AAB artifacts under a unique `reports/mobile-release/` directory. Verification compares every bundled web file's SHA-256 with the current Vite output, checks bridge configuration, privacy metadata, and test-code exclusion. Build numbers are explicit positive integers. The locked native dependency inventory and component notices ship in the payload. Store submission review remains a release gate; upload is a separate owner-controlled step.

Store-ready binaries come from the **Release Store Builds** workflow (`.github/workflows/store-release.yml`), alongside the Microsoft Store and Mac App Store packages. Choose `mobile`, `android`, `ios`, or `all`. The workflow's run number, which only rises, becomes the Android `versionCode` and iOS `CFBundleVersion` (and the Mac App Store build's `CFBundleVersion`). The iOS app declares only exempt encryption (`ITSAppUsesNonExemptEncryption` is false), so App Store Connect does not ask the export-compliance question for each upload. The workflow attaches the files to a private draft GitHub Release. With `publish: testing` (the default), separate jobs then send the iOS build to TestFlight and the Android bundle to Play internal testing; nothing goes to App Review or a production track. Play's API cannot make an app's first release, so roll the first bundle out to Internal testing by hand. The required signing and upload secrets are listed in the workflow header. The same command runs locally with those variables set (Android also accepts `ANDROID_UPLOAD_KEYSTORE_PATH` in place of the base64 keystore):

```sh
npm run mobile:store -- android 42   # Play app bundle signed with the upload key
npm run mobile:store -- ios 42       # App Store Connect IPA and dSYMs
```

It runs the same build, check, and payload verification as `mobile:package`, and fails before building when a signing input is missing. Android verifies the bundle's upload-key signature with `jarsigner`. iOS accepts only an unexpired App Store Connect profile for `com.bendyline.docblocks` that grants iCloud Documents for `iCloud.com.bendyline.docblocks`, and the one Apple Distribution identity it authorizes. It signs only the App target's Release configuration, then checks the exported IPA's signature, embedded profile, and entitlements. It restores the Xcode project, keychain search list, and profiles afterwards. Output goes under `reports/mobile-store/`, with a JSON manifest of SHA-256 hashes.

See [the implementation plan and qualification record](../../docs/mobile-plan.md) for device evidence and remaining physical-device/store qualification. Broad physical-device AI performance and store qualification remain open.

## On-device AI

Open **Settings → AI assistance → Use AI features**. An already available system model or imported model can be selected immediately. Otherwise choose **Add model…**, then **Download model**. The download size is shown before starting. Keep the app open; interrupted GGUF downloads resume when explicitly requested again. Cancel download or switch AI off to stop work. Downloaded models belong to DocBlocks, not to a separate Gezel installation.

The Model picker includes **Apple Foundation Models** on iOS alongside downloaded models. A system model stays visible when it is unavailable, with the OS's explanation; only ready models can be selected. Apple manages its model through Apple Intelligence in system Settings. Returning from system Settings refreshes readiness. Gemini Nano (Android ML Kit) is not offered: ML Kit's GenAI terms bar apps likely to be used by people under 18, and the SDK reports usage metrics to Google. `android/app/build.gradle` excludes ML Kit, and the mobile host hides the provider that Gezel still reports as unavailable. A saved model that becomes unavailable is preserved and fails with its reason instead of silently switching providers.

Apple Foundation Models requires iOS 26+ and Apple Intelligence-capable hardware with Apple Intelligence enabled. The attached iPhone 14 Pro Max is not eligible; downloaded GGUF models remain a separate option. See [Apple's requirements](https://support.apple.com/en-ie/121115). These choices already exist in the Gezel SDK's `app.models()` contract; the DocBlocks host preserves their readiness metadata for the shared Settings UI.

The writing, review, and diagram controls (Illustrate document, Insert diagram) use `host.ai`; diagram suggestions make one model call at a time and size their prompts for a 4,096-token context. Mobile supports local text generation and explicit model preparation/downloads, including Apple Foundation Models when the OS reports it available. It does not expose cloud fallback, image generation, workspace indexing, or arbitrary file access. Selected unavailable models fail visibly. AI is off by default; persisted opt-in reconnects on launch without downloading weights. Backgrounding cancels generation, pauses downloads, and releases model memory. Replies use a bounded context/output budget and only the sampling controls advertised by inventory.

Dictation (Whisper) and read aloud (Kokoro) run on the device through `host.speech`, the same contract and shared Settings, toolbar and narration UI as desktop. `src/speech/` adapts the `createMobileSpeech` module of `@bendyline/gezel-capacitor`, whose `GezelOfflineSpeech` plugin runs the gezel-speech runtime the published plugin carries (whisper.cpp and Microsoft's ONNX Runtime build; about 30 MB of native libraries on Android and 36 MB on iOS) and stores models it verifies by SHA-256 in app-private, no-backup storage. Nothing downloads until the person chooses a model in Settings › Dictation or Narration: Whisper Tiny or Base (English) from the same pinned files as desktop, and Kokoro's int8 export of desktop's timestamped model (92 MB) with desktop's eight voices, so narration keeps word timings. An interrupted download resumes where it stopped and retries on its own while it keeps making progress. Kokoro's pronunciation dictionaries ship with the plugin and are served as web assets (`virtual:docblocks-kokoro-lexicon`); phonemes are planned in the WebView, so no eSpeak NG ships. The app allows dictation without enabling camera or screen recording (`allowDictation`), declares the microphone permission on both platforms, and records only between taps of the microphone button. Backgrounding stops speech, pauses a download, and frees the loaded models, which are otherwise released after two idle minutes. On a Samsung SM-S947U, Kokoro speaks about twice as fast as realtime and Whisper Base transcribes about seven times faster than realtime.

Knowledge catalogs work as on desktop: Settings › AI assistance lists Gilde's catalogs through `host.ai.knowledge`, and each request is grounded with the same `knowledgeContext` and the same knowledge event (sources and cited passages) that desktop sends. `src/ai/index.ts` hands the connection `createMobileKnowledge()` from `@bendyline/gezel-capacitor`; which catalogs are switched off is kept in local storage. A catalog downloads as one verified `.gezk` archive, together with its embedding profile's query model the first time (the multilingual e5 model is about 490 MB), into app-private, no-backup storage, and resumes and retries like the speech models. Nothing is extracted: the plugin's Web Worker (`virtual:docblocks-gezel-knowledge` serves it and `sqlite3.wasm`) reads the archive in place with range requests, which `BridgeBoundary` passes to `KnowledgeFiles` on Android and Capacitor serves from the app's files on iOS. Questions are embedded natively by the speech runtime's ONNX Runtime, so a catalog is searched by meaning as on desktop; only passages that clear Gezel's bar for vector evidence are cited. Searching the Pacific Northwest catalog on the SM-S947U takes 1–2 seconds per request.

Mobile uses Gezel's shared `createEmbedding` / `streamText` contract, with `connectEmbeddingRuntime` supplying the native transport. Gezel owns model descriptors and selection, the catalog, download validation/progress/cancellation, context budgets, answer filtering, and connection suspension/cleanup. DocBlocks owns only its preferences, one-operation policy, request deadline, and translation to `host.ai`. The Settings and writing/review/diagram UI are the same shared React components as desktop. Native engine phase and token progress reach the same host events as desktop.

Gezel derives advertised reply limits and request validation from one budget contract, using the installed model's native fitted context window when available. A review may request a larger reply budget, but the host caps it to that descriptor. The SDK retains the native prompt reserve, so choosing the advertised maximum cannot itself cause an “outside the provider limits” rejection. Native tokenization still checks the actual document length.

When native inventory advertises structured chat, the SDK uses llama.cpp's model templates and response parser, as desktop does. This makes sampling and reasoning controls available without provider-name checks in DocBlocks. Mobile requests `reasoningEffort: 'none'` when supported to reserve its small reply budget for the editor answer. Review and diagrams match desktop's reasoning policy; desktop writing retains its separately evaluated policy and larger budgets. Older bridges retain text generation without falsely advertising the newer controls.

Mobile pins the published `@bendyline/gezel-capacitor` (`1.1.1`) and the Gezel core (`1.3.1`) and App SDK (`1.2.1`) releases it depends on exactly; desktop runs the same core and App SDK. The plugin carries Gezel's verified **[native v0.1.62 release](https://github.com/bendyline/gezel/releases/tag/native-v0.1.62)** for iOS and Android, including prebuilt llama.cpp and the gezel-speech runtime, with the Swift/Java Capacitor bridge sources built against it; no desktop daemon or Node service is shipped. Supported binaries are arm64 (iOS device/simulator and Android); the Android libraries are 16 KB page-aligned. The model snapshot comes directly from Gezel's Gilde projection; native code verifies downloaded weights.

Gezel treats the speech runtime as optional: a plugin packed without it still builds, and dictation and narration then report themselves unavailable on the device while knowledge catalogs install but cite no passages, because questions are embedded on that runtime. Both native builds also decide at build time (SwiftPM checks for `GezelSpeech.xcframework`, Gradle for the speech Maven folder), so a build that did not see the runtime drops it without an error. DocBlocks therefore treats a missing runtime as a failure twice: `mobile:check` requires a verified iOS and Android speech runtime from the same native release as the engines, plus its `gezel-speech` line in `android/app/gradle.lockfile`; and `mobile:package` / `mobile:store` require the built app to carry it (`Frameworks/GezelSpeech.framework` on iOS, `libGezelSpeech.so` and `libonnxruntime.so` on Android) along with the microphone permission.

To move to a newer plugin, pin it and the `@bendyline/gezel` and `@bendyline/gezel-app-sdk` versions its `package.json` names, then run:

```sh
npm install
npm run generate:notices
npm run mobile:sync:ios
npm run mobile:sync:android
npm run mobile:check
```

Update the Gezel coordinates in `android/app/gradle.lockfile`, `native/android/dependencies.json` and `NATIVE_NOTICES.txt` to the plugin's native version (`native` in its `embedding-manifest.json`), then rerun native qualification. `gezel-speech` is an `implementation` dependency of the plugin, so its lock line names only the two runtime classpaths. Its license texts in `NATIVE_NOTICES.txt` (whisper.cpp, ONNX Runtime and ONNX Runtime's third-party notices) come from the plugin's `native/speech-android/`, the same files its AAR carries. `mobile:check` runs Gezel's installed-package verifier, which checks every file against the plugin's embedding manifest, and verifies the exact Gezel pins, both speech runtimes, the Gradle lock against the installed native payload, lockfile integrity, and plugin inclusion.

Native AI tests use tiny **synthetic** weights only in `com.bendyline.docblocks.mobile.tests`, separate from personal documents. They verify real engine generation and the Settings/host/App SDK path, not answer quality. The fixture was generated by Gezel's `gezel-llama-tests --write-fixture` and is excluded from release packages. The iOS command builds a temporary project named **DocBlocks AI Test** with a test-only runner, clears the temporary model selection during cleanup, records Settings and streaming results, and saves a screenshot/report under `reports/mobile-native/`. It covers write, review, and illustrate requests, progress events, opt-out, and exactly one terminal event. Android uses its isolated instrumentation harness. Adapter tests cover opt-in, cancellation, downloads, system-provider routing and preparation, memory limits, and answer handling.

Add `--download` to either platform's AI test command for an explicit real-model check. This downloads roughly 550 MB of pinned Qwen3.5 0.8B weights into the isolated test app, verifies them natively, and runs a rewrite request. Android also supports `--installed` to repeat against an existing download. This remains a functional check rather than an answer-quality benchmark.

On iOS, `--download --review` also opens **Review document** on the complete default document and requires a readable review in the shared UI. Add `--model=catalog:qwen3.5-2b-q4` to check Qwen 3.5 2B on a physical device; this model exceeds the native simulator's test-model size limit. The report records the review request size, completion, elapsed time and a screenshot. Without an explicit model, the iOS runner reuses an installed downloaded model before choosing the smallest catalog download.

The v0.1.54 update passed the synthetic app test on an iPhone 17 simulator, where Apple Foundation Models reported available, and on an arm64 API 36 Android emulator; neither run used a physical device or a downloaded model. The v0.1.48 iOS simulator and connected iPhone 14 Pro Max passed the synthetic app test. The simulator also downloaded Qwen3.5 and completed real text generation. The iPhone correctly reports Apple Foundation Models as unavailable because its hardware does not support Apple Intelligence, while offering downloadable models. Seven upstream native runtime tests passed on the simulator. Actual Apple generation and broad physical-device performance still require separate qualification. See [the qualification record](../../docs/mobile-plan.md).

CI mirrors Gezel's Xcode 27 runner and arm64 build-only Android job. A maintainer `workflow_dispatch` additionally runs the device, editor, and synthetic AI suites on an `android-arm64` runner using the explicit repository variable `DOCBLOCKS_ANDROID_TEST_DEVICE`. Configure that runner and serial before dispatching. Run the offline editor check separately on an emulator with `--offline`; hosted Linux x86 emulators do not qualify the production engine.
