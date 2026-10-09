/**
 * IPC for `DocBlocksHostSpeechAPI`.
 *
 * Mirrors `ipc-ai.ts`: every handler is owner- and origin-checked and parses
 * its arguments with the shared speech wire policy; streams are addressed by
 * `(webContents, requestId)` with the id minted in the preload, and a renderer
 * that reloads, navigates, crashes or closes has its streams cancelled.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, app, systemPreferences, utilityProcess } from 'electron';
import type { WebContents } from 'electron';
import {
  isSpeechModelId,
  parseSpeechModelKind,
  parseSpeechPreferencesPatch,
  parseSpeechSynthesizeRequest,
  parseSpeechTranscribeRequest,
} from '@bendyline/docblocks/host';
import type { SpeechInstallEvent, SpeechSynthesizeEvent } from '@bendyline/docblocks/host';

import { registerTrustedIpcHandler } from './ipc-authority.js';
import { KokoroEngine, type KokoroChannel } from './speech/kokoro-engine.js';
import { kokoroLexiconDir, onnxRuntimeBinding } from './speech/kokoro-frontend.js';
import type { KokoroReply } from './speech/kokoro-runtime.js';
import { SpeechModelStore, type SpeechModelEntry } from './speech/speech-models.js';
import { SpeechPreferenceStore } from './speech/speech-preferences.js';
import {
  SpeechService,
  type MicrophoneAccess,
  type SttEngine,
  type TtsEngine,
  type UnavailableEngine,
} from './speech/speech-service.js';
import { WhisperEngine } from './speech/whisper-engine.js';
import { findWhisperBinary } from './speech/whisper-location.js';

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * Locate the bundled whisper server for this platform. Main-authoritative: the
 * path comes from the packaged payload (or an installed development engine),
 * never from the renderer.
 */
export async function resolveWhisperEngine(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SttEngine | UnavailableEngine> {
  if (!app.isPackaged) {
    // Development and e2e only: a stand-in server, optionally run through an
    // interpreter. Cleared from packaged builds by construction.
    const override = env.DOCBLOCKS_SPEECH_WHISPER_BIN?.trim();
    if (override) {
      const leading = env.DOCBLOCKS_SPEECH_WHISPER_SCRIPT?.trim();
      return new WhisperEngine({
        binary: override,
        ...(leading ? { leadingArgs: [leading] } : {}),
      });
    }
  }
  // This small, data-only module imports no service runtime and starts nothing.
  const { NATIVE_ENGINE_RELEASE } = await import('@bendyline/gezel-service/native-release');
  const binary = findWhisperBinary({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    env,
    platform: process.platform,
    arch: process.arch,
    macAppStore: process.mas === true,
    home: app.getPath('home'),
    nativeRelease: NATIVE_ENGINE_RELEASE,
  });
  if (!binary) {
    return {
      unavailable: app.isPackaged
        ? 'Speech recognition is not included in this build of DocBlocks.'
        : 'Speech recognition could not find its local Whisper engine. Configure DOCBLOCKS_GEZEL_NATIVE_BIN_DIR for this development build, then restart DocBlocks.',
    };
  }
  return new WhisperEngine({ binary });
}

/** Run the narration engine's utility process. */
function forkKokoro(entry: string): KokoroChannel {
  const child = utilityProcess.fork(entry, [], {
    serviceName: 'DocBlocks Narration',
    stdio: 'ignore',
  });
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => child.on('message', (reply: KokoroReply) => listener(reply)),
    onExit: (listener) => child.on('exit', listener),
    kill: () => {
      child.kill();
    },
  };
}

/**
 * Decide whether narration can run here from files alone — never by loading
 * ONNX Runtime in main, which would undo the process isolation.
 */
