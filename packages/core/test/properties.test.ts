import { expect } from 'chai';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import {
  DOCUMENT_PROPERTY_LIMITS,
  DocumentPropertyError,
  addDays,
  addMonths,
  applyDocumentProperties,
  compareDue,
  completedOn,
  countChecklist,
  countChecklistLines,
  daysBetween,
  describeDue,
  dueDate,
  dueTime,
  hasTaskProperties,
  isCompleted,
  isLocalDate,
  localDateOf,
  nextOccurrence,
  normalizeDue,
  parseCapture,
  readDocumentProperties,
  weekdayOf,
} from '../src/properties/index.js';

describe('properties: calendar dates', () => {
  it('accepts only days that exist', () => {
    expect(isLocalDate('2026-11-23')).to.equal(true);
    expect(isLocalDate('2028-02-29')).to.equal(true);
    expect(isLocalDate('2026-02-29')).to.equal(false);
    expect(isLocalDate('2026-02-30')).to.equal(false);
    expect(isLocalDate('2026-13-01')).to.equal(false);
    expect(isLocalDate('2026-1-5')).to.equal(false);
    expect(isLocalDate(20261123)).to.equal(false);
  });

  it('normalizes a due value to a day or a minute on that day', () => {
    expect(normalizeDue('2026-11-25')).to.equal('2026-11-25');
    expect(normalizeDue(' 2026-11-25T15:00 ')).to.equal('2026-11-25T15:00');
    expect(normalizeDue('2026-11-25 15:00:30')).to.equal('2026-11-25T15:00');
    expect(normalizeDue('2026-11-25T25:00')).to.equal(null);
    expect(normalizeDue('2026-02-30')).to.equal(null);
    expect(normalizeDue('tomorrow')).to.equal(null);
    expect(normalizeDue(42)).to.equal(null);
    expect(dueDate('2026-11-25T15:00')).to.equal('2026-11-25');
    expect(dueTime('2026-11-25T15:00')).to.equal('15:00');
    expect(dueTime('2026-11-25')).to.equal(null);
  });

  it('reads the local day of an instant, not the UTC one', () => {
    // 23:30 local on the 23rd is the 23rd, whatever the UTC date is.
    expect(localDateOf(new Date(2026, 10, 23, 23, 30))).to.equal('2026-11-23');
    expect(localDateOf(new Date(2026, 0, 1, 0, 5))).to.equal('2026-01-01');
  });

  it('counts and adds days across month, year and daylight-saving boundaries', () => {
    expect(daysBetween('2026-11-23', '2026-11-23')).to.equal(0);
    expect(daysBetween('2026-11-23', '2026-12-01')).to.equal(8);
    expect(daysBetween('2026-11-23', '2026-11-21')).to.equal(-2);
    expect(daysBetween('2026-03-07', '2026-03-09')).to.equal(2);
    expect(addDays('2026-12-31', 1)).to.equal('2027-01-01');
    expect(addDays('2028-02-28', 1)).to.equal('2028-02-29');
    expect(addDays('2026-11-01', -1)).to.equal('2026-10-31');
    expect(weekdayOf('2026-11-23')).to.equal(1);
    expect(() => addDays('2026-02-30', 1)).to.throw(RangeError);
  });

  it('keeps the day of the month when adding months, clamping to a short month', () => {
    expect(addMonths('2026-01-31', 1)).to.equal('2026-02-28');
    expect(addMonths('2026-11-30', 3)).to.equal('2027-02-28');
    expect(addMonths('2026-11-15', 2)).to.equal('2027-01-15');
    expect(addMonths('2026-03-15', -4)).to.equal('2025-11-15');
  });

  it('describes a due value against today', () => {
    expect(describeDue('2026-11-23', '2026-11-23')).to.deep.equal({ status: 'today', days: 0 });
    expect(describeDue('2026-11-24T09:00', '2026-11-23')).to.deep.equal({
      status: 'tomorrow',
      days: 1,
    });
    expect(describeDue('2026-11-21', '2026-11-23')).to.deep.equal({ status: 'overdue', days: -2 });
    expect(describeDue('2026-12-05', '2026-11-23').status).to.equal('upcoming');
    expect(compareDue('2026-11-23', '2026-11-23T08:00')).to.equal(-1);
    expect(compareDue('2026-11-24', '2026-11-23T08:00')).to.equal(1);
  });

  it('schedules the next occurrence after both the due date and today', () => {
    expect(nextOccurrence('2026-11-23', 'daily', '2026-11-23')).to.equal('2026-11-24');
    expect(nextOccurrence('2026-11-23', 'weekly', '2026-11-23')).to.equal('2026-11-30');
    // Finished three weeks late: next week's, not three stale ones.
    expect(nextOccurrence('2026-11-02', 'weekly', '2026-11-23')).to.equal('2026-11-30');
    // Finished early: still a week after the date it was due.
    expect(nextOccurrence('2026-11-27', 'weekly', '2026-11-23')).to.equal('2026-12-04');
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-01-31')).to.equal('2026-02-28');
    // Counted from the original day, so it returns to the 31st.
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-03-01')).to.equal('2026-03-31');
    expect(nextOccurrence('2024-02-29', 'yearly', '2026-11-23')).to.equal('2027-02-28');
    expect(nextOccurrence('2026-11-23T09:30', 'daily', '2026-11-23')).to.equal('2026-11-24T09:30');
  });
});

