# Speech: dictation and narration

DocBlocks desktop can take dictation into a document and read a document
aloud. Both run on the user's computer; audio and text never leave it. Speech
is **desktop only** — the site and the VS Code webview do not offer it.

The engines are the ones Gezel uses, but DocBlocks runs them itself rather than
asking a Gezel daemon:

|                 | Engine                                                                                      | Model                                                                        | Runs in                                     |
| --------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------- |
| Dictation (STT) | whisper.cpp `gezel-whisper-server`, from the Gezel native payload DocBlocks already bundles | `whisper-base.en` (recommended), `tiny.en`, `small.en`                       | a child process of main, on a loopback port |
| Narration (TTS) | Kokoro‑82M q8 on `onnxruntime-node` 1.24.3                                                  | `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped` + Gezel's 8 curated voices | an Electron `utilityProcess`                |

## Host contract

`packages/core/src/host/speech.ts` defines `DocBlocksHostSpeechAPI`, a sibling
of `host.ai`. Its shapes follow Gezel's audio schemas: transcription takes one
self-contained WAV take plus a continuity `prompt`; synthesis streams
independently playable float32 chunks, each carrying the UTF-16 range of the
request text it speaks. `speech-wire-policy.ts` parses everything with exact
keys and bounds on both sides of IPC.

`transcribe` and `synthesize` are optional one by one and drive the
`speechInput` and `speechOutput` capabilities. Main decides availability from
**files alone** — the whisper binary for the platform, the ONNX Runtime binding,
the macOS 14 floor ONNX Runtime declares — and stamps `--docblocks-speech=` on
the renderer argv. It never loads ONNX Runtime to find out.

## Desktop main

- `main/ipc-speech.ts` builds the service and registers owner-checked handlers
  in the same shape as `ipc-ai.ts`: streams are keyed by
  `(webContents, requestId)` with the id minted in the preload, and cancelled
  when that renderer navigates, reloads, crashes or closes.
- `main/speech/speech-service.ts` is Electron-free: readiness, the model store,
  preferences, install and synthesis streams, error mapping.
- `main/speech/whisper-engine.ts` is a slim port of Gezel's supervisor: Gezel's
  exact arguments, a fresh loopback port per start, `/health` readiness,
  10-minute idle stop, a 3-starts-per-minute budget, and Windows'
  `STATUS_DLL_NOT_FOUND` reported as a missing Visual C++ runtime.
- `main/speech/kokoro-*.ts`: the utility process calls ONNX Runtime directly
  with Kokoro's three inputs. Text becomes phonemes through
  `@bendyline/gezel/kokoro` and the dictionaries inside the installed
  `@bendyline/gezel-service`, so pronunciation matches Gezel exactly and
  eSpeak NG (GPL-3) is never involved. A stalled or crashed process is killed
  and respawned; an idle one is unloaded after five minutes.
- `@bendyline/gezel/speech-models` pins every file to a Hugging Face commit, byte
  length and SHA-256. Its shared downloader resumes, times out idle transfers,
  and renames into place only after verification. `main/speech/speech-models.ts`
  owns DocBlocks' installation manifests and adapts this shared storage API.
  Both Whisper and Kokoro can reuse Gezel downloads (never under the MAS
  sandbox or automation).
- Preferences are `userData/speech/preferences.json`, deliberately not
  `settings.json`, whose parser quarantines unknown keys.

### Shared downloads with Gezel

Both applications use `@bendyline/gezel/speech-models` for the pinned catalog,
verified downloads, and a cache at `<GEZEL_HOME>/engines/speech-assets/<sha256>`
(default `~/.gezel`). Each app keeps its own model paths and manifest. These
paths are hard links to shared bytes, so removing a model in one app leaves
other installations usable. On different filesystems, verified bytes are
copied; the download is still reused. Cache collection removes a blob only
after all installation links have gone. Cross-process locks serialize writers
and collection; a cancelled waiter cannot stop another app's download.

Discovery checks complete, verified files without downloading. It recognizes
legacy Gezel Whisper folders, configured read-only homes, and the machine's
public model assets directory. Custom `GEZEL_HOME` and
`GEZEL_SHARED_ASSETS_DIR` paths are honored. Model use acquires DocBlocks' own
references before loading, and existing private DocBlocks downloads join the
cache when next used. Gezel follows the same rule for its existing Whisper
files. A partially available multi-file model is unavailable until complete;
explicit installation reuses the files already present.

Kokoro q8 uses the same timestamped export in both apps. Gezel ships the small
model/tokenizer metadata its loader needs, while its packaged voice vectors
are reusable after verification. Older standard ONNX exports have different
bytes and require an explicit Gezel model update. No service connection,
AI opt-in, or new download is needed simply to reuse an installed model.
Settings labels owned shared references as **Shared speech storage** and
retains **Remove**; a discovered installation offers use without a download.
MAS and automation pass no shared cache or discovery roots and remain private.

