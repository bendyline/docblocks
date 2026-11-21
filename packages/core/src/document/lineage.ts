/**
 * What a document session remembers of the texts it has held, so that a
 * version saved somewhere else at the same moment can be combined with the
 * text here.
 *
 * A sync service that receives two saves made without sight of each other
 * keeps one as the document and sets the other aside. It does not say what
 * both started from, and combining them safely needs exactly that. A session
 * knows its own half of the story: the text it opened, each save it made, and
 * each outside version it took. The text both sides started from is nearly
 * always one of those, and it is the one the other version differs from least.
 *
 * Everything here errs towards asking. A starting point that cannot be
 * defended (the other version is older than it, or nothing typed here stands
 * between it and the text on screen) is no starting point, and the caller
 * leaves the version for the user to review. The one thing settled without a
 * starting point is a version the text here already holds in full: there is
 * nothing in it to ask about.
 */

import {
  holdsAllOf,
  holdsChangesOf,
  mergeText,
  textDistance,
  type MergeHistory,
  type ThreeWayMergeResult,
} from './three-way-merge.js';

/** Where a held text came from. */
type HeldKind =
  /** Read from storage when the document was opened. */
  | 'opened'
  /** Written by someone else, the saved document when it was taken in here. */
  | 'outside'
  /** Written by someone else and set aside by a sync service; combined in here. */
  | 'aside'
  /** Saved by this session. */
  | 'own';

interface HeldText {
  readonly content: string;
  readonly kind: HeldKind;
  /**
   * When this text came to be, as well as that is known: an own save's time,
   * an outside version's modification time, the moment a document was opened.
   */
  readonly at: number;
  /** Who wrote an outside version, when storage said. */
  readonly by?: string;
  /** For a version the sync service set aside: the text that was the saved document instead. */
  readonly replacedBy?: string;
  /**
   * Set once storage replaced this text with a version that was not built on
   * it: the text here no longer descends from it. Holds the text the two
   * parted from, or null when that could not be told.
   */
  displaced?: { readonly from: string | null };
  /**
   * When a copy of this save was seen among the versions the sync service
   * set aside. A sync service only does that to a save made without sight of
   * the one it kept, so this is the proof that whatever replaces this save in
   * storage was written at the same time, not in answer to it.
   */
  setAsideAt?: number;
}

/** Where storage and this session parted, when storage holds a version not built on the saves here. */
export interface DocumentParting {
  /** The text both the version in storage and the saves here were built on. */
  readonly from: string;
  /**
   * Until when the sync service is known to have set one of those saves
   * aside, or null when it is not: the two were then written at the same
   * time for certain, and combining them from `from` is safe.
   */
  readonly provenUntil: number | null;
}

/** The part of a lineage worth keeping across restarts. */
export interface DocumentLineageRecord {
  /** The last text this device took from storage rather than wrote. */
  readonly base: string;
  readonly baseKind: 'opened' | 'outside';
  readonly baseAt: number;
  /** Signature of the last text this device saved on top of it. */
  readonly lastSaved: string;
  readonly lastSavedAt: number;
}

export type DocumentMergePlan =
  /** The text here already has everything the other version has. */
  | { readonly status: 'included' }
  | {
      readonly status: 'merged';
      readonly merged: string;
      /**
       * True when the other version was written elsewhere; false when it is a
       * save of this session's own that storage had replaced.
       */
      readonly foreign: boolean;
    }
  /** Both changed the same part. */
  | { readonly status: 'overlap' }
  /** What the two started from is not known well enough to combine them. */
  | { readonly status: 'unknown-base' };

/**
 * How long a set-aside copy counts as proof about the next version storage
 * hands over. The two arrive within moments of each other; an old sighting
 * says nothing about a version that turns up much later.
 */
const SET_ASIDE_PROOF_MS = 120_000;
/**
 * How far the time on a set-aside copy may be from the time a text was held
 * here for the two to be the same version. A copy's time is the moment the
 * file was written, to the second; a save's is the moment the write was
 * done. Texts can be equal without being the same version: a word typed and
 * taken out again leaves a text exactly as it was before.
 */
const SAME_VERSION_BEFORE_MS = 5_000;
const SAME_VERSION_AFTER_MS = 2_000;
const MAX_HELD = 48;
const MAX_HELD_CHARS = 6_000_000;
/** Two devices' clocks are never exactly together. */
const CLOCK_SKEW_MS = 2_000;

