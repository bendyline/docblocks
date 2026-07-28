/** IPC handler for bounded native clipboard writes. */

import { clipboard } from 'electron';
import { HOST_WIRE_LIMITS, isBoundedString } from '@bendyline/docblocks/host';

import { registerTrustedIpcHandler } from './ipc-authority.js';

export function registerClipboardIpc(): void {
  registerTrustedIpcHandler('clipboard:writeText', 1, (_event, textValue: unknown): void => {
    if (!isBoundedString(textValue, HOST_WIRE_LIMITS.documentCharacters)) {
      throw new Error('Invalid clipboard text');
    }
    clipboard.writeText(textValue);
  });
}
