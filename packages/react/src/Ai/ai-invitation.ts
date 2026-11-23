/**
 * ai-invitation — whether to invite the person to turn AI on.
 *
 * AI stays out of sight while it is off, except on a device that can run a
 * model worth having (core `ai-device.ts`: an Apple-silicon Mac with 16 GB,
 * a PC with an 8 GB graphics card, a top phone). There the AI button shows
 * anyway and offers to turn AI on. A browser has no AI host, so it is never
 * invited. Turning AI on, or "Not now", ends the invitation for good: Settings
 * is where to change that mind.
 */

import { useCallback, useEffect, useState } from 'react';
import type { DocBlocksHostAiAPI } from '@bendyline/docblocks/host';

const DISMISSED_KEY = 'docblocks:aiInvitationDismissed';

/**
 * How long after the AI host appears to ask about the device. The answer is
 * not needed at once, and on Windows measuring a graphics card that has gone
 * to sleep takes a couple of seconds.
 */
export const AI_INVITATION_DELAY_MS = 1_500;

export function aiInvitationDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    // Storage that cannot be read cannot remember a dismissal either; not
    // asking is the quieter mistake.
    return true;
  }
}

export function dismissAiInvitation(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // The invitation still goes for this session.
  }
}

/**
 * Whether to invite the person to turn AI on, and a way to stop inviting.
 * True only while AI is off, on a device worth suggesting it on, and until
 * the person answers.
 */
export function useAiInvitation(
  ai: DocBlocksHostAiAPI | undefined,
  delayMs = AI_INVITATION_DELAY_MS,
): { invite: boolean; dismiss: () => void } {
  const [invite, setInvite] = useState(false);

  useEffect(() => {
    if (!ai?.deviceFit || aiInvitationDismissed()) return;
    let cancelled = false;
    // AI on by any route, Settings included, answers the invitation: hosts
    // report `opt-out` exactly while it is off.
    const turnedOn = () => {
      dismissAiInvitation();
      setInvite(false);
    };
    const unsubscribe = ai.onStatus((status) => {
      if (!(status.kind === 'unavailable' && status.reason === 'opt-out')) turnedOn();
    });
    const timer = setTimeout(() => {
      void (async () => {
        const preferences = await ai.getPreferences().catch(() => null);
        if (cancelled || !preferences) return;
        if (preferences.enabled) {
          turnedOn();
          return;
        }
        const fit = await ai.deviceFit?.().catch(() => null);
        if (!cancelled && fit?.suggestAi && !aiInvitationDismissed()) setInvite(true);
      })();
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [ai, delayMs]);

  const dismiss = useCallback(() => {
    dismissAiInvitation();
    setInvite(false);
  }, []);

  return { invite, dismiss };
}