/** A cheap, synchronous fingerprint: enough to tell "is this the text I last saved". */
export function textSignature(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${text.length.toString(36)}:${hash.toString(36)}`;
}

/** What is known of a version being combined with the text here. */
export interface DocumentVersionOrigin {
  /** When it was written; null for the version storage holds now. */
  readonly at: number | null;
  /** Who wrote it, when storage said. */
  readonly by?: string | undefined;
}

/** True when `text` carries every change that turned `from` into `to`. */
function carries(text: string, from: string, to: string): boolean {
  const result = mergeText(from, to, text);
  return result.clean && result.merged === text;
}

export class DocumentLineage {
  private held: HeldText[] = [];
  private changes = 0;

  /** Changes whenever what is held, or known about it, does: a key for anything worked out from it. */
  public get stamp(): number {
    return this.changes;
  }

  /** Forget everything: no document is open. */
  public reset(): void {
    this.held = [];
    this.changes += 1;
  }

  /**
   * A document was opened with `content`. When it is exactly what this device
   * last saved, what that save was built on still stands and is restored from
   * `record`; otherwise someone else wrote it and it is the starting point.
   */
  public opened(content: string, at: number, record?: DocumentLineageRecord | null): void {
    this.held = [];
    this.changes += 1;
    if (record && record.lastSaved === textSignature(content)) {
      this.held.push({
        content: record.base,
        kind: record.baseKind,
        at: record.baseAt,
      });
      if (record.base !== content) {
        this.held.push({
          content,
          kind: 'own',
          at: Math.min(at, record.lastSavedAt),
        });
      }
      return;
    }
    this.held.push({ content, kind: 'opened', at });
  }

  /** This session saved `content`. */
  public saved(content: string, at: number): void {
    const latest = this.latest();
    // The same text as the last one held is still worth a mark of its own
    // when that one was written elsewhere: typing here can end on exactly
    // the text another device saved, and it is this save, not theirs, that
    // the sync service may set aside.
    if (!latest || (latest.content === content && latest.kind === 'own')) return;
    this.held.push({ content, kind: 'own', at });
    this.changes += 1;
    this.trim();
  }

  /**
   * Storage now holds `content`, written by someone else, and the session
   * goes on from it. Saves of this session's own that it was not built on are
   * marked: the document no longer has them, and if the sync service kept one
   * as a set-aside version it can be put back from where the two parted.
   */
  public tookOutside(content: string, at: number, by?: string): void {
    this.changes += 1;
    const taken: HeldText = { content, kind: 'outside', at, ...(by ? { by } : {}) };
    if (this.held.length === 0) {
      this.held.push(taken);
      return;
    }
    if (this.latest()?.content === content) return;
    this.spendProof();
    const current = this.current();
    const fork = this.forkOf(current, content);
    const from = fork < 0 ? null : current[fork]!.content;
    for (let index = fork + 1; index < current.length; index += 1) {
      current[index]!.displaced = { from };
    }
    this.held.push(taken);
    this.trim();
  }

  /**
   * After `tookOutside`: storage's version was combined with unsaved text
   * here, and `content` is that version with whatever the combining kept of
   * the saves made here. It was never written anywhere, but the text here is
   * built on it, and a copy of one of those saves that turns up later is
   * then an earlier moment of this, not something to decide about.
   */
  public carried(content: string, at: number): void {
    if (this.held.length === 0 || this.latest()?.content === content) return;
    this.held.push({ content, kind: 'own', at });
    this.changes += 1;
    this.trim();
  }

  /**
   * Work out how `theirs`, a version the sync service set aside as saved at
   * the same time, combines with `mine`, the text here now.
   */
  public plan(
    mine: string,
    theirs: string,
    theirsSavedAt: number | null,
    theirsBy?: string,
  ): DocumentMergePlan {
    if (theirs === mine) return { status: 'included' };

    const known = this.findVersion(theirs, theirsSavedAt);
    if (known) {
      // A text this session held and still builds on has nothing new in it.
      if (!known.displaced) return { status: 'included' };
      // A save of this session's own that storage replaced: put it back. It
      // is this side's writing, so nothing is known of who else had seen what.
      const restored: DocumentMergePlan =
        known.displaced.from === null
          ? { status: 'unknown-base' }
          : this.combine(known.displaced.from, mine, theirs, null, false);
      return this.orAlreadyHeld(restored, mine, theirs, null);
    }
    const origin = { at: theirsSavedAt, by: theirsBy };
    return this.orAlreadyHeld(this.planForeign(mine, theirs, origin), mine, theirs, origin);
  }

  /**
   * A version that could not be combined may still be one the text here has
   * moved past, and then there is nothing in it to ask about.
   */
  private orAlreadyHeld(
    planned: DocumentMergePlan,
    mine: string,
    theirs: string,
    origin: DocumentVersionOrigin | null,
  ): DocumentMergePlan {
    if (this.settled(planned)) return planned;
    if (this.hasNothingNew(mine, theirs, origin)) return { status: 'included' };
    // With no starting text to measure from (after a restart, or for a
    // version older than anything remembered), the one thing still certain is
    // whether the text here holds every word of it. Nothing can be lost by
    // letting such a version go; the worst case is that it was a deletion
    // made elsewhere, which then has to be made again.
    if (planned.status === 'unknown-base' && holdsAllOf(mine, theirs)) {
      return { status: 'included' };
    }
    return planned;
  }

  private planForeign(
    mine: string,
    theirs: string,
    origin: DocumentVersionOrigin,
  ): DocumentMergePlan {
    if (origin.at === null) return { status: 'unknown-base' };
    const current = this.current();
    const pick = this.closestAncestor(current, theirs, origin.at);
    if (pick < 0) return { status: 'unknown-base' };
    const base = current[pick]!;
    // With nothing typed here since a text someone else wrote, there is no
    // telling which of the two versions is the newer one. Typing that ended
    // where it began (a word typed and taken out again) is still typing: a
    // save was made here, and the other version was set aside against it.
    const typedSince = current.slice(pick + 1).some((entry) => entry.kind === 'own');
    if (base.kind !== 'own' && base.content === mine && !typedSince) {
      return { status: 'unknown-base' };
    }
    return this.combine(base.content, mine, theirs, origin, true);
  }

  private settled(plan: DocumentMergePlan): boolean {
    return plan.status === 'merged' || plan.status === 'included';
  }

  /**
   * Whether `theirs` is a stage the text here has already passed: measured
   * from some text this session held and still builds on, every change in
   * `theirs` is in `mine` too. Two devices typing at once hand each other
   * half-finished states all the time (a paragraph three words short of what
   * it is now), and those must not queue up as versions to decide between.
   *
   * This can never hide new text: something only `theirs` has would show up
   * as a change `mine` lacks, from whichever held text it is measured.
   */
  private hasNothingNew(
    mine: string,
    theirs: string,
    origin: DocumentVersionOrigin | null,
  ): boolean {
    for (const entry of this.current()) {
      const result = this.merge(entry.content, mine, theirs, origin);
      if (result.clean && result.merged === mine) return true;
    }
    return false;
  }

  /**
   * `theirs`, a save of this session's own that storage had replaced, was
   * combined back into the text here by `plan`: the session builds on it, and
   * on the saves that led to it, once more.
   */
  public restored(theirs: string): void {
    for (let index = this.held.length - 1; index >= 0; index -= 1) {
      const entry = this.held[index]!;
      if (entry.content !== theirs || !entry.displaced) continue;
      const from = entry.displaced.from;
      for (let earlier = index; earlier >= 0; earlier -= 1) {
        const candidate = this.held[earlier]!;
        if (!candidate.displaced || candidate.displaced.from !== from) break;
        delete candidate.displaced;
        delete candidate.setAsideAt;
      }
      this.changes += 1;
      return;
    }
  }

  /**
   * A copy of `content` is among the versions the sync service set aside.
   * Returns true when that is news about a save made here: storage has
   * replaced it, or is about to be seen to have, with a version written at
   * the same time.
   */
  public sawSetAside(content: string, savedAt: number | null, now: number): boolean {
    const entry = this.findVersion(content, savedAt);
    if (!entry || entry.kind !== 'own') return false;
    const news = entry.setAsideAt === undefined || now - entry.setAsideAt > SET_ASIDE_PROOF_MS;
    entry.setAsideAt = now;
    this.changes += 1;
    return news;
  }

  /**
   * Storage holds `outside`, which the session has not taken yet. When it
   * was not built on the saves made here (it carries none of what was typed
   * to reach them), returns the text the two parted from. Null when
   * `outside` builds on everything here, when nothing saved here is at
   * stake, or when where they parted cannot be told.
   *
   * By itself this does not say the two were written at the same time: a
   * version that lacks the typing here may have removed it on purpose. Only
   * `provenUntil` says so.
   */
  public parting(outside: string): DocumentParting | null {
    const current = this.current();
    if (current.length === 0 || current.at(-1)!.content === outside) return null;
    const fork = this.forkOf(current, outside);
    if (fork < 0) return null;
    const after = current.slice(fork + 1);
    if (!after.some((entry) => entry.kind === 'own')) return null;
    let seen: number | null = null;
    for (const entry of after) {
      if (entry.kind !== 'own' || entry.setAsideAt === undefined) continue;
      seen = Math.max(seen ?? 0, entry.setAsideAt);
    }
    return {
      from: current[fork]!.content,
      provenUntil: seen === null ? null : seen + SET_ASIDE_PROOF_MS,
    };
  }

  /**
   * `theirs` was combined into the text here by `plan`. It is now part of
   * what this session builds on, and its author certainly has it.
   */
  public absorbed(
    theirs: string,
    at: number,
    how: {
      /** True for a version the sync service set aside; false for the saved document. */
      readonly setAside: boolean;
      readonly by?: string | undefined;
      /** The text here that it was combined with. */
      readonly mine?: string | undefined;
    },
  ): void {
    const { setAside, by, mine } = how;
    if (this.held.length === 0 || this.latest()?.content === theirs) return;
    this.spendProof();
    this.changes += 1;
    const document = this.latest()?.content;
    // What it was combined with may never have been saved, and is as much a
    // moment of the writing here as any save.
    if (mine !== undefined && mine !== theirs && this.latest()?.content !== mine) {
      this.held.push({ content: mine, kind: 'own', at: Math.min(at, Date.now()) });
    }
    this.held.push({
      content: theirs,
      kind: setAside ? 'aside' : 'outside',
      at,
      ...(by ? { by } : {}),
      ...(setAside && document !== undefined ? { replacedBy: document } : {}),
    });
    this.trim();
  }

  /** A set-aside copy is proof about one outside version; it was just used. */
  private spendProof(): void {
    for (const entry of this.held) delete entry.setAsideAt;
  }

  /** What to keep across restarts, or null when nothing is held. */
  public record(): DocumentLineageRecord | null {
    const current = this.current();
    const latest = current.at(-1);
    if (!latest) return null;
    for (let index = current.length - 1; index >= 0; index -= 1) {
      const entry = current[index]!;
      if (entry.kind === 'own') continue;
      return {
        base: entry.content,
        baseKind: entry.kind === 'opened' ? 'opened' : 'outside',
        baseAt: entry.at,
        lastSaved: textSignature(latest.content),
        lastSavedAt: latest.at,
      };
    }
    return null;
  }

  /**
   * Combine `mine`, the text here, with `theirs` from `base`, using what this
   * session knows of the texts behind them. `origin` says when and by whom
   * `theirs` was written; null when it is this session's own writing.
   *
   * A paragraph is typed, shortened and retyped over several saves, and the
   * other device keeps handing back one of the earlier ones with its own
   * edits elsewhere. Measured from one starting text that is two changes to
   * the same paragraph; measured against everything held here it is one
   * piece of writing at two moments, and the later one stands.
   */
  public merge(
    base: string,
    mine: string,
    theirs: string,
    origin: DocumentVersionOrigin | null,
  ): ThreeWayMergeResult {
    return mergeText(base, mine, theirs, this.historyFrom(base, origin));
  }

  private historyFrom(base: string, origin: DocumentVersionOrigin | null): MergeHistory {
    const chain = this.current();
    let from = -1;
    for (let index = chain.length - 1; index >= 0 && from < 0; index -= 1) {
      if (chain[index]!.content === base) from = index;
    }
    // Earlier versions from the writer of `theirs`: written elsewhere, taken
    // in since the starting text, and not after `theirs` itself. An older
    // leftover must not undo what a newer version from the same device
    // brought, so the times are compared as given, with no allowance.
    const sameWriter = (entry: HeldText) =>
      origin !== null &&
      (entry.kind === 'outside' || entry.kind === 'aside') &&
      (origin.at === null || entry.at <= origin.at) &&
      (!entry.by || !origin.by || entry.by === origin.by);
    const behindBoth: MergeHistory['behindBoth'][number][] = [];
    for (let index = Math.max(from + 1, 0); from >= 0 && index < chain.length; index += 1) {
      const entry = chain[index]!;
      if (!sameWriter(entry)) continue;
      behindBoth.push({
        text: entry.content,
        since: chain.slice(index + 1).map((held) => held.content),
        // Without the text that replaced it, nothing can be told from it.
        ...(entry.kind === 'aside' ? { replacedBy: entry.replacedBy ?? entry.content } : {}),
      });
    }
    return { behindLocal: chain.map((entry) => entry.content), behindBoth };
  }

  private combine(
    base: string,
    mine: string,
    theirs: string,
    origin: DocumentVersionOrigin | null,
    foreign: boolean,
  ): DocumentMergePlan {
    const result = this.merge(base, mine, theirs, origin);
    if (!result.clean) {
      return {
        status: result.reason === 'overlap' ? 'overlap' : 'unknown-base',
      };
    }
    if (result.merged === mine) return { status: 'included' };
    return { status: 'merged', merged: result.merged, foreign };
  }

  /** The texts the text here was built on, oldest first. */
  private current(): HeldText[] {
    return this.held.filter((entry) => !entry.displaced);
  }

  private latest(): HeldText | undefined {
    for (let index = this.held.length - 1; index >= 0; index -= 1) {
      if (!this.held[index]!.displaced) return this.held[index];
    }
    return undefined;
  }

  /**
   * The held text that a version with `content`, written at `at`, is: the
   * newest with that text when no time is known, otherwise the newest held
   * at about that time. A version with the same text from another time is
   * another version.
   */
  private findVersion(content: string, at: number | null): HeldText | undefined {
    for (let index = this.held.length - 1; index >= 0; index -= 1) {
      const entry = this.held[index]!;
      if (entry.content !== content) continue;
      if (
        at === null ||
        (at >= entry.at - SAME_VERSION_BEFORE_MS && at <= entry.at + SAME_VERSION_AFTER_MS)
      ) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Where `outside`, the version storage holds, and `chain` parted: the last
   * of `chain` that `outside` was built on, or -1 when that cannot be told.
   *
   * The text `outside` differs from least is only a first answer, because a
   * word typed and taken out again leaves a text that looks like an old one,
   * or like a version from the other device. So the saves made here are
   * also gone through by sight, oldest first. When `outside` was written
   * with sight of every one of them, it was built on the newest, however
   * much it looks like something older. Otherwise the two parted no later
   * than just before the first save it was written without. Parting too
   * early costs nothing, since whatever both sides have is then simply
   * found in both; parting too late would take the other version as the
   * newer one and drop what was typed here.
   */
  private forkOf(chain: readonly HeldText[], outside: string): number {
    const closest = this.closestAncestor(chain, outside, Number.POSITIVE_INFINITY);
    for (let index = 1; index < chain.length; index += 1) {
      const entry = chain[index]!;
      if (entry.kind !== 'own') continue;
      const later = chain.slice(index + 1).map((held) => held.content);
      if (!holdsChangesOf(outside, chain[index - 1]!.content, entry.content, later)) {
        return Math.min(closest, index - 1);
      }
    }
    return chain.length - 1;
  }

  /**
   * Which of `chain` was `other` most likely built on: the one it differs
   * from least, the older on a tie. `otherAt` is when `other` was saved; a
   * text that did not exist yet then cannot be what it was built on.
   *
   * A save of this session's own is only accepted when `other` carries what
   * was typed to reach it, which is how one tells its author had received it.
   * Failing that, the search steps back to the text before.
   */
  private closestAncestor(chain: readonly HeldText[], other: string, otherAt: number): number {
    // A text that did not exist yet when `other` was saved cannot be under it.
    const existed = (entry: HeldText) =>
      entry.at <= otherAt + (entry.kind === 'own' ? CLOCK_SKEW_MS : 0);
    let pick = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let index = 0; index < chain.length; index += 1) {
      const entry = chain[index]!;
      if (!existed(entry)) continue;
      const distance = textDistance(entry.content, other);
      if (distance !== null && distance < best) {
        best = distance;
        pick = index;
      }
    }
    for (; pick >= 0; pick -= 1) {
      const entry = chain[pick]!;
      if (!existed(entry)) continue;
      if (entry.kind !== 'own') return pick;
      // A save of this session's own with nothing before it cannot be checked.
      if (pick === 0) return -1;
      if (carries(other, chain[pick - 1]!.content, entry.content)) return pick;
    }
    return -1;
  }

  /**
   * Stay within budget without ever making a newer text look like the
   * starting point: texts storage replaced go first, then older saves of this
   * session's own (the text they were built on stays), then the oldest
   * starting points.
   */
  private trim(): void {
    const chars = () => this.held.reduce((total, entry) => total + entry.content.length, 0);
    while (this.held.length > MAX_HELD || chars() > MAX_HELD_CHARS) {
      let drop = this.held.findIndex((entry) => entry.displaced);
      if (drop < 0) {
        drop = this.held.findIndex(
          (entry, index) => entry.kind === 'own' && index < this.held.length - 1,
        );
      }
      if (drop < 0 && this.held.filter((entry) => entry.kind !== 'own').length > 1) drop = 0;
      if (drop < 0) return;
      this.held.splice(drop, 1);
    }
  }
}
