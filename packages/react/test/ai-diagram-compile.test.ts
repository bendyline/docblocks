import { expect } from 'chai';
import {
  detectAsciiTimeline,
  parseAsciiTimeline,
  renderAsciiTimeline,
  validateMarkdownSource,
} from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { validateMermaidSource } from '@bendyline/squisq-editor-react';

import { compileDiagram, mermaidNumber, timelinePoint } from '../src/Ai/diagram-compile.js';
import { checkGrounding, extractNumbers } from '../src/Ai/diagram-grounding.js';
import type { DiagramSpec } from '../src/Ai/diagram-spec.js';
import { validateCompiledDiagram } from '../src/Ai/diagram-validate.js';

const SPECS: readonly DiagramSpec[] = [
  {
    kind: 'flow',
    direction: 'TD',
    nodes: [
      { key: 'a', label: 'Draft page', shape: 'start' },
      { key: 'b', label: 'Approved?', shape: 'decision' },
      { key: 'c', label: 'Publish', shape: 'end' },
    ],
    edges: [
      { from: 'a', to: 'b', label: '' },
      { from: 'b', to: 'c', label: 'Yes' },
    ],
  },
  {
    kind: 'sequence',
    participants: ['Browser', 'Server'],
    steps: [
      { from: 0, to: 1, text: 'Send login', reply: false },
      { from: 1, to: 0, text: 'Return token', reply: true },
    ],
  },
  {
    kind: 'hierarchy',
    root: 'Vehicle',
    children: [
      { label: 'Engine', children: ['Pistons', 'Crankshaft'] },
      { label: 'Body', children: [] },
    ],
  },
  {
    kind: 'chart',
    type: 'bar',
    title: 'Revenue',
    unit: 'USD m',
    labels: ['Q1', 'Q2'],
    values: [1.2, 1800],
  },
  {
    kind: 'chart',
    type: 'line',
    title: '',
    unit: '',
    labels: ['2019', '2020', '2021'],
    values: [10, 12.5, -3],
  },
  {
    kind: 'chart',
    type: 'pie',
    title: 'Share',
    unit: '',
    labels: ['Chrome', 'Safari'],
    values: [64.2, 18],
  },
  {
    kind: 'timeline',
    events: [
      { when: '2019', label: 'Company founded' },
      { when: 'Q3 2021', label: 'First product: Series B' },
      { when: 'March 2023', label: 'Berlin office' },
    ],
  },
  {
    kind: 'steps',
    steps: [
      { label: 'Sign up', detail: '# create an account' },
      { label: 'Verify', detail: '' },
      { label: 'Start', detail: '' },
    ],
  },
  {
    kind: 'steps',
    steps: ['Draft', 'Review', 'Sign', 'Publish', 'Notify', 'Monitor'].map((label) => ({
      label,
      detail: '',
    })),
  },
  { kind: 'cycle', stages: ['Plan', 'Build', 'Measure', 'Learn'] },
  {
    kind: 'comparison',
    columns: [
      { heading: 'Option A', points: ['Lower cost', 'Slower setup'] },
      { heading: 'Option B', points: ['Higher cost', 'Ready today'] },
    ],
  },
  {
    kind: 'stats',
    stats: [
      { value: '42%', label: 'return weekly' },
      { value: '3x', label: 'faster setup' },
    ],
  },
];

