import type { WebContents } from 'electron';

const revocationsByOwner = new WeakMap<WebContents, Set<() => void>>();

/**
 * Revoke owner-scoped capabilities when their renderer navigates, crashes, or
 * is destroyed. Registering the same callback repeatedly is idempotent.
 */
export function bindOwnerGrantRevocation(owner: WebContents, callback: () => void): void {
  let callbacks = revocationsByOwner.get(owner);
  if (!callbacks) {
    callbacks = new Set();
    revocationsByOwner.set(owner, callbacks);
    const revoke = () => {
      for (const current of revocationsByOwner.get(owner) ?? []) current();
    };
    owner.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      // Hash/history navigation keeps the same renderer document and therefore
      // the same capability owner. Revoking on those in-place navigations
      // strands live provider clients with main-side records that disappeared.
      if (isMainFrame && !isInPlace) revoke();
    });
    owner.once('render-process-gone', revoke);
    owner.once('destroyed', revoke);
  }
  callbacks.add(callback);
}