export function resolveKokoroEngine(
  env: NodeJS.ProcessEnv = process.env,
): TtsEngine | UnavailableEngine {
  if (!app.isPackaged) {
    // Development and e2e only: a stand-in utility that speaks tones, so the
    // real utilityProcess plumbing is exercised without the model.
    const fake = env.DOCBLOCKS_SPEECH_KOKORO_ENTRY?.trim();
    if (fake) return new KokoroEngine({ lexiconDir: '', fork: () => forkKokoro(fake) });
  }
  if (process.platform === 'darwin') {
    // The prebuilt ONNX Runtime declares macOS 14 as its minimum.
    const major = Number(process.getSystemVersion().split('.')[0]);
    if (Number.isFinite(major) && major < 14) {
      return { unavailable: 'Narration needs macOS 14 or later.' };
    }
  }
  let binding: string;
  let lexiconDir: string;
  try {
    binding = onnxRuntimeBinding(require.resolve('onnxruntime-node/package.json'));
    lexiconDir = kokoroLexiconDir(require.resolve('@bendyline/gezel-service/package.json'));
  } catch {
    return { unavailable: 'Narration is not included in this build of DocBlocks.' };
  }
  if (!existsSync(binding)) {
    return { unavailable: 'Narration is not available on this computer.' };
  }
  if (!existsSync(path.join(lexiconDir, 'lexicon-us-en.txt.gz'))) {
    return { unavailable: 'Narration is missing its pronunciation dictionary.' };
  }
  const entry = path.join(__dirname, 'kokoro-utility.cjs');
  return new KokoroEngine({ lexiconDir, fork: () => forkKokoro(entry) });
}

function microphoneAccess(): MicrophoneAccess {
  // Automation drives Chromium's fake microphone, which bypasses the OS grant.
  if (process.env.DOCBLOCKS_E2E_DEFAULT_ROOT) return 'unknown';
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 'unknown';
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return 'granted';
  if (status === 'denied' || status === 'restricted') return 'denied';
  if (status === 'not-determined') return 'not-determined';
  return 'unknown';
}

/** Development and e2e only: a catalog of small stand-in model files. */
function developmentCatalog(env: NodeJS.ProcessEnv): readonly SpeechModelEntry[] | undefined {
  const file = app.isPackaged ? undefined : env.DOCBLOCKS_SPEECH_CATALOG?.trim();
  if (!file) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as SpeechModelEntry[];
}

export async function createSpeechService(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SpeechService> {
  const root = path.join(app.getPath('userData'), 'speech');
  const macAppStore = process.mas === true;
  // Automation must not pick up models a developer's own Gezel downloaded.
  const automation = Boolean(env.DOCBLOCKS_E2E_DEFAULT_ROOT);
  const catalog = developmentCatalog(env);
  return new SpeechService({
    models: new SpeechModelStore({
      root: path.join(root, 'models'),
      // A sandboxed build cannot read another app's downloads.
      sharedHome: macAppStore || automation ? null : app.getPath('home'),
      ...(catalog ? { catalog } : {}),
    }),
    preferences: new SpeechPreferenceStore(path.join(root, 'preferences.json')),
    stt: await resolveWhisperEngine(env),
    tts: resolveKokoroEngine(env),
    microphoneAccess,
  });
}

function streamKey(ownerId: number, requestId: string): string {
  return `${ownerId}:${requestId}`;
}

function parseRequestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) {
    throw new Error('Invalid speech request id');
  }
  return value;
}

