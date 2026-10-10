# Desktop AI native release handoff

The MAS integration is prepared. DocBlocks now pins published Gezel service
`1.2.4`, which selects notarized native release `0.1.48`. The publication and
dependency update steps below describe the release process; signed MAS build
and runtime qualification are still required. No prospective version or hash
is trusted.

## Build and publish in Gezel

The Gezel checkout's native workflow already builds `gezel-apple-fm` using Xcode
27 and includes it in the signed `darwin-arm64` archive. Its shared Swift adapter
weak-links Foundation Models for older macOS and reports Apple Intelligence
readiness. The first MAS release needs these published payloads:

- `darwin-arm64`: `gezel-apple-fm`, UV, and the native support binaries/libraries.
- `darwin-arm64-metal`: llama.cpp server and its Metal libraries.
- Complete archive hashes and `NATIVE_FILE_MANIFESTS.json`, generated from the
  signed native bytes, with macOS notarization completed.

Build/release these through Gezel's existing `build-native.yml` workflow. The
prepared service change in `packages/service/src/http/routes/v1-models.ts` selects
llama.cpp catalog weights under the store profile and withholds Python-based MLX
entries. Include that change in the service publication.

After publishing the native release, run Gezel's existing pinning script with the
actual version, then build and publish the updated service package:

```text
node scripts/pin-native-release.mjs <native-version> --macos-notarized
```

Review both generated service pins (`native-manifest.ts` and
`native-file-manifest.json`). They must include the Apple helper, UV and Metal
engine, and the new release's complete hashes. Preserve the upstream Developer
ID signatures; MAS transforms its own copy after provenance verification.

## Update DocBlocks and qualify MAS

Once the new service is published, update its exact desktop dependency and the
lockfile together, using the repository's dependency policy:

```text
npm install --workspace docblocks-desktop --save-exact @bendyline/gezel-service@<service-version>
npm run generate:notices
npm run all
npm run dist:mas --workspace docblocks-desktop
```

Supply the existing MAS provisioning profile and Apple Distribution/Mac Installer
Distribution identities. The native signing hook selects the app identity from
`mas.identity` or `CSC_NAME` when more than one eligible certificate exists. The
native hook accepts the configured first-party teams (`5B7Y53BF56` and
`JXA5M4VK3V`); changing the app's publishing team requires updating that signing
policy. Native executables inherit the app sandbox; libraries carry no executable
entitlements. Verified source executables move to `Contents/Helpers`, and Metal
libraries move to `Contents/Frameworks`, with sealed symlinks preserving Gezel's
resource paths. The outer app signature seals
`Contents/Resources/gezel-native/mas-manifest.json` after signing.

Local builds verify the transformed byte hashes exactly. App Store delivery
re-signs code, so an authenticated Apple Mac OS Application Signing certificate
and complete app resource seal authorize those changed signature bytes. Runtime
still verifies each native signature, locations, symlinks, sandbox inheritance,
and the complete app seal. Qualify both the signed development build and an app
installed from the store; a local build cannot reproduce Apple's delivery seal.

Use a signed MAS development build for runtime qualification, then the store
distribution build for submission:

```text
npm run dist:mas:dev --workspace docblocks-desktop
```

Set `masDev.provisioningProfile` to the development profile when qualifying;
`mas.provisioningProfile` remains the distribution profile for submission.

- With AI off, no private service, readiness helper or inference engine starts.
- Opt-in starts the private service within the container, without standalone
  discovery or borrowing models from `~/.gezel`.
- Apple Intelligence lists its real context window and readiness; a compatible
  ready device can complete a streamed editor request without installing weights.
  An unready device shows its explanation and cannot select that model.
- **Add model** downloads only model data. A GGUF model completes a streamed
  request through the bundled Metal engine. Startup, model selection and engine
  preparation never download executable code or Python packages.
- Cancelling, disabling AI, and closing/reloading the renderer terminate owned
  streams. Damaged or missing engines fail verification visibly.
- The resulting app passes codesign verification and its native executables have
  exactly `com.apple.security.app-sandbox` and `com.apple.security.inherit` enabled.

ML Kit GenAI uses [Android's AICore](https://developers.google.com/ml-kit/genai);
macOS uses Apple's Foundation Models API. Apple's
[bundle layout guidance](https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle)
and [signing certificate guidance](https://developer.apple.com/documentation/technotes/tn3161-inside-code-signing-certificates)
explain the MAS relocation and delivery checks.
The desktop Gezel host remains the provider boundary. MLX can return to store
builds after a frozen Python runtime is bundled and qualified separately.

## Preparation validation

The repository's `npm run all` passed, including packaged desktop AI startup.
After the final MAS layout changes, 115 targeted desktop AI tests, desktop
typechecking, lint, main/preload builds and packaging configuration checks passed.
The real Apple helper compiled and passed its self-test; this Mac reported its
system model unavailable, so Apple inference still needs a ready device.

A temporary development bundle authenticated the current published native
payload, added the locally compiled Apple helper for layout testing, and then
relocated and ad-hoc signed its copy. UV launched, llama.cpp detected Metal from
both its resource and Helpers paths, electron-builder's signing traversal
preserved native pins, and macOS deep signature/resource verification passed.
The production MAS verifier also accepted a temporary development-signed copy,
including its app seal, exact hashes and the helpers' sandbox inheritance.
That fixture does not qualify the unpublished payload or a sandboxed MAS build.