describe('properties: reading frontmatter', () => {
  const read = (markdown: string) => readDocumentProperties(parseMarkdown(markdown).frontmatter);

  it('reads the properties Squisq parses out of a document', () => {
    const properties = read(
      [
        '---',
        'title: Renew passport',
        'due: 2026-12-05',
        'category: Home',
        'tags:',
        '  - travel',
        '  - paperwork',
        'repeat: Yearly',
        '---',
        '',
        'Photos are in the drawer.',
      ].join('\n'),
    );
    expect(properties).to.deep.equal({
      due: '2026-12-05',
      category: 'Home',
      tags: ['travel', 'paperwork'],
      repeat: 'yearly',
    });
    expect(hasTaskProperties(properties)).to.equal(true);
    expect(isCompleted(properties)).to.equal(false);
  });

  it('reads flow lists, comma lists and hash-prefixed tags', () => {
    expect(read('---\ntags: [client, "q4", #urgent]\n---\n').tags).to.deep.equal([
      'client',
      'q4',
      'urgent',
    ]);
    expect(read('---\nkeywords: a, b, a\n---\n').tags).to.deep.equal(['a', 'b']);
    expect(read('---\ntags: []\n---\n').tags).to.equal(undefined);
  });

  it('leaves out what it cannot understand and never throws', () => {
    expect(
      read('---\ndue: next tuesday\ncategory: 7\nrepeat: fortnightly\ncompleted: no\n---\n'),
    ).to.deep.equal({});
    expect(readDocumentProperties(undefined)).to.deep.equal({});
    expect(readDocumentProperties({ due: 20261205, tags: 9, completed: 0 })).to.deep.equal({});
    expect(hasTaskProperties({ tags: ['a'], category: 'Home' })).to.equal(false);
  });

  it('reads completion as a day, or as true when no day is given', () => {
    expect(read('---\ncompleted: 2026-11-23\n---\n').completed).to.equal('2026-11-23');
    expect(read('---\ncompleted: true\n---\n').completed).to.equal(true);
    expect(read('---\ncompleted: 2026-11-23T18:45\n---\n').completed).to.equal('2026-11-23');
    expect(completedOn({ completed: '2026-11-23' })).to.equal('2026-11-23');
    expect(completedOn({ completed: true })).to.equal(null);
    expect(isCompleted({ completed: true })).to.equal(true);
    expect(readDocumentProperties({ completed: new Date('2026-11-23T00:00:00Z') })).to.deep.equal({
      completed: '2026-11-23',
    });
  });

  it('bounds category and tag lengths', () => {
    const long = 'x'.repeat(200);
    const properties = readDocumentProperties({ category: long, tags: [long] });
    expect(properties.category).to.have.length(DOCUMENT_PROPERTY_LIMITS.maxCategoryCharacters);
    expect(properties.tags?.[0]).to.have.length(DOCUMENT_PROPERTY_LIMITS.maxTagCharacters);
    const many = Array.from({ length: 80 }, (_unused, index) => `t${index}`);
    expect(readDocumentProperties({ tags: many }).tags).to.have.length(
      DOCUMENT_PROPERTY_LIMITS.maxTags,
    );
  });
});

