import { expect } from 'chai';
import type { AiChatRequest, AiChatCompletion, AiResult } from '@bendyline/docblocks/host';
import type { SpeechInputProvider } from '@bendyline/squisq-editor-react/speech';
import { markdownToTiptap } from '@bendyline/squisq-editor-react';
import {
  cleanNarrationText,
  narrationAsMarkdown,
  narrationRewriteChunks,
} from '../src/Speech/narration-text.js';
import { rewriteNarration } from '../src/Speech/narration-rewrite.js';
import { transcribeNarrationAudio } from '../src/Speech/narration-transcription.js';

function audio(seconds: number): AudioBuffer {
  const samples = new Float32Array(16_000 * seconds).fill(0.25);
  return {
    length: samples.length,
    duration: seconds,
    sampleRate: 16_000,
    numberOfChannels: 1,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

function speech(transcribe: SpeechInputProvider['transcribe']): SpeechInputProvider {
  return { id: 'test', label: 'Test', status: async () => ({ state: 'ready' }), transcribe };
}

describe('text from narration', () => {
  it('cleans filler sounds and adjacent stutters without removing meaningful words', () => {
    expect(cleanNarrationText('Um, I I think, uh, the the plan is, ah, ready.')).to.equal(
      'I think, the plan is, ready.',
    );
    expect(
      cleanNarrationText('I like this. Well, you know that that had had an effect.\nNo no.'),
    ).to.equal('I like this. Well, you know that that had had an effect.\nNo no.');
    expect(cleanNarrationText('Album hummus ahoy. Go. Go again.')).to.equal(
      'Album hummus ahoy. Go. Go again.',
    );
    expect(cleanNarrationText('We we we will go.')).to.equal('We will go.');
    expect(cleanNarrationText('um, uh, ah')).to.equal('');
    expect(cleanNarrationText('Uh-huh, yes.')).to.equal('Uh-huh, yes.');
  });

  it('removes repeated bracketed transcript cues with fillers', () => {
    const transcript =
      'Um, everyone has it. [ Pause ] Everyone goes up there. ' +
      '[ Indistinct conversations ] [ Silence ] ' +
      '[ Inaudible conversations ] '.repeat(13);
    expect(cleanNarrationText(transcript)).to.equal('everyone has it. Everyone goes up there.');
    expect(
      cleanNarrationText('[MUSIC] Hello [background noise], [laughter] everyone. [APPLAUSE]'),
    ).to.equal('Hello, everyone.');
    expect(cleanNarrationText('[silence] [ inaudible speech ] [unintelligible]')).to.equal('');
  });

  it('keeps word boundaries, punctuation and paragraphs when removing transcript cues', () => {
    expect(cleanNarrationText('Hello[Pause]there [ Silence ].')).to.equal('Hello there.');
    expect(cleanNarrationText('The [pause] the plan is ready.')).to.equal('The plan is ready.');
    expect(cleanNarrationText('First paragraph.\n[inaudible]\nNext paragraph.')).to.equal(
      'First paragraph.\n\nNext paragraph.',
    );
  });

  it('preserves bracketed content that is not a recognized transcript cue', () => {
    const transcript = 'Ask [Alice] about [project pause], [2026], [sic] and [note [pause]].';
    expect(cleanNarrationText(transcript)).to.equal(transcript);
    expect(cleanNarrationText('Keep [an unfinished note.')).to.equal('Keep [an unfinished note.');
    expect(cleanNarrationText('[Pause')).to.equal('[Pause');
  });

  it('removes ellipsis pauses without joining words or losing ordinary periods', () => {
    expect(
      cleanNarrationText(
        'This is... something... that.. Emma will enjoy... very much. ' +
          'Hopefully you can\ntranscribe... her yelps. [silence] [silence]',
      ),
    ).to.equal(
      'This is something that Emma will enjoy very much. Hopefully you can\ntranscribe her yelps.',
    );
    expect(cleanNarrationText('…Um... the… the plan.... is ready.')).to.equal('the plan is ready.');
    expect(cleanNarrationText('Hello...there…friend.\n\nNext paragraph.')).to.equal(
      'Hello there friend.\n\nNext paragraph.',
    );
    expect(cleanNarrationText('... …… ..')).to.equal('');
    const prose = 'Dr. Lee paid 3.14 dollars. See example.com. Done.';
    expect(cleanNarrationText(prose)).to.equal(prose);
  });

  it('inserts recognized markup as literal prose', () => {
    expect(narrationAsMarkdown('Ordinary prose, with punctuation.')).to.equal(
      'Ordinary prose, with punctuation.',
    );
    const source = '# Words\n\n{[audio src=secret.wav]} <img src=x> *hello* [link](file)';
    const html = markdownToTiptap(narrationAsMarkdown(source));
    const body = new DOMParser().parseFromString(html, 'text/html').body;
    expect(body.querySelector('h1, img, a, audio, strong, em')).to.equal(null);
    expect(body.textContent).to.contain('{[audio src=secret.wav]}');
    expect(body.textContent).to.contain('<img src=x>');
    expect(body.textContent).to.contain('*hello* [link](file)');
  });

  it('sends a long upload in serial, bounded WAV takes with continuity', async () => {
    const requests: { bytes: number; prompt?: string }[] = [];
    const text: string[] = [];
    const progress: number[] = [];
    await transcribeNarrationAudio(
      audio(61),
      speech(async (wav, options) => {
        expect(new TextDecoder().decode(wav.slice(0, 4))).to.equal('RIFF');
        expect(new DataView(wav).getUint32(24, true)).to.equal(16_000);
        requests.push({ bytes: wav.byteLength, prompt: options.prompt });
        return { text: `Part ${requests.length}.` };
      }),
      new AbortController().signal,
      (part) => text.push(part),
      (value) => progress.push(value),
    );
    expect(requests.map((r) => r.bytes)).to.deep.equal([800_044, 800_044, 352_044]);
    expect(requests[1].prompt).to.contain('Part 1.');
    expect(text).to.deep.equal(['Part 1.', 'Part 2.', 'Part 3.']);
    expect(progress.at(-1)).to.equal(100);
  });

  it('drops late recognition after cancellation and sends no more takes', async () => {
    const controller = new AbortController();
    let requests = 0;
    const text: string[] = [];
    let error: unknown;
    try {
      await transcribeNarrationAudio(
        audio(60),
        speech(async () => {
          requests++;
          controller.abort();
          return { text: 'Late text' };
        }),
        controller.signal,
        (part) => text.push(part),
        () => undefined,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(DOMException);
    expect(requests).to.equal(1);
    expect(text).to.deep.equal([]);
  });

  it('keeps every source character when dividing a long AI rewrite', () => {
    const source = 'One sentence.\n\n'.repeat(230);
    const chunks = narrationRewriteChunks(source);
    expect(chunks.length).to.be.greaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1200)).to.equal(true);
    expect(chunks.join('')).to.equal(source);
  });

  it('uses opt-in writing requests and rejects incomplete rewrites', async () => {
    const requests: AiChatRequest[] = [];
    const ai = {
      chat: (request: AiChatRequest) => {
        requests.push(request);
        return {
          cancel: () => undefined,
          done: Promise.resolve({
            ok: true,
            value: { text: 'Incomplete', model: 'test', finishReason: 'length', usage: null },
          } as AiResult<AiChatCompletion>),
        };
      },
    };
    let error: unknown;
    try {
      await rewriteNarration(ai, 'Um, my meaning.', new AbortController().signal, () => undefined);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).to.contain('unchanged');
    expect(requests[0].purpose).to.equal('write');
    expect(requests[0].messages[0].content).to.contain('Preserve every fact');
    expect(requests[0].messages[1].content).to.contain('Um, my meaning.');
  });

  it('cancels the AI handle and never returns a partial rewrite', async () => {
    const controller = new AbortController();
    let cancelled = false;
    let complete!: (result: AiResult<AiChatCompletion>) => void;
    const rewriting = rewriteNarration(
      {
        chat: () => ({
          done: new Promise<AiResult<AiChatCompletion>>((resolve) => {
            complete = resolve;
          }),
          cancel: () => {
            cancelled = true;
            complete({
              ok: true,
              value: { text: 'Partial', model: 'test', finishReason: 'cancelled', usage: null },
            });
          },
        }),
      },
      'Original',
      controller.signal,
      () => undefined,
    );
    controller.abort();
    let error: unknown;
    try {
      await rewriting;
    } catch (caught) {
      error = caught;
    }
    expect(cancelled).to.equal(true);
    expect(error).to.be.instanceOf(DOMException);
  });
});
