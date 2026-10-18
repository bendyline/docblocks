import { expect } from 'chai';

import { extractJson } from '../src/Ai/ai-json.js';
import { bodyLine, cleanLabel, clip, slugId } from '../src/Ai/diagram-sanitize.js';
import { parseDiagramSpec, parseLooseNumber } from '../src/Ai/diagram-spec.js';

describe('extractJson', () => {
  it('finds JSON wrapped in prose, a code fence, or a reasoning block', () => {
    expect(extractJson('Sure! Here it is:\n{"a":1}\nHope that helps.', 'object')).to.deep.equal({
      ok: true,
      value: { a: 1 },
    });
    expect(extractJson('```json\n[1, 2]\n```', 'array')).to.deep.equal({ ok: true, value: [1, 2] });
    expect(extractJson('<think>maybe {"no":1}</think>{"yes":2}', 'object')).to.deep.equal({
      ok: true,
      value: { yes: 2 },
    });
  });

  it('tolerates trailing commas and brackets inside strings', () => {
    expect(extractJson('{"a": "x]}", "b": [1, 2,],}', 'object')).to.deep.equal({
      ok: true,
      value: { a: 'x]}', b: [1, 2] },
    });
  });

  it('skips a bracketed aside to find the real value', () => {
    expect(extractJson('Steps [see below]: [{"p":1}]', 'array')).to.deep.equal({
      ok: true,
      value: [{ p: 1 }],
    });
  });

  it('explains why it found nothing usable', () => {
    expect(extractJson('No JSON here.', 'object')).to.deep.equal({
      ok: false,
      problem: 'The reply has no JSON object.',
    });
    const cut = extractJson('{"nodes": [{"id": "a"', 'object');
    expect(cut.ok).to.equal(false);
    expect(cut.ok ? '' : cut.problem).to.contain('cut off');
    const thinking = extractJson('<think>still going', 'object');
    expect(thinking.ok ? '' : thinking.problem).to.contain('reasoning');
  });
});

describe('diagram label sanitizing', () => {
  it('swaps characters that are syntax in Mermaid or annotations for look-alikes', () => {
    expect(cleanLabel('Say "hi"; then {go} [now] | <done> \\ `x`', 80)).to.equal(
      "Say 'hi', then (go) (now) / ‹done› / 'x'",
    );
  });

  it('flattens line breaks so a label can never start a new statement', () => {
    expect(cleanLabel('A\n%%{init: {"theme":"dark"}}%%\nB', 80)).to.equal(
      "A %%(init: ('theme':'dark'))%% B",
    );
  });

  it('clips at a word boundary with an ellipsis', () => {
    expect(clip('one two three four five', 14)).to.equal('one two three…');
    expect(clip('short', 14)).to.equal('short');
  });

  it('escapes body lines that markdown would read as structure', () => {
    expect(bodyLine('# Not a heading', 40)).to.equal('\\# Not a heading');
    expect(bodyLine('- not a list', 40)).to.equal('\\- not a list');
    expect(bodyLine('1. not a list', 40)).to.equal('\\1. not a list');
    expect(bodyLine('Plain text', 40)).to.equal('Plain text');
  });

  it('builds unique readable ids', () => {
    const taken = new Set(['ai-plan']);
    expect(slugId('ai', 'Plan', taken)).to.equal('ai-plan-2');
    expect(slugId('ai', 'Plan', taken)).to.equal('ai-plan-3');
    expect(slugId('ai', '!!!', taken)).to.equal('ai');
  });
});

describe('parseLooseNumber', () => {
  it('reads numbers the way prose writes them', () => {
    expect(parseLooseNumber('1,200')).to.equal(1200);
    expect(parseLooseNumber('$3.5')).to.equal(3.5);
    expect(parseLooseNumber('45%')).to.equal(45);
    expect(parseLooseNumber('−2')).to.equal(-2);
    expect(parseLooseNumber(7)).to.equal(7);
    expect(parseLooseNumber('about 7')).to.equal(null);
  });
});

