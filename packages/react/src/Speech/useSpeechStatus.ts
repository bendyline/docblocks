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
    void speech.status().then((initial) => {
      if (live) setStatus((current) => current ?? initial);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [speech]);
  return status;
}