Gezel core and service `1.2.4` are pinned in the desktop manifest and lockfile.
The published core provides `./speech-models`; sibling links remain available
for local development.

### Kokoro export and model updates

The ONNX model is pinned separately from the npm dependencies and native
engine payload. The timestamped q8 export is pinned to revision
`dd4401a9add81ac692d20e240d22ec9dda82cc29`, with 92,361,055 bytes and SHA-256
`c0c02b3299fd97c34ea92a98e6d41eaa1a739c8f77bf685aac34bd7b34c1132c`.
The eight voice files retain their original revision and hashes. This model
works with the existing ONNX Runtime; no native engine rebuild is required.

The outputs are `waveform` and float32 `durations` with shape `[1, inputTokens]`.
Durations are speed-scaled predictions **before** ONNX `Round` (nearest,
ties to even) and `Clip(min=1)`. Apply both operations before summing frames:
one frame is 600 samples at 24 kHz (25 ms). Account for padding and punctuation
tokens as well as phonemes. The utility process maps these allocations through
Gezel's `planKokoroSpeech` source ranges, then sends optional `wordTimings` with
each audio chunk. The exact wire parser bounds and copies those entries.
Generation adds each chunk's audio and script offsets and writes the resulting
word starts into the existing v3 sidecar. Expanded numbers share their original
source range; a word split across chunks retains its earliest onset.

These are model-derived frame allocations, not calibrated acoustic word
boundaries. No unverified padding correction is applied. Missing, invalid, or
PCM-inconsistent duration metadata falls back to syllable estimates within the
chunk. In-memory alignment marks estimates as `interpolated`; the existing v3
bookmark format stores the times but does not preserve that per-word flag.
Acoustic calibration and persisted timing-quality provenance remain follow-up
work. The new shared frontend also corrects multi-digit ordinal expansion
(`21st` becomes `twenty first`) and retains overlong words across model chunks.

Gezel core `1.2.4` includes the `@bendyline/gezel/kokoro` source-mapping API
and is pinned in the desktop manifest and lockfile.
The ONNX artifact is already published upstream; DocBlocks does
not publish or patch its own model, and no new native binary is needed for this
timing path.

An existing app manifest with different file pins reports
`updateRequired: true`, `installed: false`, and `source: null`. Settings offers
**Update** and **Remove**; readiness asks for an update before using that model.
This is an explicit replacement path, without running older unqualified
models or downloading on startup. No compatibility catalog for the unshipped
Kokoro export is retained.

Updates use the existing verified installer: unchanged files (including
voices) are reused, changed files replace their destination only after hash
verification, and the manifest is published last. Cancellation or failure
leaves the old manifest and any verified progress for retry. A partially
updated bundle is unavailable until the manifest matches the current pins;
this does not promise uninterrupted playback of the old model during an
update. Tests cover changed pins, checksum failure, cancellation at the last
file, retry without redownload, and malformed manifests.

## Renderer

