/**
 * Line-based three-way merge for text documents.
 *
 * Given the text two edits started from and the two results, this combines
 * them when the edits touch different parts of the document, and refuses when
 * they do not. It is deliberately conservative, like git: two edits to the
 * same or to neighbouring lines are an overlap, because joining them without a
 * person looking can produce text neither side wrote. A Markdown paragraph is
 * one line, so two people rewording the same paragraph always overlap.
 *
 * Two exceptions, both for one piece of writing seen at two moments rather
 * than two pieces of writing. Where one side has a place exactly as a text
 * the other was built on had it, the other side's is the later one (see
 * `MergeHistory`). And where both sides only added to the same place and one
 * has all of the other's additions, the fuller one is taken (see
 * `laterStage`).
 */

export type ThreeWayMergeResult =
  | { readonly clean: true; readonly merged: string }
  | { readonly clean: false; readonly reason: 'overlap' | 'too-large' };

/** A changed region: `base[baseStart, baseEnd)` became `other[otherStart, otherEnd)`. */
interface Hunk {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly otherStart: number;
  readonly otherEnd: number;
}

/**
 * What the caller knows of the texts behind the two being combined: which
 * side has already seen the other's text for a place, and moved on from it.
 *
 * Without this, one piece of writing seen at two moments looks like two
 * pieces of writing. A device shortens or retypes a paragraph over two
 * saves, and the other device hands back the first of them with its own
 * edits elsewhere. Or a device types a word and takes it out again, and its
 * text is once more exactly what it was before. Neither the starting text
 * nor the fuller-one rule can tell which moment is the later one.
 */
export interface MergeHistory {
  /**
   * Texts `local` was built on. Where both sides changed a place and
   * `external` has it exactly as one of these had it, `external` holds an
   * earlier moment of what is here, and the text here stands.
   */
  readonly behindLocal: readonly string[];
  /**
   * Earlier versions from whoever wrote `external`, taken in here since
   * `base`, each with every text held here since. Where `local` has a place
   * exactly as one of these had it, and so has every text since, nothing
   * was done to that place here: its writer had that text and now has
   * something else, and `external` is the later word.
   */
  readonly behindBoth: readonly MergeHistoryVersion[];
}

export interface MergeHistoryVersion {
  readonly text: string;
  /** Every text held after it, oldest first. */
  readonly since: readonly string[];
  /**
   * Set for a version a sync service set aside: the text that was the saved
   * document in its place. Absent for a version that was itself the saved
   * document. The difference is what its writer's next save can mean.
   *
   * A device whose save became the document keeps that text, so when its
   * next version has a place differently, even back to what `base` had (a
   * word typed and taken out again), that was done on purpose. A device
   * whose save was set aside may lose that typing to the version that
   * replaced it and not have it back yet. Its next save then has the place
   * as the replacing version had it, without anyone having removed
   * anything. So a set-aside version only counts where `external` is not
   * simply the replacing text, and plainly goes on from the set-aside one:
   * the same text with something added, or with something taken away.
   */
  readonly replacedBy?: string | undefined;
}

const MAX_LINES = 50_000;
/** Edit distance beyond which a comparison is abandoned rather than run for seconds. */
const MAX_EDIT_DISTANCE = 1_000;