describe('parseDiagramSpec', () => {
  it('reads a flowchart and resolves edges given by label', () => {
    const result = parseDiagramSpec(
      'flow',
      JSON.stringify({
        direction: 'LR',
        nodes: [
          { id: 'a', label: 'Draft', shape: 'start' },
          { id: 'b', label: 'Approved?', shape: 'question' },
          { label: 'Publish' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'Approved?', to: 'Publish', label: 'Yes' },
          { from: 'a', to: 'missing' },
        ],
      }),
    );
    expect(result.ok).to.equal(true);
    if (!result.ok || result.spec.kind !== 'flow') return;
    expect(result.spec.direction).to.equal('LR');
    expect(result.spec.nodes.map((node) => node.shape)).to.deep.equal([
      'start',
      'decision',
      'step',
    ]);
    expect(result.spec.edges).to.deep.equal([
      { from: 'a', to: 'b', label: '' },
      { from: 'b', to: 'node3', label: 'Yes' },
    ]);
    expect(result.notes).to.deep.equal(['Dropped 1 link(s) to unknown boxes.']);
  });

  it('rejects a spec that cannot make a useful diagram, saying why', () => {
    const result = parseDiagramSpec('steps', '{"steps":["Only one"]}');
    expect(result).to.deep.equal({ ok: false, problem: 'It needs at least 3 steps, but has 1.' });
  });

  it('trims oversized lists and records the trim', () => {
    const result = parseDiagramSpec(
      'cycle',
      JSON.stringify({ stages: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }),
    );
    expect(result.ok).to.equal(true);
    if (!result.ok || result.spec.kind !== 'cycle') return;
    expect(result.spec.stages).to.have.length(6);
    expect(result.notes).to.deep.equal(['Kept the first 6 stages of 8.']);
  });

  it('coerces chart values written as strings and pairs them with labels', () => {
    const result = parseDiagramSpec(
      'chart',
      '{"type":"Bar chart","labels":["Q1","Q2"],"values":["1,200","$1,800"],"unit":"USD"}',
    );
    expect(result.ok).to.equal(true);
    if (!result.ok || result.spec.kind !== 'chart') return;
    expect(result.spec).to.include({ type: 'bar', unit: 'USD' });
    expect(result.spec.values).to.deep.equal([1200, 1800]);
  });

  it('refuses chart values that are not numbers', () => {
    const result = parseDiagramSpec('chart', '{"labels":["a","b"],"values":["lots","few"]}');
    expect(result.ok ? '' : result.problem).to.contain('numbers copied from the passage');
  });

  it('adds participants first named in a message', () => {
    const result = parseDiagramSpec(
      'sequence',
      JSON.stringify({
        participants: ['Browser'],
        steps: [{ from: 'Browser', to: 'Server', text: 'Log in' }],
      }),
    );
    expect(result.ok).to.equal(true);
    if (!result.ok || result.spec.kind !== 'sequence') return;
    expect(result.spec.participants).to.deep.equal(['Browser', 'Server']);
  });

  it('reads the remaining kinds', () => {
    const cases: [Parameters<typeof parseDiagramSpec>[0], unknown][] = [
      [
        'timeline',
        {
          events: [
            { when: '2019', label: 'Founded' },
            { date: '2021', event: 'Launch' },
          ],
        },
      ],
      [
        'hierarchy',
        { root: 'Car', children: [{ label: 'Engine', children: ['Pistons'] }, 'Body'] },
      ],
      [
        'comparison',
        {
          columns: [
            { heading: 'A', points: ['x'] },
            { title: 'B', items: ['y'] },
          ],
        },
      ],
      [
        'stats',
        {
          stats: [
            { value: '42%', label: 'return' },
            { value: '3x', label: 'faster' },
          ],
        },
      ],
    ];
    for (const [kind, value] of cases) {
      const result = parseDiagramSpec(kind, JSON.stringify(value));
      expect(result.ok, kind).to.equal(true);
    }
  });

  it('reads Venn diagrams, which need something shared', () => {
    const result = parseDiagramSpec(
      'venn',
      JSON.stringify({
        sets: [{ label: 'Design', items: ['Mockups'] }, { name: 'Engineering' }, 'Research', 'Ops'],
        overlap: ['Prototypes'],
      }),
    );
    expect(result.ok && result.spec).to.deep.equal({
      kind: 'venn',
      sets: [
        { label: 'Design', items: ['Mockups'] },
        { label: 'Engineering', items: [] },
        { label: 'Research', items: [] },
      ],
      shared: ['Prototypes'],
    });
    expect(result.ok && result.notes).to.deep.equal(['Kept the first 3 sets of 4.']);
    const unshared = parseDiagramSpec('venn', '{"sets":["A","B"],"shared":[]}');
    expect(unshared.ok ? '' : unshared.problem).to.contain('"shared"');
  });

  it('reads a matrix only with all four quadrants, in order', () => {
    const quadrants = ['Quick wins', 'Big bets', 'Fill-ins', 'Money pits'].map((label) => ({
      label,
      items: ['one', 'two', 'three', 'four'],
    }));
    const result = parseDiagramSpec(
      'matrix',
      JSON.stringify({ x: 'Effort', yAxis: { label: 'Impact' }, quadrants }),
    );
    expect(result.ok && result.spec.kind === 'matrix' && result.spec).to.deep.include({
      xAxis: 'Effort',
      yAxis: 'Impact',
    });
    if (!result.ok || result.spec.kind !== 'matrix') return;
    expect(result.spec.quadrants.map((quadrant) => quadrant.label)).to.deep.equal([
      'Quick wins',
      'Big bets',
      'Fill-ins',
      'Money pits',
    ]);
    expect(result.spec.quadrants[0]?.items).to.have.length(3);
    const three = parseDiagramSpec('matrix', JSON.stringify({ quadrants: quadrants.slice(0, 3) }));
    expect(three.ok ? '' : three.problem).to.contain('at least 4 quadrants');
  });

  it('reads funnels and pyramids', () => {
    const funnel = parseDiagramSpec(
      'funnel',
      '{"stages":[{"label":"Visitors","value":10000},{"label":"Sign-ups","count":"1,200"},"Customers"]}',
    );
    expect(funnel.ok && funnel.spec).to.deep.equal({
      kind: 'funnel',
      stages: [
        { label: 'Visitors', value: '10000' },
        { label: 'Sign-ups', value: '1,200' },
        { label: 'Customers', value: '' },
      ],
    });
    const pyramid = parseDiagramSpec('pyramid', '{"layers":["Purpose","Strategy","Operations"]}');
    expect(pyramid.ok && pyramid.spec).to.deep.equal({
      kind: 'pyramid',
      levels: ['Purpose', 'Strategy', 'Operations'],
    });
    const short = parseDiagramSpec('pyramid', '{"levels":["Top","Base"]}');
    expect(short.ok ? '' : short.problem).to.contain('at least 3 levels');
  });
});
