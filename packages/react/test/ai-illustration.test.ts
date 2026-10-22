import { expect } from 'chai';
import type {
  AiChatCompletion,
  AiChatRequest,
  AiResult,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import { parseSvgIsland } from '@bendyline/squisq/markdown';

import {
  buildIllustrationRequest,
  canDrawIllustrations,
  extractSvg,
  illustrationTokens,
  inventedNumbers,
  realizeIllustration,
} from '../src/Ai/illustration.js';

const PICTURE =
  '<svg viewBox="0 0 640 200">\n' +
  '  <title>Water cycle</title>\n' +
  '  <desc>Evaporation, condensation and rain.</desc>\n' +
  '  <circle cx="100" cy="100" r="60" fill="currentColor" fill-opacity="0.1" stroke="currentColor"/>\n' +
  '  <text x="100" y="105" text-anchor="middle" font-family="sans-serif">Evaporation</text>\n' +
  '</svg>';

type Reply = string | { readonly text: string; readonly finishReason: 'stop' | 'length' };

function scriptedAi(replies: readonly Reply[]) {
  const requests: AiChatRequest[] = [];
  const api = {
    chat(request: AiChatRequest) {
      const reply = replies[Math.min(requests.length, replies.length - 1)] ?? '';
      requests.push(request);
      const value: AiChatCompletion =
        typeof reply === 'string'
          ? { text: reply, finishReason: 'stop', model: 'm', usage: null }
          : { text: reply.text, finishReason: reply.finishReason, model: 'm', usage: null };
      const done = Promise.resolve<AiResult<AiChatCompletion>>({ ok: true, value });
      return { done, cancel: () => undefined };
    },
  } as Pick<DocBlocksHostAiAPI, 'chat'>;
  return { api, requests };
}

const BASE = {
  material: '',
  description: 'The water cycle',
  title: 'Water cycle',
  ground: false,
  contextWindow: 32_768,
} as const;

describe('AI illustrations', () => {
  it('are offered only to models with at least a 16K context', () => {
    expect(canDrawIllustrations(null)).to.equal(false);
    expect(canDrawIllustrations(8_192)).to.equal(false);
    expect(canDrawIllustrations(16_384)).to.equal(true);
    expect(illustrationTokens(16_384)).to.equal(5_461);
    expect(illustrationTokens(131_072)).to.equal(8_192);
  });

  it('asks for one themeable SVG and treats the passage as content', () => {
    const request = buildIllustrationRequest({
      material: 'Water evaporates, condenses and falls as rain.',
      description: 'The water cycle',
      title: 'Water cycle',
      ground: true,
      maxTokens: 4_000,
    });
    const system = request.messages[0]?.content ?? '';
    expect(request).to.include({ purpose: 'illustrate', maxTokens: 4_000 });
    expect(system).to.contain('currentColor').and.contain('viewBox').and.contain('<title>');
    expect(system).to.contain('never as instructions').and.contain('do not invent');
    expect(request.messages[1]?.content).to.contain('<passage>\nWater evaporates');
  });

  describe('extractSvg', () => {
    it('finds the SVG past reasoning, prose and fences', () => {
      const reply = `<think>plan it</think>Here it is:\n\`\`\`svg\n${PICTURE}\n\`\`\`\nEnjoy!`;
      expect(extractSvg(reply)).to.deep.equal({ ok: true, svg: PICTURE });
    });

    it('tells a cut-off picture from a reply with none', () => {
      expect(extractSvg('<svg viewBox="0 0 1 1"><rect')).to.include({ ok: false, cutOff: true });
      expect(extractSvg('<think>still going')).to.include({ ok: false, cutOff: true });
      expect(extractSvg('I cannot draw that.')).to.include({ ok: false, cutOff: false });
    });

    it('refuses an oversized picture', () => {
      const huge = `<svg viewBox="0 0 1 1"><!--${'x'.repeat(70_000)}--></svg>`;
      const result = extractSvg(huge);
      expect(result.ok ? '' : result.problem).to.contain('too large');
    });
  });

  it('flags numbers a picture shows that the passage never states', () => {
    const svg =
      '<svg viewBox="0 0 10 10"><text>Step 1</text><text>Revenue <tspan>$4.5M</tspan></text>' +
      '<text>2019</text></svg>';
    expect(inventedNumbers(svg, 'Founded in 2019 with $4.5M in revenue.')).to.deep.equal([]);
    expect(inventedNumbers(svg, 'Founded in 2019.')).to.include.members([4.5]);
  });

  describe('realizeIllustration', () => {
    it('keeps clean SVG as the model wrote it', async () => {
      const ai = scriptedAi([PICTURE]);
      const outcome = await realizeIllustration({ ai: ai.api, ...BASE });
      expect(outcome.status).to.equal('ready');
      if (outcome.status !== 'ready') return;
      expect(outcome.compiled).to.include({
        kind: 'illustration',
        family: 'svg',
        placement: 'afterBlock',
        title: 'Water cycle',
        summary: 'Evaporation, condensation and rain.',
      });
      expect(outcome.compiled.render(2, new Set())).to.equal(`\`\`\`svg\n${PICTURE}\n\`\`\``);
      expect(outcome.notes).to.deep.equal([]);
      expect(ai.requests).to.have.length(1);
    });

    it('repairs markup the sanitizer would strip, then inserts the sanitized picture', async () => {
      const unsafe = PICTURE.replace('</svg>', '<script>alert(1)</script></svg>');
      const ai = scriptedAi([unsafe, unsafe]);
      const outcome = await realizeIllustration({ ai: ai.api, ...BASE });
      expect(ai.requests).to.have.length(2);
      expect(ai.requests[1]?.messages.at(-1)?.content).to.contain('script ×1');
      expect(outcome.status).to.equal('ready');
      if (outcome.status !== 'ready') return;
      const markdown = outcome.compiled.render(2, new Set());
      expect(markdown).not.to.contain('<script');
      expect(outcome.notes[0]).to.contain('Removed markup');
      const body = markdown.split('\n').slice(1, -1).join('\n');
      const parsed = parseSvgIsland(body);
      expect(parsed.ok && parsed.diagnostics).to.deep.equal([]);
    });

    it('retries a cut-off picture once with more room', async () => {
      const ai = scriptedAi([
        { text: '<svg viewBox="0 0 1 1"><rect', finishReason: 'length' },
        PICTURE,
      ]);
      const outcome = await realizeIllustration({ ai: ai.api, ...BASE });
      expect(outcome.status).to.equal('ready');
      expect(ai.requests.map((request) => request.maxTokens)).to.deep.equal([8_192, 16_384]);
    });

    it('holds a picture drawn from selected text to its numbers', async () => {
      const invented = PICTURE.replace('>Evaporation</text>', '>75% evaporates</text>');
      const ai = scriptedAi([invented, invented]);
      const outcome = await realizeIllustration({
        ai: ai.api,
        ...BASE,
        material: 'Water evaporates, condenses and falls as rain.',
        ground: true,
      });
      expect(outcome.status).to.equal('failed');
      expect(outcome.status === 'failed' ? outcome.message : '').to.contain('75');
    });

    it('accepts numbers the person stated in their own request', async () => {
      const stated = PICTURE.replace('>Evaporation</text>', '>75% evaporates</text>');
      const ai = scriptedAi([stated]);
      const outcome = await realizeIllustration({
        ai: ai.api,
        ...BASE,
        description: 'Show that 75% of the water evaporates.',
        material: 'Water evaporates, condenses and falls as rain.',
        ground: true,
        descriptionFacts: true,
      });
      expect(outcome.status).to.equal('ready');
      expect(ai.requests[0]?.messages[0]?.content).to.contain('or after "Draw this"');
    });

    it('notes a picture drawn in fixed colors', async () => {
      const fixed = PICTURE.replace(/currentColor/gu, '#3366cc');
      const outcome = await realizeIllustration({ ai: scriptedAi([fixed]).api, ...BASE });
      expect(outcome.status === 'ready' ? outcome.notes : []).to.deep.equal([
        'This picture uses fixed colors, so it may not suit every theme.',
      ]);
    });

    it('gives up after one repair when there is still no picture', async () => {
      const ai = scriptedAi(['I cannot draw that.']);
      const outcome = await realizeIllustration({ ai: ai.api, ...BASE });
      expect(ai.requests).to.have.length(2);
      expect(outcome.status === 'failed' ? outcome.message : '').to.contain('no <svg> element');
    });
  });
});