/** Lines with their terminators, so joining them restores the exact text. */
function splitLines(text: string): string[] {
  if (!text) return [];
  const lines: string[] = [];
  let start = 0;
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', start)) {
    lines.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/**
 * Changed regions between two line arrays (Myers' O(ND) comparison), or null
 * when they differ by more than the work this is willing to do.
 */
function diffLines(base: readonly string[], other: readonly string[]): Hunk[] | null {
  let prefix = 0;
  const shortest = Math.min(base.length, other.length);
  while (prefix < shortest && base[prefix] === other[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    base[base.length - 1 - suffix] === other[other.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const a = base.slice(prefix, base.length - suffix);
  const b = other.slice(prefix, other.length - suffix);
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) {
    return [
      {
        baseStart: prefix,
        baseEnd: prefix + n,
        otherStart: prefix,
        otherEnd: prefix + m,
      },
    ];
  }

  const limit = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = limit + 1;
  let frontier: Int32Array = new Int32Array(2 * offset + 1);
  const history: Int32Array[] = [];
  let distance = -1;
  for (let d = 0; d <= limit && distance < 0; d += 1) {
    history.push(frontier.slice());
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && frontier[offset + k - 1]! < frontier[offset + k + 1]!);
      let x = down ? frontier[offset + k + 1]! : frontier[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      frontier[offset + k] = x;
      if (x >= n && y >= m) {
        distance = d;
        break;
      }
    }
  }
  if (distance < 0) return null;

  // Walk the recorded frontiers back to the start, collecting the matched lines.
  const matches: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = distance; d > 0; d -= 1) {
    frontier = history[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && frontier[offset + k - 1]! < frontier[offset + k + 1]!);
    const previousK = down ? k + 1 : k - 1;
    const previousX = frontier[offset + previousK]!;
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      matches.push([x, y]);
    }
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    matches.push([x, y]);
  }
  matches.reverse();

  const hunks: Hunk[] = [];
  let baseCursor = 0;
  let otherCursor = 0;
  const close = (baseEnd: number, otherEnd: number) => {
    if (baseEnd > baseCursor || otherEnd > otherCursor) {
      hunks.push({
        baseStart: prefix + baseCursor,
        baseEnd: prefix + baseEnd,
        otherStart: prefix + otherCursor,
        otherEnd: prefix + otherEnd,
      });
    }
  };
  for (const [baseIndex, otherIndex] of matches) {
    close(baseIndex, otherIndex);
    baseCursor = baseIndex + 1;
    otherCursor = otherIndex + 1;
  }
  close(n, m);
  return hunks;
}

/**
 * How far apart two texts are: the number of characters that differ inside
 * the lines that changed. Null when they differ by more than this is willing
 * to measure.
 *
 * Counting characters rather than lines matters because a paragraph is one
 * line. A paragraph with three more words typed into it is close to what it
 * was a moment ago and far from what it was an hour ago, and counting lines
 * would call both "one line different".
 */
export function textDistance(a: string, b: string): number | null {
  if (a === b) return 0;
  const aLines = splitLines(a);
  const bLines = splitLines(b);
  if (Math.max(aLines.length, bLines.length) > MAX_LINES) return null;
  const hunks = diffLines(aLines, bLines);
  if (!hunks) return null;
  let distance = 0;
  for (const hunk of hunks) {
    const from = aLines.slice(hunk.baseStart, hunk.baseEnd).join('');
    const to = bLines.slice(hunk.otherStart, hunk.otherEnd).join('');
    const shortest = Math.min(from.length, to.length);
    let prefix = 0;
    while (prefix < shortest && from.charCodeAt(prefix) === to.charCodeAt(prefix)) prefix += 1;
    let suffix = 0;
    while (
      suffix < shortest - prefix &&
      from.charCodeAt(from.length - 1 - suffix) === to.charCodeAt(to.length - 1 - suffix)
    ) {
      suffix += 1;
    }
    distance += from.length + to.length - 2 * (prefix + suffix);
  }
  return distance;
}

