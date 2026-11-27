import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MediaProvider } from '@bendyline/squisq/schemas';
import type {
  DocumentSession,
  DocumentSessionEvent,
  DocumentSessionSnapshot,
} from '@bendyline/docblocks/document';
import {
  conflictCopyHash,
  readConflictCopy,
  removeConflictCopy,
  writeConflictCopy,
  type ConflictCopy,
  type ConflictCopyScope,
  type FileSystemProvider,
} from '@bendyline/docblocks/filesystem';
import { DocumentSessionNotice, DocumentVersionsNotice } from './DocumentVersionsNotice.js';
import { describeOrigin, keptVersionFileName } from './document-versions.js';
import { useDocumentVersions } from './useDocumentVersions.js';

const DocumentVersionsDialog = lazy(() => import('./DocumentVersionsDialog.js'));

/** Long enough to read and reach for Undo; short enough not to linger over the page. */
const MERGE_NOTICE_MS = 12_000;
const NOTICE_MS = 6_000;
/** How soon to offer a set-aside version to the session again after "not now". */
const ABSORB_RETRY_MS = 1_000;
/** Tries at a version that storage will not hand over or let go, before it is simply shown. */
const ABSORB_ATTEMPTS = 4;
/** How long a session may be on something else before waiting versions are shown anyway. */
const UNRECOGNISED_SESSION_MS = 5_000;
const NO_PATHS: ReadonlySet<string> = new Set();

export interface DocumentVersionsLayerProps {
  provider: FileSystemProvider | null;
  session: Pick<
    DocumentSession,
    'subscribeEvents' | 'getSnapshot' | 'replaceContent' | 'absorbConcurrentVersion'
  >;
  snapshot: DocumentSessionSnapshot;
  /** The open document as the user sees it; null for an image or no document. */
  documentPath: string | null;
  /** The Markdown the session edits when that is another file (an outside-in source). */
  sourcePath?: string | null;
  theme: 'light' | 'dark';
  defaultThemeId?: string;
  mediaProvider?: MediaProvider | null;
  /** Re-list stored versions on this cadence where storage reports no changes itself. */
  heartbeatMs?: number | null;
  /**
   * Show the session what storage holds for the document now; resolves when
   * it has. Asked before a set-aside version is cleared as already included.
   */
  checkDocument?: () => Promise<void>;
  /** A version was saved as a new document beside the open one. */
  onDocumentCreated?: (path: string) => void;
  /** How many versions of the open document wait for review. */
  onCountChange?: (count: number) => void;
  /** Something the user asked for here could not be done. */
  onError?: (message: string) => void;
}

interface Notice {
  readonly id: number;
  readonly message: string;
  /** The latest merge the session made by itself. */
  readonly merge?: Extract<DocumentSessionEvent, { type: 'merged' }>;
  /** How many merges this notice stands for; they can land seconds apart. */
  readonly merges?: number;
  /** Content hashes of the texts kept from before those merges. */
  readonly kept?: readonly string[];
  /** A version the user chose to use in place of the document, and the text it replaced. */
  readonly replaced?: {
    readonly targetKey: string;
    readonly previousContent: string;
    readonly content: string;
    readonly copy: ConflictCopy;
  };
}

function baseName(path: string): string {
  return path.slice(path.replace(/\\/g, '/').lastIndexOf('/') + 1);
}

