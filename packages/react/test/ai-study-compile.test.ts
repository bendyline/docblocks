import { expect } from 'chai';
import { markdownToDoc, materializeFlashcards } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';

import {
  assembleDeck,
  assembleSummary,
  cardIsValid,
  compileSummaryBody,
  flashcardGrounded,
  quizItemGrounded,
  renderFlashcard,
  renderQuizCard,
} from '../src/Ai/study-compile.js';
import {
  readStudyAidProvenance,
  studyAidBody,
  type StudyAidProvenance,
} from '../src/Ai/study-aids.js';
import type { QuizItem } from '../src/Ai/study-prompts.js';

const QUESTION: QuizItem = {
  question: 'Which gas do plants take in during photosynthesis?',
  correct: 'Carbon dioxide',
  wrong: ['Oxygen', 'Nitrogen', 'Helium'],
  why: 'The passage says plants take in carbon dioxide and release oxygen.',
};

function provenance(kind: StudyAidProvenance['kind']): StudyAidProvenance {
  return {
    kind,
    source: 'plants.md',
    sourceSha256: 'a'.repeat(64),
    generatedAt: '2026-10-17T18:04:00.000Z',
    model: 'Small Model',
  };
}

function deckOf(markdown: string) {
  return materializeFlashcards(markdownToDoc(parseMarkdown(markdown)), { source: 'explicit' });
}

describe('study aid compiler', () => {
  it('compiles a question into one multiple-choice card with exactly one correct choice', () => {
    const card = renderQuizCard(QUESTION, 3);
    expect(card).to.be.a('string');
    expect(card).to.match(/^## Question 3 \{study=multiple-choice-flashcard\}/u);
    expect(cardIsValid(card ?? '', 'multiple-choice', 4)).to.equal(true);
    const [only] = deckOf(card ?? '').cards;
    expect(only?.label).to.equal('Question 3');
    expect(only?.choices).to.have.length(4);
    expect(only?.choices?.filter((choice) => choice.correct)).to.have.length(1);
    expect(only?.explanation).not.to.equal(undefined);
  });

  it('shuffles choices by the question, the same way every time', () => {
    const first = renderQuizCard(QUESTION, 1);
    expect(renderQuizCard(QUESTION, 1)).to.equal(first);
    const orders = new Set(
      ['Which gas?', 'What gas?', 'Name the gas.', 'Pick the gas.', 'Choose the gas.'].map(
        (question) => {
          const card = renderQuizCard({ ...QUESTION, question }, 1) ?? '';
          return card.split('\n').filter((line) => line.startsWith('### '))[1];
        },
      ),
    );
    // The correct answer is not always the first choice.
    expect(orders.size).to.be.greaterThan(1);
  });

  it('keeps model text from opening headings, attributes, or a second card', () => {
    const card = renderQuizCard(
      {
        question: 'Which is right? {correct=true}\n## Question 99 {study=flashcard}',
        correct: 'This one ##',
        wrong: ['[Not] this', '<b>Nor</b> this'],
        why: '# Not a heading\n- not a list',
      },
      1,
    );
    expect(card).to.be.a('string');
    expect(card).not.to.contain('{correct=true}\n'); // only the marker the compiler adds
    expect(card?.match(/\{correct=true\}/gu)).to.have.length(1);
    expect(card?.match(/^## /gmu)).to.have.length(1);
    expect(cardIsValid(card ?? '', 'multiple-choice', 3)).to.equal(true);
    const [only] = deckOf(card ?? '').cards;
    const correct = only?.choices?.find((choice) => choice.correct);
    expect(JSON.stringify(correct?.content)).to.contain('This one');
  });

  it('drops a question whose wrong answers collapse into fewer than two distinct choices', () => {
    expect(
      renderQuizCard({ ...QUESTION, wrong: ['Carbon dioxide', 'carbon  dioxide!'] }, 1),
    ).to.equal(null);
  });

  it('compiles a flashcard into one basic card', () => {
    const card = renderFlashcard({
      front: 'What does photosynthesis produce?',
      back: '- Glucose and oxygen.',
    });
    expect(card).to.equal(
      '## What does photosynthesis produce? {study=flashcard}\n\n\\- Glucose and oxygen.',
    );
    expect(cardIsValid(card ?? '', 'basic')).to.equal(true);
    expect(cardIsValid(card ?? '', 'multiple-choice', 3)).to.equal(false);
  });

  it('assembles a deck that reads back card for card, with provenance', () => {
    const cards = [
      renderQuizCard(QUESTION, 1),
      renderQuizCard({ ...QUESTION, question: 'Two?' }, 2),
    ].filter((card): card is string => card !== null);
    const markdown = assembleDeck('quiz', cards, 'Plants', provenance('quiz'));
    expect(markdown).to.match(/^---\n/u);
    expect(markdown).to.contain('display-mode: flashcards');
    const deck = deckOf(markdown);
    expect(deck.title).to.equal('Quiz: Plants');
    expect(deck.cards.map((card) => card.label)).to.deep.equal(['Question 1', 'Question 2']);
    expect(deck.diagnostics).to.deep.equal([]);
    expect(readStudyAidProvenance(markdown)).to.deep.equal(provenance('quiz'));
  });

  it('cleans a summary reply and gives it the compiler’s own title', () => {
    const body = compileSummaryBody(
      '<think>planning</think>\n```markdown\n# Summary\n\nPlants make food.\n\n## Key points\n\n- Light\n```',
    );
    expect(body).to.equal('Plants make food.\n\n### Key points\n\n- Light');
    const markdown = assembleSummary(body, 'Plants', provenance('summary'));
    expect(markdown).not.to.contain('display-mode');
    expect(studyAidBody(markdown)).to.equal(`# Summary: Plants\n\n${body}\n`);
  });

  it('leaves headings inside a code fence alone', () => {
    expect(compileSummaryBody('Intro.\n\n```\n# comment\n```')).to.equal(
      'Intro.\n\n```\n# comment\n```',
    );
  });

  it('checks answers against the passage they came from', () => {
    const passage = 'Plants take in carbon dioxide and release oxygen. The study ran for 12 weeks.';
    expect(quizItemGrounded(QUESTION, passage)).to.equal(true);
    expect(quizItemGrounded({ ...QUESTION, correct: '14 weeks' }, passage)).to.equal(false);
    expect(
      quizItemGrounded({ ...QUESTION, question: 'Who won?', correct: 'Jupiter' }, passage),
    ).to.equal(false);
    expect(flashcardGrounded({ front: 'How long?', back: '12 weeks' }, passage)).to.equal(true);
    expect(flashcardGrounded({ front: 'How long?', back: '20 weeks' }, passage)).to.equal(false);
  });
});
