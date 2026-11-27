/**
 * A stand-in for the semantic search utility process (`embedding-utility.cjs`)
 * that speaks the same protocol with deterministic 384-dimension vectors, so
 * the desktop e2e exercises the real utilityProcess, IPC, worker and renderer
 * path without loading the model.
 *
 * "Meaning" is a small concept table: words of one concept share a direction,
 * so a query can find a passage that shares none of its words. A text with no
 * concept word gets its own pseudo-random direction, near-orthogonal to all
 * others and below any similarity floor.
 */
const DIMENSIONS = 384;
const CONCEPTS = new Map(
  Object.entries({
    pests: ['aphid', 'aphids', 'pest', 'pests', 'insect', 'insects', 'bug', 'bugs', 'beetles'],
    cooking: ['roast', 'roasting', 'oven', 'bake', 'baking', 'cook', 'cooking', 'recipe'],
  }).flatMap(([concept, words]) => words.map((word) => [word, concept])),
);

function direction(seed) {
  let state = 2166136261;
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  const out = new Float32Array(DIMENSIONS);
  for (let i = 0; i < DIMENSIONS; i += 1) {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  }
  return out;
}

function embed(text) {
  const concepts = new Set();
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const concept = CONCEPTS.get(word);
    if (concept) concepts.add(concept);
  }
  const vector = new Float32Array(DIMENSIONS);
  const seeds = concepts.size > 0 ? [...concepts].map((c) => `concept:${c}`) : [`text:${text}`];
  for (const seed of seeds) {
    const part = direction(seed);
    for (let i = 0; i < DIMENSIONS; i += 1) vector[i] += part[i];
  }
  const norm = Math.hypot(...vector) || 1;
  for (let i = 0; i < DIMENSIONS; i += 1) vector[i] /= norm;
  return vector;
}

const port = process.parentPort;
port.on('message', ({ data }) => {
  if (!data || data.type !== 'embed') return;
  port.postMessage({ type: 'done', id: data.id, vectors: data.texts.map(embed) });
});
