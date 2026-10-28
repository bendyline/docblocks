/**
 * The speech session behind the Dictation and Narration sections of the app
 * Settings dialog: status, catalog, preferences, a download in progress and a
 * voice preview, shared so both sections stay in step.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DocBlocksHostSpeechAPI,
  SpeechCatalog,
  SpeechError,
  SpeechInstallHandle,
  SpeechModelInfo,
  SpeechModelKind,
  SpeechPreferences,
  SpeechProgress,
  SpeechStatus,
  SpeechSynthesisHandle,
} from '@bendyline/docblocks/host';
import { ProgressivePlayer } from '../Speech/progressive-player.js';

const PREVIEW_TEXT = 'This is how I sound when I read your documents aloud.';

/** The host could not answer at all; the controls it would have filled cannot be drawn. */
function unreachable(cause: unknown): SpeechError {
  const detail = cause instanceof Error ? cause.message : undefined;
  return {
    code: 'unknown',
    message: 'DocBlocks could not check speech on this computer.',
    ...(detail ? { detail } : {}),
  };
}

export interface SpeechFailure {
  readonly error: SpeechError;
  /** The section whose model or voice failed; absent when it affects both. */
  readonly kind?: SpeechModelKind;
}

export interface SpeechSettingsSession {
  readonly speech: DocBlocksHostSpeechAPI;
  readonly status: SpeechStatus | null;
  readonly catalog: SpeechCatalog | null;
  readonly preferences: SpeechPreferences | null;
  readonly installing: { readonly id: string; readonly progress: SpeechProgress | null } | null;
  readonly failure: SpeechFailure | null;
  readonly previewing: boolean;
  readonly install: (model: SpeechModelInfo) => Promise<void>;
  readonly cancelInstall: () => void;
  readonly remove: (model: SpeechModelInfo) => Promise<void>;
  readonly update: (patch: Partial<SpeechPreferences>) => Promise<void>;
  /** Follow the speed slider while it moves; `update` saves the value on release. */
  readonly setSpeedDraft: (speed: number) => void;
  readonly startPreview: () => void;
  readonly stopPreview: () => void;
}

/**
 * One speech session for as long as the calling component is mounted, or
 * `null` when the host has no speech API. Unmounting cancels a download or
 * preview still in progress.
 */
export function useSpeechSettings(
  speech: DocBlocksHostSpeechAPI | undefined,
): SpeechSettingsSession | null {
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [catalog, setCatalog] = useState<SpeechCatalog | null>(null);
  const [preferences, setPreferences] = useState<SpeechPreferences | null>(null);
  const [installing, setInstalling] = useState<SpeechSettingsSession['installing']>(null);
  const [failure, setFailure] = useState<SpeechFailure | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const mounted = useRef(true);
  const installHandle = useRef<SpeechInstallHandle | null>(null);
  const preview = useRef<{ handle: SpeechSynthesisHandle; player: ProgressivePlayer } | null>(null);

  const refresh = useCallback(async () => {
    if (!speech) return;
    try {
      const [nextStatus, nextCatalog] = await Promise.all([speech.status(), speech.catalog()]);
      if (!mounted.current) return;
      setStatus(nextStatus);
      if (nextCatalog.ok) setCatalog(nextCatalog.value);
      else setFailure({ error: nextCatalog.error });
    } catch (cause) {
      if (mounted.current) setFailure({ error: unreachable(cause) });
    }
  }, [speech]);

  const stopPreview = useCallback(() => {
    preview.current?.handle.cancel();
    preview.current?.player.dispose();
    preview.current = null;
    setPreviewing(false);
  }, []);

  useEffect(() => {
    if (!speech) return;
    mounted.current = true;
    const unsubscribe = speech.onStatus((next) => {
      if (!mounted.current) return;
      setStatus(next);
      void speech.catalog().then((result) => {
        if (mounted.current && result.ok) setCatalog(result.value);
      });
    });
    void refresh();
    void speech.getPreferences().then(
      (initial) => {
        if (mounted.current) setPreferences(initial);
      },
      (cause: unknown) => {
        if (mounted.current) setFailure({ error: unreachable(cause) });
      },
    );
    return () => {
      mounted.current = false;
      installHandle.current?.cancel();
      preview.current?.handle.cancel();
      preview.current?.player.dispose();
      unsubscribe();
    };
  }, [refresh, speech]);

  const install = useCallback(
    async (model: SpeechModelInfo) => {
      if (!speech) return;
      setFailure(null);
      setInstalling({ id: model.id, progress: null });
      const handle = speech.installModel(model.id, (progress) => {
        if (mounted.current) setInstalling({ id: model.id, progress });
      });
      installHandle.current = handle;
      try {
        const result = await handle.done;
        if (!mounted.current) return;
        if (!result.ok && result.error.code !== 'cancelled') {
          setFailure({ error: result.error, kind: model.kind });
        }
        await refresh();
      } finally {
        if (installHandle.current === handle) installHandle.current = null;
        if (mounted.current) setInstalling(null);
      }
    },
    [refresh, speech],
  );

  const cancelInstall = useCallback(() => installHandle.current?.cancel(), []);

  const remove = useCallback(
    async (model: SpeechModelInfo) => {
      if (!speech) return;
      setFailure(null);
      const result = await speech.removeModel(model.id);
      if (!mounted.current) return;
      if (!result.ok) setFailure({ error: result.error, kind: model.kind });
      await refresh();
    },
    [refresh, speech],
  );

  const update = useCallback(
    async (patch: Partial<SpeechPreferences>) => {
      if (!speech) return;
      try {
        const next = await speech.setPreferences(patch);
        if (mounted.current) setPreferences(next);
      } catch {
        // The control snaps back to the stored preference on the next render.
      }
    },
    [speech],
  );

  const setSpeedDraft = useCallback((speed: number) => {
    setPreferences((current) => (current ? { ...current, speed } : current));
  }, []);

  const startPreview = useCallback(() => {
    const synthesize = speech?.synthesize;
    if (!synthesize) return;
    stopPreview();
    const player = ProgressivePlayer.create(() => undefined);
    if (!player) return;
    // Prime inside the click so audio is allowed to start later.
    player.prime();
    setPreviewing(true);
    const handle = synthesize({ text: PREVIEW_TEXT }, (event) => {
      if (event.kind === 'chunk') {
        player.append(event.chunk);
        void player.play();
      } else if (event.kind === 'done') {
        player.finish();
      }
    });
    preview.current = { handle, player };
    void handle.done.then((result) => {
      if (!mounted.current || preview.current?.handle !== handle) return;
      if (!result.ok && result.error.code !== 'cancelled') {
        setFailure({ error: result.error, kind: 'tts' });
      }
      // Leave the player to finish speaking; it is disposed on the next preview.
      setPreviewing(false);
    });
  }, [speech, stopPreview]);

  if (!speech) return null;
  return {
    speech,
    status,
    catalog,
    preferences,
    installing,
    failure,
    previewing,
    install,
    cancelInstall,
    remove,
    update,
    setSpeedDraft,
    startPreview,
    stopPreview,
  };
}
