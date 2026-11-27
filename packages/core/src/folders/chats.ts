/**
 * The rules of a chats folder: one Markdown file per conversation with Ask,
 * named for its first question and kept as a readable transcript.
 *
 * ```markdown
 * ## You
 *
 * What did I decide about the hotel?
 *
 * ## AI
 *
 * The Panama Hotel.[^source-1]
 *
 * [^source-1]: [Trip notes](../Trips/Seattle.md), a note in this workspace.
 * ```
 *
 * Each exchange is appended, so whatever the person wrote in the file between
 * questions stays. Only the two role headings split the file into turns, so
 * an answer's own headings are moved below them, and a question line that
 * would read as a heading or a footnote is escaped. A file DocBlocks cannot
 * read as a conversation is still an ordinary note.
 */

/** The heading over each question. */
export const CHAT_QUESTION_HEADING = 'You';
/** The heading over each answer. */
export const CHAT_ANSWER_HEADING = 'AI';

const QUESTION = new RegExp(`^ {0,3}## +${CHAT_QUESTION_HEADING} *#* *$`, 'u');
const ANSWER = new RegExp(`^ {0,3}## +${CHAT_ANSWER_HEADING} *#* *$`, 'u');
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const FOOTNOTE = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]?(.*)$/u;
/** A question line that would read as a heading or a footnote definition. */
const NEEDS_ESCAPE = /^( {0,3})(#|\[\^)/u;
const ESCAPED = /^( {0,3})\\(#|\[\^)/u;

/** Apply `transform` to each line outside fenced code. */
function mapProse(text: string, transform: (line: string) => string): string {
  let fence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const opener = FENCE.exec(line)?.[1];
      if (fence !== null) {
        if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
        return line;
      }
      if (opener) {
        fence = opener;
        return line;
      }
      return transform(line);
    })
    .join('\n');
}

const normalize = (text: string) => text.replace(/\r\n?/gu, '\n');

/**
 * One exchange as it is written to a chat file: the question under
 * {@link CHAT_QUESTION_HEADING} and the answer (footnotes and all) under
 * {@link CHAT_ANSWER_HEADING}. The answer's top-level headings become `###`.
 */
export function chatSection(question: string, answer: string): string {
  const asked = mapProse(normalize(question).trim(), (line) =>
    line.replace(NEEDS_ESCAPE, '$1\\$2'),
  );
  const answered = mapProse(normalize(answer).trim(), (line) =>
    line.replace(/^( {0,3})#{1,2}(?=[ \t]|$)/u, '$1###'),
  );
  return `## ${CHAT_QUESTION_HEADING}\n\n${asked}\n\n## ${CHAT_ANSWER_HEADING}\n\n${answered}\n`;
}

/** `source` with `section` added at its end, a blank line between them. */
export function appendChatSection(source: string, section: string): string {
  const before = normalize(source).trimEnd();
  return before ? `${before}\n\n${section}` : section;
}

export interface ChatTranscriptTurn {
  readonly question: string;
  /** The answer's Markdown, with its footnote references (`[^label]`) in place. */
  readonly answer: string;
}

export interface ChatTranscript {
  readonly turns: readonly ChatTranscriptTurn[];
  /** Every footnote definition in the file, by label, wherever it was written. */
  readonly footnotes: ReadonlyMap<string, string>;
}

/**
 * The exchanges in a chat file, in order; null when it holds none (a file
 * without a question heading is not a conversation). A question without an
 * answer is left out. Footnote definitions are gathered from the whole file,
 * since an editor may move them to its end.
 */
export function parseChatTranscript(source: string): ChatTranscript | null {
  const lines = normalize(source).split('\n');
  let start = 0;
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close > 0) start = close + 1;
  }
  const footnotes = new Map<string, string>();
  const turns: ChatTranscriptTurn[] = [];
  let question: string[] | null = null;
  let answer: string[] | null = null;
  let fence: string | null = null;
  let footnote: string | null = null;
  const close = () => {
    if (question && answer) {
      const asked = question
        .map((line) => line.replace(ESCAPED, '$1$2'))
        .join('\n')
        .trim();
      const answered = answer.join('\n').trim();
      if (asked && answered) turns.push({ question: asked, answer: answered });
    }
    question = null;
    answer = null;
  };
  let sawQuestion = false;
  for (const line of lines.slice(start)) {
    const opener = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
      (answer ?? question)?.push(line);
      continue;
    }
    if (footnote !== null && /^(?: {4}|\t)\S/u.test(line)) {
      footnotes.set(footnote, `${footnotes.get(footnote) ?? ''} ${line.trim()}`.trim());
      continue;
    }
    footnote = null;
    if (opener) {
      fence = opener;
      (answer ?? question)?.push(line);
      continue;
    }
    const definition = FOOTNOTE.exec(line);
    if (definition) {
      footnote = definition[1]!;
      footnotes.set(footnote, definition[2]!.trim());
      continue;
    }
    if (QUESTION.test(line)) {
      close();
      question = [];
      sawQuestion = true;
      continue;
    }
    if (ANSWER.test(line)) {
      if (question && !answer) answer = [];
      continue;
    }
    const into = answer ?? question;
    // Blank lines run together where a footnote definition was taken out.
    if (!line.trim() && into && !into[into.length - 1]?.trim()) continue;
    into?.push(line);
  }
  close();
  return sawQuestion ? { turns, footnotes } : null;
}