- **Dictation** is Squisq's `speechInput` capability: Squisq owns the mic
  button, take cutting (Gezel's progressive dictation), caret, literal-text
  insertion and undo. `Speech/speech-input-provider.ts` adapts `host.speech`;
  `DocBlocksShell` passes it only when `allowRecording` permits the microphone.
  When a model is missing the button opens Settings.
- **Read aloud** (`Speech/SpeechToolbarControl.tsx`, `useReadAloud.ts`) plans
  segments from Squisq's narration script — headings and lines each become a
  sentence; fenced code is skipped — and streams them into a progressive Web
  Audio player using Gezel's auto-play rule.
- **Settings → Speech** downloads, updates, removes and chooses models, picks the voice
  and speed, and previews the voice.
- Native menu: Edit → **Dictate in DocBlocks** / **Read Aloud**
  (`edit:toggleDictation`, `edit:readAloud`), named apart from macOS's own
  "Start Dictation…".

## Packaging

Source builds first honor `DOCBLOCKS_GEZEL_NATIVE_BIN_DIR`. Otherwise they look
for an already installed Whisper engine at the installed Gezel service's exact
native-release pin in `~/.gezel/apps/docblocks/engines/native-bin/<release>` and
then `~/.gezel/engines/native-bin/<release>` (`GEZEL_HOME` overrides `~/.gezel`).
Discovery starts no service and downloads nothing. Restart the desktop app
after installing or changing an engine. Packaged builds only use their bundled
payload; they never fall back to these development locations.

- `onnxruntime-node` is a desktop runtime dependency, external to the main
  bundle and loaded only by `dist/main/kokoro-utility.cjs`. Its CUDA-fetching
  postinstall is explicitly denied in `allowScripts`. electron-builder unpacks
  the package; `files` patterns keep only the target platform/arch binaries and
  drop the DirectML DLLs the CPU backend never loads (210 MB → 35 MB on macOS).
- Developer ID builds need `com.apple.security.device.audio-input` and
  `device.camera` under the hardened runtime; `check:desktop-config` enforces
  both plists.
- Windows builds deploy the Visual C++ runtime app-local in
  `resources/vc-runtime` (`scripts/stage-vc-runtime.cjs`, required in release
  CI); main appends it to `PATH` so engines and ONNX Runtime find it after any
  serviced system copy.

## Mac App Store

Narration works in the sandbox: the ONNX Runtime addon is signed with the
inherited entitlements like the other unpacked addons. **Dictation in MAS waits
on a Gezel native release** with a statically linked `gezel-whisper-server`:
whisper's ggml 0.15.1 libraries share install names with llama-server's ggml
0.24.0 once `prepare-mas-gezel.cjs` flattens them into `Contents/Frameworks`.
Until then the MAS payload omits whisper and dictation reports unavailable.

## Testing

- Unit: `packages/core/test/speech-wire-policy.test.ts`,
  `packages/desktop/test/{speech-*,whisper-engine,kokoro,verified-download}.test.ts`,
  `packages/react/test/speech-*.test.ts`. The whisper tests run
  `test/helpers/fake-whisper-server.mjs` in place of the binary.
- Desktop e2e (`packages/desktop/e2e/speech.spec.ts`) runs the source app on
  stand-ins: the fixture points `DOCBLOCKS_SPEECH_WHISPER_BIN` / `_SCRIPT` at the
  fake server and `DOCBLOCKS_SPEECH_KOKORO_ENTRY` at `fake-kokoro-utility.cjs`
  (tones through the real `utilityProcess`); `fake-speech.ts` preinstalls tiny
  models via `DOCBLOCKS_SPEECH_CATALOG` and writes a WAV for Chromium's fake
  microphone. All of these are ignored by packaged builds.
- Opt-in real engines in the packaged app (`e2e/packaged-speech.spec.ts`):
  narrates a paragraph and transcribes it back, asserting word error rate.

  ```sh
  DOCBLOCKS_E2E_REAL_SPEECH=1 \
  DOCBLOCKS_E2E_WHISPER_MODEL=~/.gezel/engines/whisper-cpp/models/whisper-base.en/ggml-base.en.bin \
  DOCBLOCKS_E2E_KOKORO_MODEL=<…>/onnx/model_quantized.onnx \
  DOCBLOCKS_E2E_KOKORO_VOICES=<dir with the 8 curated voice .bin files> \
  npm run test:e2e:packaged -w docblocks-desktop
  ```

## Text from narration

Desktop **Insert → Text from narration** opens a draft transcript. **Record**
uses the same progressive microphone capture as dictation, updating the textbox
as phrases arrive. **Stop recording** releases the microphone and finishes the
last phrases. **Upload audio** decodes browser-supported audio (including WAV,
MP3, M4A and WebM), then sends independent mono WAV takes to the local recognizer
in order. Uploads are limited to 25 MB / 10 minutes; recording stops at 10 minutes.
The microphone preference gates recording, while uploads remain available.
A missing dictation model links to Speech settings; opening the dialog downloads
nothing and does not request microphone permission.
The entry appears between **Emoji** and **Record media**. On hosts with speech
settings it remains visible even when recognition is unavailable; the dialog
explains why and disables recording and uploads until recognition is ready.

The transcript is editable when transcription finishes. **Clean up fillers**
removes English filler sounds, obvious adjacent word repeats, ellipsis pauses
(`...`, `..` or `…`), and common bracketed transcript cues such as `[Pause]`,
`[Silence]` and `[Inaudible conversations]` without an AI model. Single periods
and other bracketed content, such as names and citations, stay intact.
**Rewrite with AI** is available when the host's AI is enabled and a model
is ready. It asks for natural prose preserving facts, names, numbers and meaning;
long transcripts are processed in bounded pieces. A failed, cancelled, empty or
incomplete rewrite leaves the transcript intact. **Undo cleanup** restores the
text before the latest cleanup or rewrite. Review edits before inserting.

**Insert text** adds literal prose after the current block as one undoable edit.
No audio is saved to the workspace by this flow. Closing the dialog or switching
documents stops capture and ignores pending transcription results. The transcript is a dialog
session draft, so copy it before closing if you want to keep it without inserting.
The Insert action and capture reuse Squisq's public `useEditorInsertMenuItems`
and `/speech` session APIs; changes to those APIs live in the linked Squisq repo.
