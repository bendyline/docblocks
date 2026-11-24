import { useState } from 'react';
import type { ShellPageContext } from './page-context.js';

/**
 * Documents shared to the phone before it had an Unfiled drawer wait in the
 * device workspace's Inbox folder. This offers them to the drawer, once:
 * "Not now" leaves them where they are for good.
 */
export function PhoneInboxOffer({
  offer,
  here = false,
}: {
  offer: NonNullable<ShellPageContext['phoneInbox']>;
  /** Shown on the drawer's own page, where "here" names it. */
  here?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const { count, drawerName } = offer;
  const destination = here ? 'here' : `to ${drawerName}`;
  return (
    <section className="db-page-offer" aria-label="Shared to this phone earlier">
      <p className="db-page-offer-text">
        {count === 1
          ? 'A document shared to this phone earlier is waiting in its Inbox folder.'
          : `${count} documents shared to this phone earlier are waiting in its Inbox folder.`}
      </p>
      <div className="db-page-offer-actions">
        <button
          type="button"
          className="db-page-primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void offer.fileAll().finally(() => setBusy(false));
          }}
        >
          {count === 1 ? `Move it ${destination}` : `Move them ${destination}`}
        </button>
        <button type="button" className="db-page-link" disabled={busy} onClick={offer.decline}>
          Not now
        </button>
      </div>
    </section>
  );
}
