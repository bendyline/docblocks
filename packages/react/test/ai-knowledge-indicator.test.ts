import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AiChatKnowledge, WorkspacePassageReference } from '@bendyline/docblocks/host';

import { AiKnowledgeIndicator } from '../src/Ai/AiKnowledgeIndicator.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const knowledge: AiChatKnowledge = {
  outcome: 'used',
  sources: [
    { catalogId: 'pnw', name: 'Pacific Northwest', titles: ['Aphid'] },
    { catalogId: 'ws-1', name: 'This workspace', titles: ['Rose bed › Pests'] },
  ],
  evidence: [
    { title: 'Aphid', catalogId: 'pnw', text: 'Sap-sucking.', uri: 'knowledge://pnw/wiki/aphid' },
    {
      title: 'Rose bed › Pests',
      catalogId: 'ws-1',
      text: 'Aphids on new growth.',
      uri: 'knowledge://local/ws-1/garden/rose%20bed.md#line=3-9',
    },
  ],
};

describe('AiKnowledgeIndicator', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("names each cited note's place, and opens it only where that is offered", () => {
    act(() => root.render(createElement(AiKnowledgeIndicator, { knowledge })));
    expect(host.querySelector('summary')?.textContent).to.contain('2 sources');
    const items = [...host.querySelectorAll('li')].map((item) => item.textContent);
    expect(items).to.deep.equal(['Aphid', 'Rose bed › Pests · garden/rose bed.md, lines 3–9']);
    expect(host.querySelector('.db-ai-knowledge-note')).to.equal(null);

    const opened: WorkspacePassageReference[] = [];
    act(() =>
      root.render(
        createElement(AiKnowledgeIndicator, {
          knowledge,
          onOpenNote: (reference) => opened.push(reference),
        }),
      ),
    );
    const open = host.querySelector<HTMLButtonElement>('.db-ai-knowledge-note');
    expect(open?.textContent).to.equal('Rose bed › Pests');
    act(() => open?.click());
    expect(opened).to.deep.equal([
      { catalogId: 'ws-1', path: 'garden/rose bed.md', lineStart: 3, lineEnd: 9 },
    ]);
  });

  it('counts notes when every source is a note', () => {
    const notes: AiChatKnowledge = {
      outcome: 'used',
      sources: [knowledge.sources[1]!],
      evidence: [knowledge.evidence[1]!],
    };
    act(() => root.render(createElement(AiKnowledgeIndicator, { knowledge: notes })));
    expect(host.querySelector('summary')?.textContent).to.contain('1 note');
  });
});