/** True when `to` is `from` with one run of characters added and none taken away. */
function addsOneRun(from: string, to: string): boolean {
  if (from.length > to.length) return false;
  let prefix = 0;
  while (prefix < from.length && from.charCodeAt(prefix) === to.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < from.length - prefix &&
    from.charCodeAt(from.length - 1 - suffix) === to.charCodeAt(to.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  return prefix + suffix === from.length;
}

/**
 * Whether `text` holds all of `other`: `text` is `other` with text added and
 * nothing taken away. Whole lines may only have been added, and a line that
 * changed must be the old line with something typed into it in one place.
 *
 * This needs no knowledge of what the two started from, which is its use: an
 * old version of a document that the document has simply grown past has
 * nothing in it to lose. It is deliberately strict. A paragraph reworded, or
 * typed into in two places, does not pass, and neither does a comparison too
 * large to make.
 */
export function holdsAllOf(text: string, other: string): boolean {
  if (text === other) return true;
  const otherLines = splitLines(other);
  const textLines = splitLines(text);
  if (Math.max(otherLines.length, textLines.length) > MAX_LINES) return false;
  const hunks = diffLines(otherLines, textLines);
  if (!hunks) return false;
  for (const hunk of hunks) {
    const removed = otherLines.slice(hunk.baseStart, hunk.baseEnd);
    if (removed.length === 0) continue;
    const added = textLines.slice(hunk.otherStart, hunk.otherEnd);
    // Neighbouring lines that each grew are compared one to one; anything
    // else must be a single place where text went in.
    const grew =
      removed.length === added.length
        ? removed.every((line, index) => addsOneRun(line, added[index]!))
        : addsOneRun(removed.join(''), added.join(''));
    if (!grew) return false;
  }
  return true;
}

/**
 * The one kind of overlap that needs no person: both sides only typed into
 * the same place, and one of them has everything the other typed and more.
 * That is one piece of typing seen at two moments (a device's save, and the
 * same device's save a few words later, reaching here by different routes),
 * and the later moment is the answer. Had either side also removed something
 * that was there before, it stays an overlap: a removal can be a decision.
 */
function laterStage(
  base: readonly string[],
  local: readonly string[],
  external: readonly string[],
): readonly string[] | null {
  const before = base.join('');
  const localText = local.join('');
  const externalText = external.join('');
  if (holdsAllOf(localText, externalText) && holdsAllOf(externalText, before)) return local;
  if (holdsAllOf(externalText, localText) && holdsAllOf(localText, before)) return external;
  return null;
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/**
 * The lines of `other` that stand where `base[start, end)` stood, given the
 * changes from `base` to `other`. Null when one of those changes reaches
 * across an edge of that range, and the two cannot be lined up.
 *
 * Lines added exactly at either edge count as inside, as they do when
 * `mergeText` gathers a region.
 */
function linesAt(
  hunks: readonly Hunk[],
  other: readonly string[],
  start: number,
  end: number,
): readonly string[] | null {
  let from = start;
  let to = end;
  for (const hunk of hunks) {
    const grew = hunk.otherEnd - hunk.otherStart - (hunk.baseEnd - hunk.baseStart);
    const added = hunk.baseStart === hunk.baseEnd;
    if (hunk.baseEnd < start || (hunk.baseEnd === start && !added)) {
      from += grew;
      to += grew;
    } else if (hunk.baseStart > end || (hunk.baseStart === end && !added)) {
      break;
    } else if (hunk.baseStart >= start && hunk.baseEnd <= end) {
      to += grew;
    } else {
      return null;
    }
  }
  return other.slice(from, to);
}

/** Answers, for one place in `base`, whether a text had it as given. */
function stageFinder(baseLines: readonly string[]) {
  const compared = new Map<string, { lines: string[]; hunks: Hunk[] | null }>();
  return (text: string, start: number, end: number, wanted: readonly string[]): boolean => {
    let entry = compared.get(text);
    if (!entry) {
      const lines = splitLines(text);
      entry = {
        lines,
        hunks: lines.length > MAX_LINES ? null : diffLines(baseLines, lines),
      };
      compared.set(text, entry);
    }
    if (!entry.hunks) return false;
    const lines = linesAt(entry.hunks, entry.lines, start, end);
    return lines !== null && sameLines(lines, wanted);
  };
}

/**
 * Whether `text` was written with sight of the change from `from` to `to`:
 * in every place that change touched, `text` has what `to` put there, or
 * what one of `later` (texts written on from `to`) has there now.
 *
 * The second half matters for a paragraph changed again and again. A text
 * built on the newest of those changes has none of the older ones as they
 * were, and would otherwise look as if it had been written without them.
 */
export function holdsChangesOf(
  text: string,
  from: string,
  to: string,
  later: readonly string[],
): boolean {
  if (text === to || from === to) return true;
  const fromLines = splitLines(from);
  const toLines = splitLines(to);
  const textLines = splitLines(text);
  if (Math.max(fromLines.length, toLines.length, textLines.length) > MAX_LINES) return false;
  const changes = diffLines(fromLines, toLines);
  const textHunks = diffLines(fromLines, textLines);
  if (!changes || !textHunks) return false;
  const had = stageFinder(fromLines);
  for (const change of changes) {
    const there = linesAt(textHunks, textLines, change.baseStart, change.baseEnd);
    if (!there) return false;
    if (![to, ...later].some((held) => had(held, change.baseStart, change.baseEnd, there))) {
      return false;
    }
  }
  return true;
}

/**
 * Combine `local` and `external`, which both started from `base`.
 * A clean result contains every change from both and nothing else.
 * `history`, when the caller has one, settles places where one side only
 * holds an earlier moment of the other's writing.
 */
export function mergeText(
  base: string,
  local: string,
  external: string,
  history?: MergeHistory,
): ThreeWayMergeResult {
  if (local === external) return { clean: true, merged: local };
  if (base === local) return { clean: true, merged: external };
  // With earlier versions from the other writer in hand, a text that is
  // once more what it was before may be the later word, not an old one.
  if (base === external && !history?.behindBoth.length) return { clean: true, merged: local };

  const baseLines = splitLines(base);
  const localLines = splitLines(local);
  const externalLines = splitLines(external);
  if (Math.max(baseLines.length, localLines.length, externalLines.length) > MAX_LINES) {
    return { clean: false, reason: 'too-large' };
  }
  const localHunks = diffLines(baseLines, localLines);
  const externalHunks = diffLines(baseLines, externalLines);
  if (!localHunks || !externalHunks) return { clean: false, reason: 'too-large' };

  const had = stageFinder(baseLines);
  const merged: string[] = [];
  let cursor = 0;
  let localIndex = 0;
  let externalIndex = 0;
  let localShift = 0;
  let externalShift = 0;
  while (localIndex < localHunks.length || externalIndex < externalHunks.length) {
    const regionStart = Math.min(
      localHunks[localIndex]?.baseStart ?? Number.POSITIVE_INFINITY,
      externalHunks[externalIndex]?.baseStart ?? Number.POSITIVE_INFINITY,
    );
    for (let line = cursor; line < regionStart; line += 1) merged.push(baseLines[line]!);

    // Grow the region over every change that overlaps or touches it, from either side.
    let regionEnd = regionStart;
    const localBefore = localShift;
    const externalBefore = externalShift;
    let localChanged = false;
    let externalChanged = false;
    for (let grew = true; grew; ) {
      grew = false;
      while (localIndex < localHunks.length && localHunks[localIndex]!.baseStart <= regionEnd) {
        const hunk = localHunks[localIndex]!;
        regionEnd = Math.max(regionEnd, hunk.baseEnd);
        localShift += hunk.otherEnd - hunk.otherStart - (hunk.baseEnd - hunk.baseStart);
        localIndex += 1;
        localChanged = true;
        grew = true;
      }
      while (
        externalIndex < externalHunks.length &&
        externalHunks[externalIndex]!.baseStart <= regionEnd
      ) {
        const hunk = externalHunks[externalIndex]!;
        regionEnd = Math.max(regionEnd, hunk.baseEnd);
        externalShift += hunk.otherEnd - hunk.otherStart - (hunk.baseEnd - hunk.baseStart);
        externalIndex += 1;
        externalChanged = true;
        grew = true;
      }
    }

    const fromLocal = localLines.slice(regionStart + localBefore, regionEnd + localShift);
    const fromExternal = externalLines.slice(
      regionStart + externalBefore,
      regionEnd + externalShift,
    );
    let chosen: readonly string[] = localChanged ? fromLocal : fromExternal;
    if (localChanged && !sameLines(fromLocal, fromExternal)) {
      const goesOn = () => {
        const here = fromLocal.join('');
        const there = fromExternal.join('');
        return holdsAllOf(there, here) || holdsAllOf(here, there);
      };
      const untouchedHere = history?.behindBoth.some(
        (version) =>
          had(version.text, regionStart, regionEnd, fromLocal) &&
          version.since.every((text) => had(text, regionStart, regionEnd, fromLocal)) &&
          (version.replacedBy === undefined ||
            (!had(version.replacedBy, regionStart, regionEnd, fromExternal) && goesOn())),
      );
      if (untouchedHere) {
        // The other writer had exactly this, and has something else now.
        chosen = fromExternal;
      } else if (
        externalChanged &&
        !history?.behindLocal.some((text) => had(text, regionStart, regionEnd, fromExternal))
      ) {
        const later = laterStage(baseLines.slice(regionStart, regionEnd), fromLocal, fromExternal);
        if (!later) return { clean: false, reason: 'overlap' };
        chosen = later;
      }
    }
    for (const line of chosen) merged.push(line);
    cursor = regionEnd;
  }
  for (let line = cursor; line < baseLines.length; line += 1) merged.push(baseLines[line]!);
  return { clean: true, merged: merged.join('') };
}
