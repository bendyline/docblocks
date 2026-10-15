import { useEffect, useState } from 'react';
import type { DocBlocksHostSpeechAPI, SpeechStatus } from '@bendyline/docblocks/host';

/** The host's speech readiness, kept current as models download or go away. */
export function useSpeechStatus(speech: DocBlocksHostSpeechAPI): SpeechStatus | null {
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  useEffect(() => {
    let live = true;
    const unsubscribe = speech.onStatus((next) => {
      if (live) setStatus(next);
    });
    void speech.status().then(
      (initial) => {
        if (live) setStatus((current) => current ?? initial);
      },
      () => {
        // Settings cannot do more than report the same failure, so don't send
        // people there to fix it.
        const readiness = {
          state: 'unavailable' as const,
          reason: 'DocBlocks could not check speech on this computer.',
        };
        if (live) setStatus((current) => current ?? { stt: readiness, tts: readiness });
      },
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, [speech]);
  return status;
}
