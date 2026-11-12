import { expect } from 'chai';
import { buildChatCompletionBody, isLocalEngineModel } from '../src/host/ai-transport.js';

const messages = [
  { role: 'system' as const, content: 'You review documents.' },
  { role: 'user' as const, content: 'Review this.' },
];

describe('buildChatCompletionBody', () => {
  it('turns reasoning off for every purpose but writing', () => {
    for (const purpose of ['review', 'illustrate', 'study', 'chat'] as const) {
      const body = buildChatCompletionBody({ model: 'llama-cpp:m', messages, purpose });
      expect(body.reasoning_effort, purpose).to.equal('none');
    }
    const write = buildChatCompletionBody({ model: 'llama-cpp:m', messages, purpose: 'write' });
    expect(write).not.to.have.property('reasoning_effort');
  });

  it("lets an uncapped local draft use the model's whole context window", () => {
    const local = buildChatCompletionBody({
      model: 'llama-cpp:m',
      messages,
      purpose: 'write',
      contextWindow: 32_768,
    });
    expect(local.max_tokens).to.equal(32_768);
    const cloud = buildChatCompletionBody({
      model: 'anthropic:claude',
      messages,
      purpose: 'write',
      contextWindow: 200_000,
    });
    expect(cloud).not.to.have.property('max_tokens');
    const capped = buildChatCompletionBody({
      model: 'mlx:m',
      messages,
      purpose: 'write',
      maxTokens: 900,
      contextWindow: 32_768,
    });
    expect(capped.max_tokens).to.equal(900);
    const review = buildChatCompletionBody({
      model: 'llama-cpp:m',
      messages,
      purpose: 'review',
      contextWindow: 32_768,
    });
    expect(review).not.to.have.property('max_tokens');
  });

  it('asks for structured output only when given a schema', () => {
    const plain = buildChatCompletionBody({ model: 'llama-cpp:m', messages, purpose: 'review' });
    expect(plain).not.to.have.property('response_format');
    const schema = { type: 'object', properties: { layouts: { type: 'array' } } };
    const shaped = buildChatCompletionBody({
      model: 'llama-cpp:m',
      messages,
      purpose: 'illustrate',
      responseFormat: { type: 'json_schema', name: 'presentation_storyboard', schema },
    });
    expect(shaped.response_format).to.deep.equal({
      type: 'json_schema',
      json_schema: { name: 'presentation_storyboard', schema, strict: true },
    });
  });

  it('sends a seed and temperature only when given', () => {
    const bare = buildChatCompletionBody({ model: 'llama-cpp:m', messages, purpose: 'review' });
    expect(bare).not.to.have.property('seed');
    expect(bare).not.to.have.property('temperature');
    const seeded = buildChatCompletionBody(
      { model: 'llama-cpp:m', messages, purpose: 'review', temperature: 0.2 },
      { seed: 7 },
    );
    expect(seeded.seed).to.equal(7);
    expect(seeded.temperature).to.equal(0.2);
  });

  it('copies the messages it was given', () => {
    const body = buildChatCompletionBody({ model: 'llama-cpp:m', messages, purpose: 'review' });
    expect(body.messages).to.deep.equal(messages);
    expect(body.messages).not.to.equal(messages);
  });

  it('recognizes on-device engines by provider prefix', () => {
    expect(isLocalEngineModel('llama-cpp:qwen3.5-2b-q4')).to.equal(true);
    expect(isLocalEngineModel('mlx:gemma')).to.equal(true);
    expect(isLocalEngineModel('ds4:x')).to.equal(true);
    expect(isLocalEngineModel('ollama:llama3')).to.equal(true);
    expect(isLocalEngineModel('gezel:writer-anna')).to.equal(false);
    expect(isLocalEngineModel('openai:gpt')).to.equal(false);
  });
});