describe('properties: writing frontmatter', () => {
  const read = (markdown: string) => readDocumentProperties(parseMarkdown(markdown).frontmatter);

  it('adds a frontmatter block to a document that has none', async () => {
    const next = await applyDocumentProperties('Buy the paint.\n', {
      due: '2026-11-25',
      category: 'Home',
    });
    expect(next).to.equal('---\ndue: 2026-11-25\ncategory: Home\n---\n\nBuy the paint.\n');
  });

  it('changes only the named keys and keeps the rest of the block as written', async () => {
    const source = [
      '---',
      'title: Proposal   # the big one',
      'squisq-theme: warm-earth',
      'due: 2026-11-25',
      'tags: [acme, q4]',
      '---',
      '',
      '# Proposal',
      '',
    ].join('\n');
    const next = await applyDocumentProperties(source, {
      due: '2026-12-01T09:00',
      completed: '2026-11-23',
    });
    expect(next).to.equal(
      [
        '---',
        'title: Proposal   # the big one',
        'squisq-theme: warm-earth',
        // Squisq quotes a value holding a colon; it reads back as the same text.
        'due: "2026-12-01T09:00"',
        'tags: [acme, q4]',
        'completed: 2026-11-23',
        '---',
        '',
        '# Proposal',
        '',
      ].join('\n'),
    );
    expect(read(next)).to.deep.equal({
      due: '2026-12-01T09:00',
      tags: ['acme', 'q4'],
      completed: '2026-11-23',
    });
  });

  it('removes a key for null and for an emptied value', async () => {
    const source =
      '---\ndue: 2026-11-25\ncategory: Home\ntags:\n  - a\ncompleted: true\n---\n\nx\n';
    const next = await applyDocumentProperties(source, {
      due: null,
      category: '  ',
      tags: [],
      completed: null,
    });
    expect(read(next)).to.deep.equal({});
    expect(next).to.not.include('due');
    expect(next).to.not.include('tags');
  });

  it('writes what it reads back: values survive a round trip', async () => {
    const patch = {
      due: '2026-11-25T15:00',
      category: 'Clients: Acme',
      tags: ['a b', 'c#d', '#lead'],
      repeat: 'monthly',
      completed: true,
    } as const;
    const next = await applyDocumentProperties('Body.\n', patch);
    expect(read(next)).to.deep.equal({
      due: '2026-11-25T15:00',
      category: 'Clients: Acme',
      tags: ['a b', 'c#d', 'lead'],
      repeat: 'monthly',
      completed: true,
    });
    expect(next.endsWith('\nBody.\n')).to.equal(true);
  });

  it('returns the same source when the patch names nothing', async () => {
    const source = '---\ndue: 2026-11-25\n---\n\nx\n';
    expect(await applyDocumentProperties(source, {})).to.equal(source);
  });

  it('refuses values that are not a form of the property', async () => {
    const attempts: Array<[Parameters<typeof applyDocumentProperties>[1], string]> = [
      [{ due: '25/11/2026' }, 'due'],
      [{ due: '2026-02-30' }, 'due'],
      [{ completed: '2026-13-01' }, 'completed'],
      [{ repeat: 'fortnightly' as never }, 'repeat'],
      [{ tags: ['a, b'] }, 'tags'],
      [{ category: 'x'.repeat(65) }, 'category'],
    ];
    for (const [patch, key] of attempts) {
      let caught: unknown;
      try {
        await applyDocumentProperties('x\n', patch);
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught, key).to.be.instanceOf(DocumentPropertyError);
      expect((caught as DocumentPropertyError).key).to.equal(key);
    }
  });
});

