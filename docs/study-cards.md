# Study cards

Study cards are flashcards and multiple-choice questions kept with each section of a document.
They live in the document itself, under the section they test, as readable Markdown. You make
and edit them in **View › Edit › Study cards** and study them in **View › Use › Flashcards**.
They are never slides, narration, captions or exported text.

The view, the card format and everything about making cards with AI belong to Squisq; see
Squisq's guide to [study cards](https://github.com/bendyline/squisq/blob/main/docs/guide/markup.md#study-cards)
for the full format. This page covers what DocBlocks adds.

## The format

```markdown
## Photosynthesis

Plants turn light into sugar in their leaves.

### What do plants make from light? {[flashcard]}

Sugar, which stores the energy.

### Where does photosynthesis happen? {[quiz]}

- [ ] In the roots
- [x] In the leaves
- [ ] In the flowers

The leaves hold the chlorophyll that catches light.
```

- **Flashcard:** the heading is the question; everything under it is the answer.
- **Quiz question:** the heading is the question; the first list is the choices, written as a
  checklist with exactly one ticked; a paragraph after the list explains the right answer.

Cards go after the section's own text. In Write, a section's cards fold into one row under it;
in Source each card folds on its own.

## Making cards

The Study cards view lists the document's sections with their card counts. Pick a section to
see and edit its cards beside it, or add one with **Add flashcard** or **Add quiz question**. A
new card is saved once it has a question and an answer (or at least two choices with one marked
right). A card's fields save when you leave them, as one undo step each.

With AI turned on (desktop and mobile), the view adds **Generate for this section** and
**Generate for all sections without cards**, with a **Make** choice of flashcards, quiz
questions, or both. Progress and **Stop** take the button's place. Cards are saved a section at
a time, so stopping keeps everything made so far. Each card a model writes is checked against its
own section first: its answer must be what the section says, its numbers the section's, a
question's wrong answers distinct and not also right, and no card may repeat one the document
already asks.

**Create quiz…** and **Create flashcards…** in the AI menu open the Study cards view; they do
not start a run. On the site and in VS Code the view works fully, without AI.

## When a section changes

A card made by AI records a key of its section's text (`origin=ai passage=…` on its tag). When
that text changes, the card stays in the deck and the view marks it **Section changed**, with
**Keep** (or **Keep all** for the section) and, with AI, **Regenerate**. Renaming the heading or
re-wrapping lines changes nothing. A card you edit in the Study cards view becomes yours and is
never flagged; one edited in Write or Source keeps its AI mark until you keep it.

## Studying

Use › Flashcards studies a document's cards in document order, each labelled with its section.
A document with no study cards is studied from its headings, as before.

## Where cards are left out

Cards are side information, not your writing, so DocBlocks leaves them out of:

- slides, video, narration, read aloud, captions and every export except Markdown and DocBlocks
  bundles (`.dbk`);
- Ask, workspace search and the knowledge DocBlocks gives AI — Ask never cites a card as your
  notes;
- Review, Compose and Illustrate, which work on the document's own text;
- task progress on Home and Tasks: a quiz's checklist is not a list of steps;
- word counts, outlines and MCP inspection, which reports a document's cards as a
  `study-cards` diagnostic instead.

## Summaries

**Summarize document…** is unchanged: the summary is saved beside the document, in
`<name>_files/ai/summary.md`. Quiz and flashcard decks that earlier versions saved there
(`ai/quiz.md`, `ai/flashcards.md`) are left as they are and are no longer opened by the app.

## Verification

- `packages/react/test/study-ai.test.ts` — every request passes the host's wire policy, one at a
  time, `purpose: 'study'`, no knowledge search; readiness and Stop.
- `packages/core/test/workspace-index-content-source.test.ts` and
  `packages/react/test/ai-accessories.test.ts` — the readers that leave cards out.
- `packages/cli/test/mcp-study-cards.test.ts` — MCP inspection and the authoring guide.
- `packages/bench` — `study-quiz` and `study-flashcards` drive the generator (docbench 0.3.0).
- `packages/desktop/e2e/ai-editor.spec.ts`, `e2e/study-cards.spec.ts` and the VS Code web
  suite — the view with and without AI.
