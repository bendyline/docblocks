# Desktop AI native release handoff

The MAS integration is prepared. DocBlocks now pins published Gezel inference
`1.0.0`, which selects notarized native release `0.1.49`. The publication and
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
prepared change in `packages/inference/src/http/routes/v1-models.ts` selects
llama.cpp catalog weights under the store profile and withholds Python-based MLX
entries. Include that change in the inference publication.

After publishing the native release, run Gezel's existing pinning script with the
actual version, then build and publish the updated inference package:

```text
node scripts/pin-native-release.mjs <native-version> --macos-notarized
```

Review both generated inference pins (`native-manifest.ts` and
`native-file-manifest.json`). They must include the Apple helper, UV and Metal
engine, and the new release's complete hashes. Preserve the upstream Developer
ID signatures; MAS transforms its own copy after provenance verification.

## Update DocBlocks and qualify MAS

Once the new inference package is published, update its exact desktop
dependency, the matching App SDK and core pins, and the lockfile together, using
the repository's dependency policy:

```text
npm install --workspace docblocks-desktop --save-exact @bendyline/gezel-inference@<inference-version> @bendyline/gezel-app-sdk@<sdk-version>
npm install --workspace docblocks-desktop --save-exact --save-dev @bendyline/gezel@<core-version>
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

### OS qualification

The editor's macOS minimum remains 12.0. Bundled AI and dictation have a separate
macOS 13.3.0 / Linux glibc 2.38 floor, defined in
`packages/desktop/native-platform-policy.json`. Runtime checks happen before
loading or starting the bundled service or resolving Whisper; missing version
metadata fails closed. A compatible running standalone Gezel can still serve AI.
Narration independently requires macOS 14. These are feature requirements, so the
DEB description communicates them without forcing `libc6 >= 2.38` on the editor.
Snap/Flatpak checks use the runtime's libc, which may differ from the host's.

[Ubuntu 24.04's libc6](https://packages.ubuntu.com/noble/libc6) and
[Debian 13's libc6](https://packages.debian.org/trixie/libc6) exceed the native floor;
[Debian 12's libc6](https://packages.debian.org/bookworm/libc6) does not. These
package versions establish an ABI prerequisite, not successful app qualification.

Before publishing a native update:

1. Package both Linux architectures and macOS ARM64. Staging and `afterPack`
   inspect all native executables and libraries, reject requirements above the
   policy, and reject unparseable binary metadata. Do not lower the declared
   requirement without rebuilding the entire native dependency chain upstream.
2. On macOS 12 and a glibc 2.37-or-older Linux system, install the packaged app,
   open/edit/save/export the welcome document, and opt into AI and dictation.
   Confirm the OS explanation appears, no bundled engine/service starts, and
   unavailable speech models cannot be downloaded or selected. Check both fresh
   and previously enabled profiles. Repeat AI with a compatible running standalone
   Gezel to confirm that connection still works.
3. On macOS 13.3 and a glibc 2.38 system, exercise AI model installation and a real
   streamed request, dictation model installation and real transcription, cancel,
   restart, and renderer reload. Repeat on both Linux architectures. Qualify
   narration separately on macOS 14. Also smoke Ubuntu 24.04 and Debian 13 before
   advertising those distributions as tested.
4. Retain OS/runtime versions, package hashes, logs and outcomes with the release.
   Simulated boundary tests and static metadata scans do not replace these runs.

The F3 remediation was developed on Windows: boundary regression tests and scans
of the audited macOS/Linux payloads are available, but oldest-OS runtime
qualification remains required. Earlier preparation results below do not establish
compatibility with those minimum OS versions.

### Earlier MAS preparation

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