function comparable(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

/** Whether the session's open target is the document this layer was given. */
function targetIsDocument(targetKey: string | null, documentPath: string | null): boolean {
  if (!targetKey || !documentPath) return false;
  const path = comparable(documentPath);
  return targetKey.endsWith(`:${path}`) || targetKey.endsWith(`:/${path}`);
}

function withinScope(copy: ConflictCopy, scope: ConflictCopyScope): boolean {
  return comparable(copy.path).startsWith(`${comparable(scope.directory)}/`);
}

/**
 * Everything the shell shows about versions of the open document that are
 * not the document itself: the notice and review dialog for versions set
 * aside in its sidecar, and what the session just did by itself (combined
 * edits, set text aside, took a newer version), with Undo for a merge.
 *
 * A version a sync service set aside is first offered to the session, which
 * combines it with the text here when the two changed different parts and it
 * knows what both started from. Only the versions it could not combine are
 * shown for review, and not even those when the same text is already kept
 * from before a merge: that one has been dealt with, here or on another
 * device.
 *
 * A save conflict that needs a decision is not handled here; the conflict
 * banner owns it, and this layer keeps quiet while one is open.
 */
export function DocumentVersionsLayer({
  provider,
  session,
  snapshot,
  documentPath,
  sourcePath = null,
  theme,
  defaultThemeId,
  mediaProvider,
  heartbeatMs = null,
  checkDocument,
  onDocumentCreated,
  onCountChange,
  onError,
}: DocumentVersionsLayerProps) {
  const versions = useDocumentVersions({
    provider,
    documentPath,
    sourcePath,
    // A merge, an adopted outside version and a chosen version all remount the
    // editor. A conflict appearing is a moment to look too: when a sync service
    // swapped the file, it set this device's save aside at the same instant.
    refreshToken: `${snapshot.generation}:${snapshot.conflict ? 'conflict' : ''}`,
    heartbeatMs,
  });
  const { scope, copies, undoCopies, refresh } = versions;
  const [reviewing, setReviewing] = useState(false);
  // Hashes of kept texts the user asked to look at after a merge, or null.
  const [reviewingCombined, setReviewingCombined] = useState<readonly string[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeId = useRef(0);
  const documentPathRef = useRef(documentPath);
  documentPathRef.current = documentPath;

  // Paths of set-aside versions the session could not combine: these need a person.
  const [needsReview, setNeedsReview] = useState<ReadonlySet<string>>(NO_PATHS);
  const absorbing = useRef(false);
  const absorbRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const absorbAttempts = useRef(new Map<string, number>());
  // How often each version was told "not now", so that waiting ones take turns.
  const absorbTurns = useRef(new Map<string, number>());
  const absorbTexts = useRef(new Map<string, string>());
  // What each waiting version was last offered against: once the document
  // changes, or the same text turns up among the kept ones, what could not be
  // combined may have become something there is nothing left to decide about.
  const judgedAt = useRef(new Map<string, string>());
  // Versions this layer already took away, in case a listing still shows them.
  const cleared = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (absorbRetry.current) clearTimeout(absorbRetry.current);
    };
  }, []);
  useEffect(() => {
    setNeedsReview(NO_PATHS);
    setReviewingCombined(null);
    absorbAttempts.current.clear();
    absorbTurns.current.clear();
    absorbTexts.current.clear();
    judgedAt.current.clear();
    cleared.current.clear();
  }, [documentPath, sourcePath]);

  const { undecided, reviewable } = useMemo(() => {
    // For one render after a switch the list can still be the last document's.
    const own = scope ? copies.filter((copy) => withinScope(copy, scope)) : [];
    return {
      undecided: own.filter((copy) => copy.origin === 'sync' && !needsReview.has(copy.path)),
      reviewable: own.filter((copy) => copy.origin !== 'sync' || needsReview.has(copy.path)),
    };
  }, [copies, needsReview, scope]);
  // Texts kept from before a merge or a replacement, by content. A set-aside
  // version with the same content was one side of that, so it is settled.
  const keptHashes = useMemo(() => {
    const own = scope ? undoCopies.filter((copy) => withinScope(copy, scope)) : [];
    return new Set(own.map((copy) => copy.hash));
  }, [undoCopies, scope]);
  const sessionOnDocument = targetIsDocument(snapshot.targetKey, documentPath);
  // Offered even while a conflict is open: the session will not combine one
  // then, but a set-aside copy of its own save tells it how to settle the
  // conflict (the version in storage was written at the same time, not after).
  const canAbsorb = sessionOnDocument;

  const absorbState = {
    provider,
    scope,
    undecided,
    reviewable,
    canAbsorb,
    keptHashes,
    checkDocument,
    targetKey: snapshot.targetKey,
    generation: snapshot.generation,
    // A version the user is looking at is not changed under them.
    looking: reviewing,
  };
  const absorbInput = useRef(absorbState);
  absorbInput.current = absorbState;
  const absorbNext = useRef<() => void>(() => undefined);
  absorbNext.current = () => {
    if (absorbing.current || !mounted.current) return;
    const input = absorbInput.current;
    const { provider: storage, scope: where, targetKey, generation } = input;
    if (!storage || !where || !targetKey || !input.canAbsorb) return;
    const waiting = (copy: ConflictCopy) => !cleared.current.has(copy.path);
    const kept = (copy: ConflictCopy) => input.keptHashes.has(copy.hash);
    const judged = (copy: ConflictCopy) => `${generation}:${kept(copy) ? 'kept' : ''}`;
    const turns = (copy: ConflictCopy) => absorbTurns.current.get(copy.path) ?? 0;
    // The one that has waited through the fewest turns goes first, so a
    // version that must wait does not keep the others from being heard.
    const nextUndecided = input.undecided
      .filter(waiting)
      .reduce<
        ConflictCopy | undefined
      >((first, copy) => (first === undefined || turns(copy) < turns(first) ? copy : first), undefined);
    const next =
      nextUndecided ??
      (input.looking
        ? undefined
        : input.reviewable.find(
            (copy) =>
              copy.origin === 'sync' &&
              waiting(copy) &&
              judgedAt.current.get(copy.path) !== judged(copy),
          ));
    if (!next) return;
    absorbing.current = true;
    if (absorbRetry.current) clearTimeout(absorbRetry.current);
    absorbRetry.current = null;
    const show = () => {
      judgedAt.current.set(next.path, judged(next));
      setNeedsReview((current) =>
        current.has(next.path) ? current : new Set(current).add(next.path),
      );
    };
    // Typing can go on for minutes, so "not now" is asked again without limit;
    // storage that will not answer is not.
    const again = (counted: boolean) => {
      if (counted) {
        const attempts = (absorbAttempts.current.get(next.path) ?? 0) + 1;
        absorbAttempts.current.set(next.path, attempts);
        if (attempts >= ABSORB_ATTEMPTS) {
          show();
          return;
        }
      }
      absorbTurns.current.set(next.path, turns(next) + 1);
      // Others that have not had this turn yet are asked straight away.
      const othersFirst = input.undecided.some(
        (copy) => copy.path !== next.path && waiting(copy) && turns(copy) < turns(next),
      );
      absorbRetry.current = setTimeout(
        () => {
          absorbRetry.current = null;
          absorbNext.current();
        },
        othersFirst ? 0 : ABSORB_RETRY_MS,
      );
    };
    const run = async (): Promise<void> => {
      let content = absorbTexts.current.get(next.path) ?? null;
      if (content === null) {
        try {
          content = await readConflictCopy(storage, next);
        } catch {
          again(true);
          return;
        }
        // Not text, or gone: nothing the session can do with it.
        if (content === null) {
          show();
          return;
        }
        absorbTexts.current.set(next.path, content);
      }
      const text = content;
      const offer = () =>
        session.absorbConcurrentVersion({
          targetKey,
          content: text,
          savedAt: next.capturedAt,
          origin: { ...(next.label ? { savedBy: next.label } : {}), modifiedAt: next.capturedAt },
        });
      // The same text is already kept from before a merge or a replacement:
      // it was one side of that, on this device or another, and asking about
      // it again would be asking about something already decided.
      const settledBefore = kept(next) && conflictCopyHash(text) === next.hash;
      let result = await offer();
      if (result === 'included' || (result === 'review' && settledBefore)) {
        // Clearing takes away the only set-aside copy of this text. A sync
        // service sets a save aside at the moment it replaces it in the
        // document, so "the session still has this" can mean it has not seen
        // the replacement yet. Show it what storage holds, then ask again: a
        // save of its own that was replaced is then put back, not dropped.
        await input.checkDocument?.().catch(() => undefined);
        result = await offer();
      }
      if (result === 'review' && !settledBefore) {
        show();
        return;
      }
      if (result === 'later') {
        again(false);
        return;
      }
      try {
        // Its changes are in the document now. Like the text from before the
        // merge, the version itself stays for a week in case that was wrong.
        if (result === 'merged') {
          await writeConflictCopy(storage, where, content, {
            origin: 'premerge',
            label: next.label,
          });
        }
        await removeConflictCopy(storage, where, next);
      } catch {
        again(true);
        return;
      }
      cleared.current.add(next.path);
      await refresh();
    };
    void run()
      .catch(() => show())
      .finally(() => {
        absorbing.current = false;
        // On to the next one, unless this one is waiting to be asked again.
        if (mounted.current && !absorbRetry.current) setTimeout(() => absorbNext.current(), 0);
      });
  };
  useEffect(() => {
    absorbNext.current();
  }, [undecided, reviewable, canAbsorb, reviewing, snapshot.generation, keptHashes]);
  // A session that settled on something this layer does not recognise as the
  // document will never be asked; show what is waiting instead of hiding it.
  useEffect(() => {
    if (undecided.length === 0 || sessionOnDocument || !snapshot.targetKey) return;
    const timer = setTimeout(() => {
      setNeedsReview((current) => {
        const next = new Set(current);
        for (const copy of undecided) next.add(copy.path);
        return next;
      });
    }, UNRECOGNISED_SESSION_MS);
    return () => clearTimeout(timer);
  }, [undecided, sessionOnDocument, snapshot.targetKey]);

  useEffect(() => {
    onCountChange?.(reviewable.length);
  }, [reviewable.length, onCountChange]);
  useEffect(() => {
    if (reviewable.length === 0) setReviewing(false);
  }, [reviewable.length]);

  useEffect(
    () =>
      session.subscribeEvents((event) => {
        const id = ++noticeId.current;
        if (event.type === 'merged') {
          // Two devices typing hand each other several saves in a row; one
          // notice that counts them is calmer than one that keeps changing.
          setNotice((current) => {
            const earlier =
              current?.merge && current.merge.targetKey === event.targetKey ? current : null;
            const merges = (earlier?.merges ?? 0) + 1;
            return {
              id,
              message:
                merges === 1
                  ? `Combined your edits with changes from ${describeOrigin(event.externalOrigin)}.`
                  : `Combined your edits with ${merges.toLocaleString()} other versions.`,
              merge: event,
              merges,
              kept: [
                ...(earlier?.kept ?? []),
                conflictCopyHash(event.localContent),
                conflictCopyHash(event.externalContent),
              ],
            };
          });
        } else if (event.type === 'parked') {
          // This fires as the user leaves, while the path is still the old one.
          const name = documentPathRef.current ? baseName(documentPathRef.current) : null;
          setNotice({
            id,
            message: name
              ? `Your unsaved version of ${name} was set aside. Review it any time.`
              : 'Your unsaved version was set aside. Review it any time.',
          });
        } else if (event.externalOrigin?.savedBy) {
          // Without a name there is nothing to tell that the page does not already show.
          setNotice({ id, message: `Updated with changes from ${event.externalOrigin.savedBy}.` });
        }
      }),
    [session],
  );
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(
      () => setNotice((current) => (current?.id === notice.id ? null : current)),
      notice.merge || notice.replaced ? MERGE_NOTICE_MS : NOTICE_MS,
    );
    return () => clearTimeout(timer);
  }, [notice]);
  // Undo puts back the text from before, so it is only on offer while the
  // text that replaced it is still exactly what the document holds. After
  // several merges in a row there is no single "before": Review has them all.
  const undoable =
    notice?.merge && (notice.merges ?? 1) === 1
      ? { targetKey: notice.merge.targetKey, content: notice.merge.mergedContent }
      : notice?.replaced
        ? { targetKey: notice.replaced.targetKey, content: notice.replaced.content }
        : null;
  const canUndo =
    undoable !== null &&
    snapshot.targetKey === undoable.targetKey &&
    snapshot.content === undoable.content &&
    snapshot.conflict === null;

  const undo = useCallback(async () => {
    const merge = notice?.merge && (notice.merges ?? 1) === 1 ? notice.merge : undefined;
    const replaced = notice?.replaced;
    setNotice(null);
    const expected = merge
      ? { targetKey: merge.targetKey, content: merge.mergedContent }
      : replaced
        ? { targetKey: replaced.targetKey, content: replaced.content }
        : null;
    if (!expected) return;
    const current = session.getSnapshot();
    if (
      current.targetKey !== expected.targetKey ||
      current.conflict ||
      current.content !== expected.content
    ) {
      return;
    }
    try {
      if (merge) {
        // The other side's version must not vanish with the merge: keep it for
        // review. Not as a version a sync service set aside, which this device
        // and the others would only combine again.
        if (provider && scope) {
          await writeConflictCopy(provider, scope, merge.externalContent, {
            origin: 'local',
            label: merge.externalOrigin?.savedBy,
            currentContent: merge.localContent,
          });
        }
        await session.replaceContent(merge.localContent);
      } else if (replaced) {
        // Back to where the user was: their text in the document, the version
        // waiting. A version a sync service set aside comes back as one the
        // user turned down, so that nothing combines or clears it by itself.
        if (provider && scope) {
          await writeConflictCopy(provider, scope, replaced.content, {
            origin: replaced.copy.origin === 'sync' ? 'local' : replaced.copy.origin,
            label: replaced.copy.label,
            capturedAt: replaced.copy.capturedAt,
            currentContent: replaced.previousContent,
          });
        }
        await session.replaceContent(replaced.previousContent);
      }
      await refresh();
    } catch {
      onError?.(
        merge
          ? 'Could not undo that. The combined version is still open.'
          : 'Could not undo that. The version you chose is still open.',
      );
    }
  }, [notice, onError, provider, refresh, scope, session]);

  const readVersion = useCallback(
    (copy: ConflictCopy) => (provider ? readConflictCopy(provider, copy) : Promise.resolve(null)),
    [provider],
  );

  const applyVersion = useCallback(
    async (copy: ConflictCopy, content: string): Promise<boolean> => {
      if (!provider || !scope) return false;
      const current = session.getSnapshot();
      if (!current.targetKey || current.conflict) return false;
      const previousContent = current.content;
      if (previousContent !== content) {
        // The text being replaced stays available for a week, never dropped.
        await writeConflictCopy(provider, scope, previousContent, { origin: 'premerge' });
        await session.replaceContent(content);
      }
      await removeConflictCopy(provider, scope, copy);
      await refresh();
      if (previousContent !== content) {
        setNotice({
          id: ++noticeId.current,
          message: 'The document now holds that version in place of your text.',
          replaced: { targetKey: current.targetKey, previousContent, content, copy },
        });
      }
      return true;
    },
    [provider, refresh, scope, session],
  );

  const discardVersion = useCallback(
    async (copy: ConflictCopy): Promise<boolean> => {
      if (!provider || !scope) return false;
      await removeConflictCopy(provider, scope, copy);
      await refresh();
      return true;
    },
    [provider, refresh, scope],
  );

  const keepBoth = useCallback(
    async (copy: ConflictCopy, content: string): Promise<boolean> => {
      if (!provider || !scope || !documentPath) return false;
      const normalized = documentPath.replace(/\\/g, '/');
      const slash = normalized.lastIndexOf('/');
      const parent = slash < 0 ? '' : normalized.slice(0, slash);
      const siblings = await provider.readDirectory(parent || '/');
      const name = keptVersionFileName(
        baseName(normalized),
        copy,
        new Set(siblings.map((entry) => entry.name)),
      );
      const path = slash < 0 ? name : `${parent}/${name}`;
      await provider.writeFile(path, content);
      await removeConflictCopy(provider, scope, copy);
      await refresh();
      onDocumentCreated?.(path);
      return true;
    },
    [documentPath, onDocumentCreated, provider, refresh, scope],
  );

  // The texts kept from before the merges a notice (or the open review) is about.
  const keptFor = useCallback(
    (hashes: readonly string[] | null | undefined) =>
      hashes && scope
        ? undoCopies.filter((copy) => withinScope(copy, scope) && hashes.includes(copy.hash))
        : [],
    [scope, undoCopies],
  );
  const noticeKept = keptFor(notice?.kept);
  const combinedCopies = keptFor(reviewingCombined);
  useEffect(() => {
    if (reviewingCombined && combinedCopies.length === 0) setReviewingCombined(null);
  }, [combinedCopies.length, reviewingCombined]);

  const quiet = snapshot.conflict !== null || !snapshot.targetKey || !documentPath;
  const canReviewCombined = !quiet && notice?.merge !== undefined && noticeKept.length > 0;
  return (
    <>
      {notice && !reviewingCombined && (
        <DocumentSessionNotice
          message={notice.message}
          actionLabel={canUndo ? 'Undo' : undefined}
          onAction={canUndo ? () => void undo() : undefined}
          secondaryLabel={canReviewCombined ? 'Review' : undefined}
          onSecondary={
            canReviewCombined
              ? () => {
                  setReviewingCombined(notice.kept ?? null);
                  setNotice(null);
                }
              : undefined
          }
          onDismiss={() => setNotice(null)}
        />
      )}
      {!quiet && !reviewing && !reviewingCombined && (
        <DocumentVersionsNotice count={reviewable.length} onReview={() => setReviewing(true)} />
      )}
      {!quiet && reviewingCombined && combinedCopies.length > 0 && (
        <Suspense fallback={<div role="status">Loading versions…</div>}>
          <DocumentVersionsDialog
            kind="combined"
            copies={combinedCopies}
            currentContent={snapshot.content}
            fileName={sourcePath ?? documentPath ?? ''}
            theme={theme}
            defaultThemeId={defaultThemeId}
            mediaProvider={mediaProvider}
            readVersion={readVersion}
            onUse={applyVersion}
            onDiscard={discardVersion}
            onKeepBoth={scope?.source ? undefined : keepBoth}
            onClose={() => setReviewingCombined(null)}
          />
        </Suspense>
      )}
      {!quiet && reviewing && !reviewingCombined && reviewable.length > 0 && (
        <Suspense fallback={<div role="status">Loading versions…</div>}>
          <DocumentVersionsDialog
            copies={reviewable}
            currentContent={snapshot.content}
            fileName={sourcePath ?? documentPath ?? ''}
            theme={theme}
            defaultThemeId={defaultThemeId}
            mediaProvider={mediaProvider}
            readVersion={readVersion}
            onUse={applyVersion}
            onDiscard={discardVersion}
            // A version of a published page's source cannot stand alone as a document.
            onKeepBoth={scope?.source ? undefined : keepBoth}
            onClose={() => setReviewing(false)}
          />
        </Suspense>
      )}
    </>
  );
}