describe('compileDiagram', () => {
  for (const spec of SPECS) {
    const variant =
      spec.kind === 'chart'
        ? ` (${spec.type})`
        : spec.kind === 'steps'
          ? ` (${String(spec.steps.length)})`
          : '';
    it(`compiles a ${spec.kind}${variant} that renders cleanly`, async () => {
      const compiled = compileDiagram(spec, { title: `About ${spec.kind}` });
      expect(await validateCompiledDiagram(compiled, validateMermaidSource)).to.deep.equal({
        ok: true,
      });
      if (compiled.mermaidSource) {
        const parsed = await validateMermaidSource(compiled.mermaidSource);
        expect(parsed.ok, compiled.mermaidSource).to.equal(true);
        expect(compiled.mermaidSource).to.contain(`accTitle: About ${spec.kind}`);
        expect(compiled.mermaidSource).to.match(/accDescr: \S/u);
      }
      // In a real document, at the depth it would get, nothing is flagged.
      const markdown = compiled.render(3, new Set());
      const document = `## Section\n\nIntro text.\n\n${markdown}\n\n## Next\n\nMore text.\n`;
      const flagged = validateMarkdownSource(document).diagnostics.filter(
        (diagnostic) => diagnostic.severity !== 'info',
      );
      expect(flagged, markdown).to.deep.equal([]);
    });
  }

  it('places fences after the passage and heading blocks at the section end', () => {
    const placements = SPECS.map((spec) => [
      spec.kind,
      compileDiagram(spec, { title: '' }).placement,
    ]);
    expect(Object.fromEntries(placements)).to.deep.equal({
      flow: 'afterBlock',
      sequence: 'afterBlock',
      hierarchy: 'afterBlock',
      chart: 'afterBlock',
      timeline: 'afterBlock',
      steps: 'sectionEnd',
      cycle: 'sectionEnd',
      comparison: 'sectionEnd',
      stats: 'sectionEnd',
    });
  });

  it('never lets model text break out of the generated syntax', async () => {
    const hostile: DiagramSpec = {
      kind: 'flow',
      direction: 'TD',
      nodes: [
        { key: 'a', label: 'x"] --> evil["y', shape: 'step' },
        { key: 'b', label: '%%{init: {"theme":"forest"}}%%\nclick b call alert()', shape: 'step' },
        { key: 'end', label: '```\n# Heading', shape: 'decision' },
      ],
      edges: [
        { from: 'a', to: 'b', label: '|"label"|' },
        { from: 'b', to: 'end', label: '' },
      ],
    };
    const compiled = compileDiagram(hostile, { title: 'Hostile; "title"\nnext' });
    const source = compiled.mermaidSource ?? '';
    expect(source).not.to.contain('%%{');
    expect(source).not.to.contain('```');
    expect(source.split('\n').some((line) => /^\s*click\b/u.test(line))).to.equal(false);
    // Ids come from the compiler, never the model (`end` is a Mermaid keyword).
    expect(source).to.contain('n3{');
    expect(source).not.to.match(/\bend\{/u);
    expect((await validateMermaidSource(source)).ok).to.equal(true);
  });

  it('builds drawing ids that avoid ids already in the document', () => {
    const compiled = compileDiagram(SPECS.find((spec) => spec.kind === 'steps') as DiagramSpec, {
      title: 'Plan',
    });
    const markdown = compiled.render(3, new Set(['ai-plan', 'ai-plan-sign-up']));
    expect(markdown).to.contain('### Plan {#ai-plan-2} {[drawing]}');
    expect(markdown).to.contain('{#ai-plan-2-sign-up}');
    expect(markdown).to.contain('\\# create an account');
  });

  it('renders heading blocks at the requested depth with children one deeper', () => {
    const compiled = compileDiagram(SPECS.find((spec) => spec.kind === 'stats') as DiagramSpec, {
      title: 'Numbers',
    });
    const depths = parseMarkdown(compiled.render(4, new Set()))
      .children.filter((node) => node.type === 'heading')
      .map((node) => (node.type === 'heading' ? node.depth : 0));
    expect(depths).to.deep.equal([4, 5, 5, 5, 5]);
  });

  it('spaces timeline events in proportion to their dates, and round-trips', () => {
    const compiled = compileDiagram(SPECS.find((spec) => spec.kind === 'timeline') as DiagramSpec, {
      title: 'History',
    });
    const markdown = compiled.render(2, new Set());
    const body = markdown.split('\n').slice(1, -1).join('\n');
    expect(detectAsciiTimeline(body, { explicit: true }).isTimeline).to.equal(true);
    const parsed = parseAsciiTimeline(body);
    expect(parsed.warnings).to.deep.equal([]);
    expect(renderAsciiTimeline(parsed)).to.equal(body);
    const columns = parsed.tracks[0]?.events.map((event) => event.column) ?? [];
    expect(columns[0]).to.equal(0);
    expect(columns[2]).to.equal(60);
    expect(columns[1]).to.be.within(30, 40);
  });

  it('reads the date formats prose uses', () => {
    expect(timelinePoint('2019')).to.equal(2019);
    expect(timelinePoint('Q3 2021')).to.equal(2021.5);
    expect(timelinePoint('March 2023')).to.be.closeTo(2023.1667, 0.001);
    expect(timelinePoint('2024-07-01')).to.be.closeTo(2024.5, 0.01);
    expect(timelinePoint('the early years')).to.equal(null);
  });

  it('writes numbers in a form Mermaid accepts', () => {
    expect(mermaidNumber(1800)).to.equal('1800');
    expect(mermaidNumber(0.1 + 0.2)).to.equal('0.3');
    expect(mermaidNumber(1e21)).not.to.contain('e');
    expect(mermaidNumber(-0)).to.equal('0');
  });
});

describe('checkGrounding', () => {
  const passage =
    'Revenue rose from $1.2M in Q1 to 1,800 thousand in Q2, and 45% of buyers came back. ' +
    'The company was founded in 2019 and opened Berlin in March 2023.';

  it('accepts numbers copied in any common form', () => {
    expect(extractNumbers('$3.5M and 45%')).to.include.members([3.5, 3_500_000, 45, 0.45]);
    const chart: DiagramSpec = {
      kind: 'chart',
      type: 'bar',
      title: 'Revenue',
      unit: '',
      labels: ['Q1', 'Q2'],
      values: [1.2, 1800],
    };
    expect(checkGrounding(chart, passage)).to.deep.equal({ ok: true, problems: [] });
  });

  it('names invented numbers', () => {
    const chart: DiagramSpec = {
      kind: 'chart',
      type: 'bar',
      title: 'Revenue',
      unit: '',
      labels: ['Q1', 'Q2'],
      values: [1.2, 2.4],
    };
    const result = checkGrounding(chart, passage);
    expect(result.ok).to.equal(false);
    expect(result.problems[0]).to.contain('2.4');
  });

  it('names invented dates and accepts copied ones', () => {
    const ok: DiagramSpec = {
      kind: 'timeline',
      events: [
        { when: '2019', label: 'Company founded' },
        { when: 'March 2023', label: 'Berlin opened' },
      ],
    };
    expect(checkGrounding(ok, passage).ok).to.equal(true);
    const invented: DiagramSpec = {
      kind: 'timeline',
      events: [
        { when: '2019', label: 'Company founded' },
        { when: '2025', label: 'Berlin opened' },
      ],
    };
    expect(checkGrounding(invented, passage).problems[0]).to.contain('2025');
  });

  it('rejects labels mostly unrelated to the passage', () => {
    const offTopic: DiagramSpec = {
      kind: 'cycle',
      stages: ['Photosynthesis', 'Respiration', 'Germination'],
    };
    const result = checkGrounding(offTopic, passage);
    expect(result.ok).to.equal(false);
    expect(result.problems[0]).to.contain('"Photosynthesis"');
  });
});
