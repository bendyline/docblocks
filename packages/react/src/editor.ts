/**
 * Placeholder prompts shown by DocBlocks when a Markdown document is empty.
 * Hosts pick one prompt for each mounted document generation and pass it to
 * Squisq, so the copy remains stable while that document is open.
 */
export const EMPTY_DOCUMENT_PROMPTS = [
  'Start typing your content, or drop images on top of me...',
  'Write anything -- paste markdown, drag in images, or just start typing...',
  'Type away. Markdown syntax works too...',
  'Chapter 1 begins here...',
  'Once upon a time...',
  "A blank page. Exciting, isn't it?",
  'The first word is always the hardest...',
  'Plot twist: this is where it all starts...',
  'Write something the future you will thank you for...',
  'Begin at the beginning...',
  "Let's begin.",
  'We can be heroes...',
  'Here comes the sun...',
  'And so it begins...',
  'Let it be, let it be...',
  "Don't stop believing...",
  'Started from the bottom...',
  'This is the start of something new...',
  'Ground control to Major Tom...',
  'Come as you are...',
  'Every new beginning...',
  "Hello, is it me you're looking for?",
  'Imagine all the people...',
  'Anything you want, you got it...',
  'Rise above...',
  'Do you have the time...',
  'Here we are now, entertain us...',
  'All the small things...',
  'Should I stay or should I go?',
  'I am a patient boy -- I wait, I wait, I wait...',
  'Destination unknown...',
  'Easy like Sunday morning...',
  'Dance, dance, dance to the radio...',
  'New day rising...',
  'Visit the world...',
  'Positive mental attitude...',
  'Better I sing than I cry...',
  'Disconnect for a minute...',
  'We need new noise...',
  'Shoot the moon...',
  "I'll surprise you sometime -- I'll come around...",
  'Coming out of my cage, and doing just fine...',
  "Throw me to the wolves -- I'll come back, leading the pack...",
  'There comes a time -- no excuses...',
  "It's up to me now, turn on the bright lights...",
  'Do what you want...',
  'Fingers crossed...',
  'This is the start of how it all ends...',
  'It has to start somewhere, it has to start sometime -- what better place than here? what better time than now?',
  "I know myself, and I'll begin again...",
  'Dig me out, dig me in...',
  "Everybody's full of sugar, honey, ice and tea...",
  "Take time with a wounded hand, 'cause it likes to heal...",
  'Grab a brush and put on a little makeup...',
  'Amber is the color of your energy...',
  "Wait -- they don't love it like I love it...",
  "A world's been buried, where love is the law; a you-topia...",
] as const;

export type EmptyDocumentPrompt = (typeof EMPTY_DOCUMENT_PROMPTS)[number];

/** Pick a prompt using the supplied random source, or `Math.random`. */
export function pickEmptyDocumentPrompt(random: () => number = Math.random): EmptyDocumentPrompt {
  const index = Math.floor(random() * EMPTY_DOCUMENT_PROMPTS.length);
  return EMPTY_DOCUMENT_PROMPTS[index] ?? EMPTY_DOCUMENT_PROMPTS[0];
}
