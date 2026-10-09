# Speech: dictation and narration

DocBlocks desktop can take dictation into a document and read a document
aloud. Both run on the user's computer; audio and text never leave it. Speech
is **desktop only** — the site and the VS Code webview do not offer it.

The engines are the ones Gezel uses, but DocBlocks runs them itself rather than
asking a Gezel daemon:

|                 | Engine                                                                                      | Model                                                            | Runs in                                     |
| --------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| Dictation (STT) | whisper.cpp `gezel-whisper-server`, from the Gezel native payload DocBlocks already bundles | `whisper-base.en` (recommended), `tiny.en`, `small.en`           | a child process of main, on a loopback port |
| Narration (TTS) | Kokoro‑82M q8 on `onnxruntime-node` 1.24.3                                                  | `onnx-community/Kokoro-82M-v1.0-ONNX` + Gezel's 8 curated voices | an Electron `utilityProcess`                |

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
- `main/speech/speech-models.ts` pins every file to a Hugging Face commit, byte
  length and SHA-256; `verified-download.ts` resumes, times out idle transfers
  and renames into place only after verification. A Whisper model the user's
  own Gezel already downloaded is used read-only once its hash matches (never
  under the MAS sandbox or automation).
- Preferences are `userData/speech/preferences.json`, deliberately not
  `settings.json`, whose parser quarantines unknown keys.

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
- **Settings → Speech** downloads, removes and chooses models, picks the voice
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
