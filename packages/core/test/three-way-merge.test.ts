import { expect } from 'chai';
import { holdsAllOf, holdsChangesOf, mergeText } from '../src/document/three-way-merge.js';

const doc = (...paragraphs: string[]) => paragraphs.join('\n\n') + '\n';

function merged(base: string, local: string, external: string): string {
  const result = mergeText(base, local, external);
  if (!result.clean) throw new Error(`Expected a clean merge, got ${result.reason}`);
  return result.merged;
}

/** Small deterministic generator, so a failure can be reproduced from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('mergeText', () => {
  it('combines edits to different paragraphs', () => {
    const base = doc('# Unicorns', 'They are rare.', 'They like rainbows.');
    const local = doc('# Unicorns', 'They are rare.', 'They like rainbows and tried to finish it.');
    const external = doc('# Unicorns', 'They are very rare.', 'They like rainbows.');
    expect(merged(base, local, external)).to.equal(
      doc('# Unicorns', 'They are very rare.', 'They like rainbows and tried to finish it.'),
    );
  });

  it('combines an addition at the top with one at the bottom', () => {
    const base = doc('One', 'Two', 'Three');
    const local = doc('Zero', 'One', 'Two', 'Three');
    const external = doc('One', 'Two', 'Three', 'Four');
    expect(merged(base, local, external)).to.equal(doc('Zero', 'One', 'Two', 'Three', 'Four'));
  });

  it('combines a deletion with an edit elsewhere', () => {
    const base = doc('Keep', 'Remove me', 'Middle', 'Edit me');
    const local = doc('Keep', 'Middle', 'Edit me');
    const external = doc('Keep', 'Remove me', 'Middle', 'Edited');
    expect(merged(base, local, external)).to.equal(doc('Keep', 'Middle', 'Edited'));
  });

  it('accepts the same change made on both sides', () => {
    const base = doc('One', 'Two', 'Three');
    const both = doc('One', 'Two, revised', 'Three');
    expect(merged(base, both, both)).to.equal(both);
    const local = doc('Intro', 'One', 'Two, revised', 'Three');
    const external = doc('One', 'Two, revised', 'Three', 'Outro');
    expect(merged(base, local, external)).to.equal(
      doc('Intro', 'One', 'Two, revised', 'Three', 'Outro'),
    );
  });

  it('returns the only side that changed', () => {
    const base = doc('One', 'Two');
    const changed = doc('One', 'Two', 'Three');
    expect(merged(base, changed, base)).to.equal(changed);
    expect(merged(base, base, changed)).to.equal(changed);
    expect(merged(base, base, base)).to.equal(base);
  });

  it('refuses two edits to the same paragraph', () => {
    const base = doc('They are rare.');
    expect(mergeText(base, doc('They are very rare.'), doc('They are quite rare.'))).to.deep.equal({
      clean: false,
      reason: 'overlap',
    });
  });

  it('refuses edits to neighbouring lines, which only a person can join safely', () => {
    const base = '- one\n- two\n- three\n';
    expect(mergeText(base, '- ONE\n- two\n- three\n', '- one\n- TWO\n- three\n')).to.deep.equal({
      clean: false,
      reason: 'overlap',
    });
  });

  it('refuses two different additions at the same place', () => {
    const base = doc('One');
    expect(mergeText(base, doc('One', 'Mine'), doc('One', 'Theirs')).clean).to.equal(false);
    expect(mergeText('', 'mine\n', 'theirs\n').clean).to.equal(false);
  });

  it('refuses an edit to text the other side deleted', () => {
    const base = doc('Keep', 'Contested', 'Also keep');
    expect(
      mergeText(base, doc('Keep', 'Also keep'), doc('Keep', 'Contested, reworded', 'Also keep'))
        .clean,
    ).to.equal(false);
  });

  it('keeps line endings and a missing final newline exactly', () => {
    const base = 'one\r\n\r\ntwo\r\n\r\nthree';
    const local = 'ONE\r\n\r\ntwo\r\n\r\nthree';
    const external = 'one\r\n\r\ntwo\r\n\r\nTHREE';
    expect(merged(base, local, external)).to.equal('ONE\r\n\r\ntwo\r\n\r\nTHREE');
    expect(merged('a\n\nb', 'A\n\nb', 'a\n\nb\n')).to.equal('A\n\nb\n');
  });

  it('gives the same result whichever side is called local', () => {
    const base = doc('One', 'Two', 'Three', 'Four', 'Five');
    const left = doc('One!', 'Two', 'Three', 'Four', 'Five', 'Six');
    const right = doc('One', 'Two', 'Three?', 'Four', 'Five');
    expect(merged(base, left, right)).to.equal(merged(base, right, left));
  });

  it('gives up on a comparison too large to finish quickly', () => {
    const lines = (prefix: string) =>
      Array.from({ length: 3_000 }, (_, index) => `${prefix} ${index}`).join('\n');
    expect(mergeText(lines('base'), lines('local'), lines('external'))).to.deep.equal({
      clean: false,
      reason: 'too-large',
    });
  });

  it('merges separated random edits and never invents or drops a line', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed);
      const size = 12 + Math.floor(next() * 40);
      const base = Array.from({ length: size }, (_, index) => `line ${index}\n`);
      // Split the document in two with an untouched gap, and edit one half per side.
      const split = 4 + Math.floor(next() * (size - 8));
      const edit = (lines: string[], from: number, to: number, tag: string): string[] => {
        const out = [...lines];
        const count = 1 + Math.floor(next() * 3);
        for (let step = 0; step < count && to - from > 0; step += 1) {
          const at = from + Math.floor(next() * (to - from));
          const kind = next();
          if (kind < 0.34) out[at] = `${tag} changed ${at}\n`;
          else if (kind < 0.67) out[at] = `${out[at]}${tag} added after ${at}\n`;
          else out[at] = '';
        }
        return out;
      };
      const local = edit(base, 0, split - 2, 'local').join('');
      const external = edit(base, split + 2, size, 'external').join('');
      const baseText = base.join('');
      const result = mergeText(baseText, local, external);
      expect(result.clean, `seed ${seed}`).to.equal(true);
      if (!result.clean) continue;

      // The merge is the local half above the untouched gap and the external half below it.
      const localHead = local.slice(0, local.indexOf(base[split - 1]!));
      const externalTail = external.slice(external.indexOf(base[split - 1]!));
      expect(result.merged, `seed ${seed}`).to.equal(localHead + externalTail);
      expect(mergeText(baseText, external, local), `seed ${seed} mirrored`).to.deep.equal(result);
    }
  });

  it('never reports a clean merge that loses one side’s whole change', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const next = random(seed * 7919);
      const size = 6 + Math.floor(next() * 20);
      const base = Array.from({ length: size }, (_, index) => `p${index}\n`);
      const mutate = (tag: string): string[] => {
        const out = [...base];
        const at = Math.floor(next() * size);
        out[at] = `${tag}${at}\n`;
        return out;
      };
      const local = mutate('L');
      const external = mutate('E');
      const result = mergeText(base.join(''), local.join(''), external.join(''));
      if (!result.clean) continue;
      for (const line of [...local, ...external]) {
        if (/^[LE]/.test(line)) expect(result.merged, `seed ${seed}`).to.contain(line);
      }
    }
  });
});

describe('mergeText with two stages of the same typing', () => {
  const base = doc('# Unicorns', 'They are rare.', 'They like rainbows');

  it('takes the fuller stage of one paragraph and still combines the rest', () => {
    // One device's typing reached here twice: a word of it through the other
    // device's merge, and all of it directly.
    const local = doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter');
    const external = doc('# Unicorns', 'They are very rare.', 'They like rainbows and');
    const both = doc('# Unicorns', 'They are very rare.', 'They like rainbows and glitter');
    expect(merged(base, local, external)).to.equal(both);
    expect(merged(base, external, local)).to.equal(both);
  });

  it('still refuses when the shorter side took something out', () => {
    const local = doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter');
    const external = doc('# Unicorns', 'They are rare.', 'They like rain and');
    expect(mergeText(base, local, external)).to.deep.equal({
      clean: false,
      reason: 'overlap',
    });
  });

  it('still refuses two different additions to the same paragraph', () => {
    const local = doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter');
    const external = doc('# Unicorns', 'They are rare.', 'They like rainbows and sunshine');
    expect(mergeText(base, local, external)).to.deep.equal({
      clean: false,
      reason: 'overlap',
    });
  });
});

describe('holdsAllOf', () => {
  const older = doc('# Unicorns', 'They are rare.', 'They like rainbows and');

  it('holds a text it has only grown past', () => {
    const now = doc(
      '# Unicorns',
      'They are rare.',
      'They like rainbows and glitter.',
      'A new paragraph.',
    );
    expect(holdsAllOf(now, older)).to.equal(true);
    expect(holdsAllOf(older, older)).to.equal(true);
    expect(holdsAllOf(now, '')).to.equal(true);
  });

  it('holds a text typed into in several paragraphs, once in each', () => {
    const now = doc('# Unicorns', 'They are very rare.', 'They like rainbows and glitter.');
    expect(holdsAllOf(now, older)).to.equal(true);
    // Neighbouring lines with no blank line between them.
    expect(holdsAllOf('- one more\n- two more\n', '- one\n- two\n')).to.equal(true);
  });

  it('does not hold a text with a word, a line or a paragraph of its own', () => {
    expect(
      holdsAllOf(older, doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter.')),
    ).to.equal(false);
    expect(holdsAllOf(doc('# Unicorns', 'They like rainbows and'), older)).to.equal(false);
    expect(
      holdsAllOf(
        doc('# Unicorns', 'They are rare.', 'They like rain and'),
        doc('# Unicorns', 'They are rare.', 'They like rainbows and'),
      ),
    ).to.equal(false);
  });

  it('does not hold a paragraph that was reworded or typed into in two places', () => {
    expect(
      holdsAllOf(doc('# Unicorns', 'Unicorns are uncommon.', 'They like rainbows and'), older),
    ).to.equal(false);
    // Every word is still there, but this is too close to a rewrite to wave through.
    expect(
      holdsAllOf(
        doc('# Unicorns', 'They really are quite rare.', 'They like rainbows and'),
        doc('# Unicorns', 'They are rare.', 'They like rainbows and'),
      ),
    ).to.equal(false);
  });

  it('refuses a comparison too large to make', () => {
    const lines = Array.from({ length: 3_000 }, (_, index) => `line ${index}\n`);
    const other = lines.map((line, index) => (index % 2 ? line : `changed ${index}\n`));
    expect(holdsAllOf(lines.join(''), other.join(''))).to.equal(false);
  });
});

describe('mergeText with what is known of the texts behind the two', () => {
  // One paragraph, shortened here over two saves.
  const start = doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter and ponies.');
  const shorter = doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter.');
  const shortest = doc('# Unicorns', 'They are rare.', 'They like rainbows.');
  // The other device saw only the first of those, and changed another paragraph.
  const theirs = doc('# Unicorns', 'They are very rare.', 'They like rainbows and glitter.');
  const behindLocal = [start, shorter];

  it('refuses without it: a paragraph shortened twice looks like two people changing it', () => {
    expect(mergeText(start, shortest, theirs)).to.deep.equal({ clean: false, reason: 'overlap' });
  });

  it('takes the text here where the other version has an earlier moment of it', () => {
    expect(mergeText(start, shortest, theirs, { behindLocal, behindBoth: [] })).to.deep.equal({
      clean: true,
      merged: doc('# Unicorns', 'They are very rare.', 'They like rainbows.'),
    });
  });

  it('still refuses when the other version has that place as it never was here', () => {
    const reworded = doc('# Unicorns', 'They are very rare.', 'They love rainbows and glitter.');
    expect(mergeText(start, shortest, reworded, { behindLocal, behindBoth: [] })).to.deep.equal({
      clean: false,
      reason: 'overlap',
    });
  });

  describe('where the text here is an earlier version from the other writer', () => {
    const base = doc('# Unicorns', 'They are rare.', 'They like rainbows');
    // Their first version typed a word. It was taken in here, and the title changed here.
    const theirFirst = doc('# Unicorns', 'They are rare.', 'They like rainbows and');
    const mine = doc('# Unicorns!', 'They are rare.', 'They like rainbows and');
    // Their next version took the word out again and changed another paragraph.
    const backAgain = doc('# Unicorns', 'They are very rare.', 'They like rainbows');
    const wordGone = doc('# Unicorns!', 'They are very rare.', 'They like rainbows');
    const wordKept = doc('# Unicorns!', 'They are very rare.', 'They like rainbows and');

    it('takes their later version, even one that is back to what it was', () => {
      // By the starting text alone, the word looks like something only this side has.
      expect(merged(base, mine, backAgain)).to.equal(wordKept);
      const result = mergeText(base, mine, backAgain, {
        behindLocal: [base, theirFirst],
        behindBoth: [{ text: theirFirst, since: [mine] }],
      });
      expect(result).to.deep.equal({ clean: true, merged: wordGone });
    });

    it('does not when that place was changed here since', () => {
      const typedOn = doc('# Unicorns!', 'They are rare.', 'They like rainbows and glitter');
      const result = mergeText(base, typedOn, backAgain, {
        behindLocal: [base, theirFirst],
        behindBoth: [{ text: theirFirst, since: [typedOn] }],
      });
      expect(result).to.deep.equal({
        clean: true,
        merged: doc('# Unicorns!', 'They are very rare.', 'They like rainbows and glitter'),
      });
      // Nor when it was changed and then put back: that was done here, on purpose.
      const putBack = mergeText(base, mine, backAgain, {
        behindLocal: [base, theirFirst, typedOn],
        behindBoth: [{ text: theirFirst, since: [typedOn, mine] }],
      });
      expect(putBack).to.deep.equal({ clean: true, merged: wordKept });
    });

    it('leaves the word in when their version with it had been set aside for the text they are back to', () => {
      // Their device may simply have lost the word to the version that replaced it.
      const result = mergeText(base, mine, backAgain, {
        behindLocal: [base, theirFirst],
        behindBoth: [{ text: theirFirst, since: [mine], replacedBy: base }],
      });
      expect(result).to.deep.equal({ clean: true, merged: wordKept });
    });

    it('goes on from a set-aside version when their next one plainly does', () => {
      const long = doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter and ponies');
      const cutOnce = doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter');
      const here = doc('# Unicorns!', 'They are rare.', 'They like rainbows and glitter');
      const cutTwice = doc('# Unicorns', 'They are rare.', 'They like rainbows');
      const history = {
        behindLocal: [long, cutOnce],
        behindBoth: [{ text: cutOnce, since: [here], replacedBy: long }],
      };
      expect(mergeText(long, here, cutTwice).clean).to.equal(false);
      expect(mergeText(long, here, cutTwice, history)).to.deep.equal({
        clean: true,
        merged: doc('# Unicorns!', 'They are rare.', 'They like rainbows'),
      });
      // Something else in that place is not the same writing further along.
      const other = doc('# Unicorns', 'They are rare.', 'They like rainbows or ponies');
      expect(mergeText(long, here, other, history).clean).to.equal(false);
    });
  });
});

describe('holdsChangesOf', () => {
  const from = doc('# Unicorns', 'They are rare.', 'They like rainbows');
  const to = doc('# Unicorns', 'They are rare.', 'They like rainbows and');

  it('holds a change it has as it was made, or as it was made again since', () => {
    const withIt = doc('# Unicorns!', 'They are rare.', 'They like rainbows and');
    expect(holdsChangesOf(withIt, from, to, [])).to.equal(true);
    const later = doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter');
    const withLater = doc('# Unicorns!', 'They are rare.', 'They like rainbows and glitter');
    expect(holdsChangesOf(withLater, from, to, [later])).to.equal(true);
  });

  it('does not hold a change it was written without', () => {
    const without = doc('# Unicorns!', 'They are rare.', 'They like rainbows');
    expect(holdsChangesOf(without, from, to, [])).to.equal(false);
  });
});