export function registerSpeechIpc(service: SpeechService): void {
  const installOwners = new Map<number, Set<string>>();
  const synthesisOwners = new Map<number, Set<string>>();
  const watched = new WeakSet<WebContents>();

  service.onStatus((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) win.webContents.send('speech:status', status);
    }
  });

  const release = (ownerId: number) => {
    for (const requestId of installOwners.get(ownerId) ?? []) {
      service.cancelInstall(streamKey(ownerId, requestId));
    }
    installOwners.delete(ownerId);
    for (const requestId of synthesisOwners.get(ownerId) ?? []) {
      service.cancelSynthesis(streamKey(ownerId, requestId));
    }
    synthesisOwners.delete(ownerId);
  };

  const watch = (sender: WebContents) => {
    if (watched.has(sender)) return;
    watched.add(sender);
    const ownerId = sender.id;
    sender.once('destroyed', () => release(ownerId));
    sender.on('render-process-gone', () => release(ownerId));
    sender.on('did-navigate', () => release(ownerId));
  };

  const claim = (owners: Map<number, Set<string>>, sender: WebContents, requestId: string) => {
    watch(sender);
    let ids = owners.get(sender.id);
    if (!ids) {
      ids = new Set();
      owners.set(sender.id, ids);
    }
    if (ids.has(requestId)) throw new Error('Duplicate speech request id');
    ids.add(requestId);
  };

  registerTrustedIpcHandler('speech:status', 0, () => service.status());
  registerTrustedIpcHandler('speech:catalog', 0, () => service.catalog());
  registerTrustedIpcHandler('speech:getPreferences', 0, () => service.getPreferences());

  registerTrustedIpcHandler('speech:setPreferences', 1, (_event, value: unknown) => {
    const patch = parseSpeechPreferencesPatch(value);
    if (!patch) throw new Error('Invalid speech preferences');
    return service.setPreferences(patch);
  });

  registerTrustedIpcHandler('speech:prepare', 1, (_event, value: unknown) => {
    const kind = parseSpeechModelKind(value);
    if (!kind) throw new Error('Invalid speech engine kind');
    return service.prepare(kind);
  });

  registerTrustedIpcHandler('speech:removeModel', 1, (_event, value: unknown) => {
    if (!isSpeechModelId(value)) throw new Error('Invalid speech model id');
    return service.removeModel(value);
  });

  registerTrustedIpcHandler(
    'speech:install:start',
    2,
    (event, requestIdValue: unknown, modelIdValue: unknown): void => {
      const requestId = parseRequestId(requestIdValue);
      if (!isSpeechModelId(modelIdValue)) throw new Error('Invalid speech model id');
      const sender = event.sender;
      const ownerId = sender.id;
      claim(installOwners, sender, requestId);
      service.startInstall(
        streamKey(ownerId, requestId),
        modelIdValue,
        (installEvent: SpeechInstallEvent) => {
          if (installEvent.kind !== 'progress') installOwners.get(ownerId)?.delete(requestId);
          if (!sender.isDestroyed()) {
            sender.send('speech:install:event', { requestId, event: installEvent });
          }
        },
      );
    },
  );

  registerTrustedIpcHandler('speech:install:cancel', 1, (event, requestIdValue: unknown): void => {
    const requestId = parseRequestId(requestIdValue);
    if (installOwners.get(event.sender.id)?.has(requestId)) {
      service.cancelInstall(streamKey(event.sender.id, requestId));
    }
  });

  if (service.sttAvailable) {
    registerTrustedIpcHandler('speech:transcribe', 1, (_event, value: unknown) => {
      const request = parseSpeechTranscribeRequest(value);
      if (!request) throw new Error('Invalid transcription request');
      return service.transcribe(request);
    });
  }

  if (service.ttsAvailable) {
    registerTrustedIpcHandler(
      'speech:synthesize:start',
      2,
      (event, requestIdValue: unknown, requestValue: unknown): void => {
        const requestId = parseRequestId(requestIdValue);
        const request = parseSpeechSynthesizeRequest(requestValue);
        if (!request) throw new Error('Invalid synthesis request');
        const sender = event.sender;
        const ownerId = sender.id;
        claim(synthesisOwners, sender, requestId);
        service.startSynthesis(
          streamKey(ownerId, requestId),
          request,
          (synthEvent: SpeechSynthesizeEvent) => {
            if (synthEvent.kind === 'done' || synthEvent.kind === 'error') {
              synthesisOwners.get(ownerId)?.delete(requestId);
            }
            if (!sender.isDestroyed()) {
              sender.send('speech:synthesize:event', { requestId, event: synthEvent });
            }
          },
        );
      },
    );

    registerTrustedIpcHandler(
      'speech:synthesize:cancel',
      1,
      (event, requestIdValue: unknown): void => {
        const requestId = parseRequestId(requestIdValue);
        if (synthesisOwners.get(event.sender.id)?.has(requestId)) {
          service.cancelSynthesis(streamKey(event.sender.id, requestId));
        }
      },
    );
  }
}