describe('properties: capture', () => {
  // A Monday.
  const today = '2026-11-23';
  const capture = (text: string) => parseCapture(text, today);

  it('takes a relative day out of the text', () => {
    expect(capture('Call Priya tomorrow')).to.deep.equal({
      title: 'Call Priya',
      due: '2026-11-24',
    });
    expect(capture('Pay rent today')).to.deep.equal({ title: 'Pay rent', due: '2026-11-23' });
    expect(capture('Plan offsite next week')).to.deep.equal({
      title: 'Plan offsite',
      due: '2026-11-30',
    });
    expect(capture('Renew licence in 3 weeks')).to.deep.equal({
      title: 'Renew licence',
      due: '2026-12-14',
    });
    expect(capture('Review budget next month')).to.deep.equal({
      title: 'Review budget',
      due: '2026-12-23',
    });
  });

  it('reads weekdays as the next one to come, never today', () => {
    expect(capture('Send invoice friday')).to.deep.equal({
      title: 'Send invoice',
      due: '2026-11-27',
    });
    expect(capture('Standup notes on Monday')).to.deep.equal({
      title: 'Standup notes',
      due: '2026-11-30',
    });
    expect(capture('Dentist next Thursday')).to.deep.equal({ title: 'Dentist', due: '2026-11-26' });
    expect(capture('Dentist by thu')).to.deep.equal({ title: 'Dentist', due: '2026-11-26' });
    expect(capture('Water plants sat')).to.deep.equal({ title: 'Water plants', due: '2026-11-28' });
  });

  it('does not mistake ordinary words for weekdays', () => {
    expect(capture('The cat sat on the mat')).to.deep.equal({ title: 'The cat sat on the mat' });
    expect(capture('Buy sun cream for the trip')).to.deep.equal({
      title: 'Buy sun cream for the trip',
    });
    expect(capture('Sam may call about the fee')).to.deep.equal({
      title: 'Sam may call about the fee',
    });
  });

  it('reads calendar dates, this year or next', () => {
    expect(capture('Book flights dec 1')).to.deep.equal({
      title: 'Book flights',
      due: '2026-12-01',
    });
    expect(capture('Taxes due 15th of April')).to.deep.equal({ title: 'Taxes', due: '2027-04-15' });
    expect(capture('Party on November 23rd')).to.deep.equal({ title: 'Party', due: '2026-11-23' });
    expect(capture('Ship 2027-01-09')).to.deep.equal({ title: 'Ship', due: '2027-01-09' });
    expect(capture('Leap day feb 30')).to.deep.equal({ title: 'Leap day feb 30' });
  });

  it('attaches a time, and takes a time alone to mean today', () => {
    expect(capture('Call Sam tomorrow at 3pm')).to.deep.equal({
      title: 'Call Sam',
      due: '2026-11-24T15:00',
    });
    expect(capture('Lunch friday 12:30 pm')).to.deep.equal({
      title: 'Lunch',
      due: '2026-11-27T12:30',
    });
    expect(capture('Stand-up at 09:15')).to.deep.equal({
      title: 'Stand-up',
      due: '2026-11-23T09:15',
    });
    expect(capture('Meet at 3 Main St')).to.deep.equal({ title: 'Meet at 3 Main St' });
    expect(capture('Backup at midnight')).to.deep.equal({
      title: 'Backup',
      due: '2026-11-23T00:00',
    });
  });

  it('uses the last date phrase, and keeps the words when nothing else is left', () => {
    expect(capture('Move tomorrow meeting to friday')).to.deep.equal({
      title: 'Move tomorrow meeting to',
      due: '2026-11-27',
    });
    expect(capture('Tomorrow')).to.deep.equal({ title: 'Tomorrow', due: '2026-11-24' });
    expect(capture('  Tidy   the   desk  ')).to.deep.equal({ title: 'Tidy the desk' });
  });
});

describe('properties: checklist progress', () => {
  it('counts checklist items at any depth and ignores plain list items', () => {
    const document = parseMarkdown(
      [
        '# Party',
        '',
        '- [x] Pick a date',
        '- [ ] Invitations',
        '  - [x] Draft',
        '  - [ ] Print',
        '- A plain item',
        '',
        '> - [X] Quoted and done',
      ].join('\n'),
    );
    expect(countChecklist(document)).to.deep.equal({ done: 3, total: 5 });
    expect(countChecklist(parseMarkdown('- one\n- two\n'))).to.equal(undefined);
    expect(countChecklist(null)).to.equal(undefined);
  });

  it('counts from raw lines for a document too large to parse', () => {
    expect(countChecklistLines('- [x] a\n* [ ] b\n1. [X] c\ntext [ ] not one\n')).to.deep.equal({
      done: 2,
      total: 3,
    });
    expect(countChecklistLines('nothing here')).to.equal(undefined);
  });
});
