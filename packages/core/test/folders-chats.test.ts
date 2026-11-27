import { expect } from 'chai';
import { appendChatSection, chatSection, parseChatTranscript } from '../src/folders/index.js';

describe('chat transcripts', () => {
  it('writes an exchange under the two role headings, answer headings moved below them', () => {
    expect(chatSection('What did I decide?', '## Hotel\n\nThe Panama Hotel.[^source-1]')).to.equal(
      '## You\n\nWhat did I decide?\n\n## AI\n\n### Hotel\n\nThe Panama Hotel.[^source-1]\n',
    );
  });

  it('reads back what it wrote, footnotes gathered by label', () => {
    let file = '';
    file = appendChatSection(file, chatSection('hi', 'Hello! How can I help?'));
    file = appendChatSection(
      file,
      chatSection(
        'What about the hotel?\n# not a heading\n[^x]: not a footnote',
        'The Panama Hotel.[^source-1]\n\n[^source-1]: [Trip](../Trips/Seattle.md), a note in this workspace.',
      ),
    );
    const transcript = parseChatTranscript(file);
    expect(transcript?.turns).to.deep.equal([
      { question: 'hi', answer: 'Hello! How can I help?' },
      {
        question: 'What about the hotel?\n# not a heading\n[^x]: not a footnote',
        answer: 'The Panama Hotel.[^source-1]',
      },
    ]);
    expect([...(transcript?.footnotes ?? [])]).to.deep.equal([
      ['source-1', '[Trip](../Trips/Seattle.md), a note in this workspace.'],
    ]);
  });

  it('keeps what the person wrote between exchanges and ignores text before the first', () => {
    const file = [
      '---',
      'tags:',
      '  - travel',
      '---',
      'Some notes of my own.',
      '',
      '## You',
      '',
      'First?',
      '',
      '## AI',
      '',
      'One.[^a]',
      '',
      '```md',
      '## You',
      '```',
      '',
      '## You',
      '',
      'Unanswered?',
      '',
      '[^a]: A source,',
      '    continued.',
    ].join('\n');
    const transcript = parseChatTranscript(file);
    expect(transcript?.turns).to.deep.equal([
      { question: 'First?', answer: 'One.[^a]\n\n```md\n## You\n```' },
    ]);
    expect(transcript?.footnotes.get('a')).to.equal('A source, continued.');
  });

  it('is not a conversation without a question heading', () => {
    expect(parseChatTranscript('# Notes\n\nJust a note.')).to.equal(null);
    expect(parseChatTranscript('## You\n\nAsked, never answered.')?.turns).to.deep.equal([]);
  });

  it('appends after a blank line, whatever the file ended with', () => {
    expect(appendChatSection('', 'B\n')).to.equal('B\n');
    expect(appendChatSection('A\r\n\r\n\r\n', 'B\n')).to.equal('A\n\nB\n');
  });
});
