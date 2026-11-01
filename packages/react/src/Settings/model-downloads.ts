import { useSyncExternalStore } from 'react';
import type {
  AiImageModel,
  AiImageStyle,
  AiImagesAPI,
  AiModelDownloadInfo,
  AiProgress,
  DocBlocksHostAiAPI,
  DocBlocksHostSpeechAPI,
  SpeechModelInfo,
  SpeechProgress,
} from '@bendyline/docblocks/host';

interface DownloadHandle<Value> {
  readonly done: Promise<
    | { readonly ok: true; readonly value: Value }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  >;
  cancel(): void;
}

interface DownloadSnapshot<Item, Progress> {
  readonly active: { readonly item: Item; readonly progress: Progress | null } | null;
  readonly failure: { readonly item: Item; readonly message: string } | null;
  /** Changes only on settlement, so inventory reads never run for every progress event. */
  readonly completed: number;
}

/**
 * A host bridge owns a download for the lifetime of this renderer. Settings
 * only subscribes: closing a dialog or switching tabs must not abort the host
 * operation or lose its progress/error. Renderer teardown remains the host's
 * cancellation boundary.
 */
class ModelDownload<Item, Progress> {
  private snapshot: DownloadSnapshot<Item, Progress> = {
    active: null,
    failure: null,
    completed: 0,
  };
  private readonly listeners = new Set<() => void>();
  private handle: { cancel(): void } | null = null;
  private operation: object | null = null;

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly cancel = () => this.handle?.cancel();

  async start<Value>(
    item: Item,
    start: (progress: (value: Progress) => void) => DownloadHandle<Value>,
    onSuccess?: (value: Value) => Promise<void>,
  ): Promise<void> {
    if (this.operation) return;
    const operation = {};
    this.operation = operation;
    this.publish({ ...this.snapshot, active: { item, progress: null }, failure: null });
    try {
      const handle = start((progress) => {
        if (this.operation === operation)
          this.publish({ ...this.snapshot, active: { item, progress } });
      });
      this.handle = handle;
      const result = await handle.done;
      if (result.ok) await onSuccess?.(result.value);
      else if (result.error.code !== 'cancelled') {
        this.publish({ ...this.snapshot, failure: { item, message: result.error.message } });
      }
    } catch (cause) {
      this.publish({
        ...this.snapshot,
        failure: {
          item,
          message: cause instanceof Error ? cause.message : 'The model download failed.',
        },
      });
    } finally {
      this.handle = null;
      this.operation = null;
      this.publish({ ...this.snapshot, active: null, completed: this.snapshot.completed + 1 });
    }
  }

  private publish(snapshot: DownloadSnapshot<Item, Progress>): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function sessionFor<Owner extends object, Item, Progress>(
  sessions: WeakMap<Owner, ModelDownload<Item, Progress>>,
  owner: Owner,
): ModelDownload<Item, Progress> {
  let session = sessions.get(owner);
  if (!session) {
    session = new ModelDownload<Item, Progress>();
    sessions.set(owner, session);
  }
  return session;
}

const text = new WeakMap<DocBlocksHostAiAPI, ModelDownload<AiModelDownloadInfo, AiProgress>>();
const image = new WeakMap<
  AiImagesAPI,
  ModelDownload<
    {
      kind: 'model' | 'style';
      model: AiImageModel | AiImageStyle;
    },
    AiProgress
  >
>();
const speech = new WeakMap<
  DocBlocksHostSpeechAPI,
  ModelDownload<SpeechModelInfo, SpeechProgress>
>();
const noSpeech = new ModelDownload<SpeechModelInfo, SpeechProgress>();

export const textModelDownloads = (api: DocBlocksHostAiAPI) => sessionFor(text, api);
export const imageModelDownloads = (api: AiImagesAPI) => sessionFor(image, api);
export const speechModelDownloads = (api: DocBlocksHostSpeechAPI | undefined) =>
  api ? sessionFor(speech, api) : noSpeech;

export function useModelDownload<Item, Progress>(session: ModelDownload<Item, Progress>) {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}
