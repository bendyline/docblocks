import type { DocumentSession } from '@bendyline/docblocks/document';
import type { HostPrepareCloseRequest, HostPrepareCloseResult } from '@bendyline/docblocks/host';

/** Suspension has a deadline and must leave the mounted session editable on resume. */
export async function prepareHostLifecycle(
  session: DocumentSession,
  request: HostPrepareCloseRequest,
): Promise<HostPrepareCloseResult> {
  if (request.reason !== 'app-background') {
    const snapshot = await session.prepareClose();
    return { status: 'ready', persistedRevision: snapshot.persistedRevision };
  }
  const remaining = Math.max(0, Math.min(request.deadline - Date.now(), 5_000));
  if (remaining === 0)
    return {
      status: 'blocked',
      code: 'not-ready',
      message: 'The app was suspended before saving finished.',
    };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      session.flush('close').then(
        (snapshot): HostPrepareCloseResult => ({
          status: 'ready',
          persistedRevision: snapshot.persistedRevision,
        }),
      ),
      new Promise<HostPrepareCloseResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              status: 'blocked',
              code: 'not-ready',
              message: 'Saving will resume when the app returns.',
            }),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
