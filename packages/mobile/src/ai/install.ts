import type { GezelRuntimePlugin } from '@bendyline/gezel-capacitor';
import {
  MobileModelDownloadSchema,
  MobileModelSourceSchema,
} from '@bendyline/gezel/mobile-providers';
import type { AiProgress } from '@bendyline/docblocks/host';
import { catalog, downloads, field, inventory } from './models';
import { checkCancelled, delay, MobileAiError, notify } from './errors';

/** Only installModel's explicit gesture reaches native preparation or network calls. */
export async function install(
  runtime: GezelRuntimePlugin,
  id: string,
  signal: AbortSignal,
  progress?: (value: AiProgress) => void,
  pollMs = 750,
): Promise<string> {
  let downloadId: string | undefined;
  let resolving = false;
  let preparing = false;
  const cancel = async () => {
    if (resolving) await runtime.cancelModelSourceResolution();
    if (preparing) await runtime.cancelProviderPreparation({ providerId: 'android-mlkit' });
    if (downloadId) await runtime.cancelModelDownload({ id: downloadId });
  };
  const onAbort = () => {
    void cancel().catch(() => {
      /* Awaited again in finally. */
    });
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    checkCancelled(signal);
    if (id === 'provider:android-mlkit') {
      const { providers } = await inventory(runtime);
      if (
        !providers.some(
          (p) =>
            p.id === 'android-mlkit' &&
            ['download-required', 'downloading'].includes(p.availability),
        )
      )
        throw new MobileAiError(
          'model-unavailable',
          'The Android system model cannot be prepared on this device.',
        );
      checkCancelled(signal);
      preparing = true;
      notify(progress, {
        phase: 'model',
        message: 'Preparing the Android on-device model…',
        percent: null,
      });
      await runtime.prepareProvider({ providerId: 'android-mlkit' });
      checkCancelled(signal);
      return 'android-mlkit:android-mlkit';
    }
    const model = catalog.find((entry) => entry.id === id);
    if (!model)
      throw new MobileAiError('model-unavailable', 'Choose a model from the on-device catalog.');
    let download = (await downloads(runtime)).find(
      (entry) =>
        entry.source.sha256 === model.source.sha256 &&
        entry.source.revision === model.source.revision,
    );
    checkCancelled(signal);
    if (download?.state === 'complete' && download.modelId) return `llama-cpp:${download.modelId}`;
    if (download && ['paused', 'failed'].includes(download.state)) {
      downloadId = download.id;
      download = MobileModelDownloadSchema.parse(
        field(await runtime.resumeModelDownload({ id: download.id }), 'download'),
      );
    } else if (!download) {
      resolving = true;
      notify(progress, {
        phase: 'resolving',
        message: 'Checking the model download…',
        percent: null,
      });
      const source = MobileModelSourceSchema.parse(
        field(await runtime.resolveModelSource({ source: model.source }), 'source'),
      );
      resolving = false;
      checkCancelled(signal);
      for (const key of Object.keys(model.source) as (keyof typeof model.source)[])
        if (source[key] !== model.source[key])
          throw new Error('The model download identity changed.');
      download = MobileModelDownloadSchema.parse(
        field(await runtime.startModelDownload({ source, name: model.name }), 'download'),
      );
    }
    downloadId = download.id;
    while (true) {
      checkCancelled(signal);
      if (download.state === 'complete' && download.modelId) return `llama-cpp:${download.modelId}`;
      if (download.state === 'failed')
        throw new MobileAiError(
          'model-download-failed',
          download.error ?? 'The model download failed.',
        );
      if (download.state === 'paused')
        throw new MobileAiError(
          'cancelled',
          'The download paused. Keep DocBlocks open and tap Download model to resume.',
        );
      notify(progress, {
        phase: download.state,
        message:
          download.state === 'verifying' ? 'Verifying the model…' : `Downloading ${model.name}…`,
        percent: (100 * download.downloadedBytes) / download.source.sizeBytes,
      });
      await delay(signal, pollMs);
      const next = (await downloads(runtime)).find((entry) => entry.id === downloadId);
      if (!next)
        throw new MobileAiError(
          'model-download-failed',
          'The model download is no longer available.',
        );
      download = next;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) await cancel();
  }
}
