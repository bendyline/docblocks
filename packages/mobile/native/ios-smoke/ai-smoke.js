/* global window, document, phase, modelId, setTimeout, performance, fetch, PointerEvent */
/* Runs only in the isolated iOS test app assembled by ios-ai-smoke.mjs. */
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
const until = async (read, attempts = 150) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = read();
    if (value) return value;
    await pause();
  }
  throw new Error('Timed out waiting for the editor');
};
const ai = window.docBlocksHost.ai;
if (phase === 'inspect') {
  await ai.setPreferences({ enabled: false, model: null });
  assert((await ai.status()).reason === 'opt-out', 'AI must honor opt-out');
  assert(!(await ai.models()).ok, 'Opt-out must reject inference inventory');
  const menu = await until(() => document.querySelector('.db-app-menu-btn'));
  menu.click();
  (
    await until(() =>
      [...document.querySelectorAll('[role=menuitem]')].find(
        (node) => node.textContent.trim() === 'Settings',
      ),
    )
  ).click();
  const toggle = await until(() =>
    [...document.querySelectorAll('input[type=checkbox]')].find((node) =>
      node.closest('label')?.textContent.includes('Use AI features'),
    ),
  );
  assert(!toggle.checked, 'AI toggle must start off');
  toggle.click();
  for (let attempt = 0; attempt < 150 && (await ai.status()).kind !== 'ready'; attempt++)
    await pause();
  const models = await ai.models();
  const available = await ai.availableModels();
  assert(models.ok && available.ok, JSON.stringify({ models, available }));
  const apple = models.value.find(
    (model) => model.id === 'apple-foundation-models:apple-foundation-models',
  );
  assert(apple, 'Apple readiness must remain discoverable');
  assert(available.value.length, 'First-run catalog must offer a model download');
  toggle.closest('.db-settings-section, fieldset')?.scrollIntoView({ block: 'start' });
  await pause();
  return {
    apple,
    downloads: available.value.map((model) => model.label),
    settings: document.querySelector('[role=dialog]')?.textContent,
  };
}
if (phase === 'real') {
  const options = await (await fetch('/ai-smoke-options.json')).json();
  await ai.setPreferences({ enabled: true, model: null });
  const models = await ai.models();
  assert(models.ok, JSON.stringify(models));
  const existing = models.value.find(
    (model) =>
      model.local && model.availability === 'available' && !model.id.includes('foundation'),
  );
  const available = await ai.availableModels();
  assert(available.ok, JSON.stringify(available));
  const candidate = options.model
    ? available.value.find((model) => model.id === options.model)
    : existing
      ? undefined
      : available.value
          .filter((model) => model.downloadBytes)
          .sort((a, b) => a.downloadBytes - b.downloadBytes)[0];
  const installed =
    options.model || candidate
      ? await ai.installModel(options.model ?? candidate.id).done
      : { ok: Boolean(existing), value: existing };
  assert(installed.ok && installed.value, JSON.stringify(installed));
  await ai.setPreferences({ model: installed.value.id });
  const start = performance.now();
  let lastProgress;
  const result = await ai.chat(
    {
      purpose: 'write',
      messages: [
        {
          role: 'system',
          content: 'Rewrite the sentence clearly. Return only the rewritten sentence.',
        },
        {
          role: 'user',
          content: 'We need to get the report done by Friday so the team can look at it.',
        },
      ],
    },
    (event) => {
      if (event.kind === 'progress') lastProgress = event.progress;
    },
  ).done;
  assert(
    result.ok && result.value.text.trim() && !result.value.text.includes('<think>'),
    JSON.stringify({ result, lastProgress, elapsedMs: Math.round(performance.now() - start) }),
  );
  let review;
  if (options.review) {
    document.querySelector('.db-dialog-close')?.click();
    document
      .querySelector('.db-shell-scrim')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await until(() => !document.querySelector('.db-shell-editor-area')?.inert);
    const chat = ai.chat;
    const requests = [];
    ai.chat = (request, onEvent) => {
      const evidence = {
        purpose: request.purpose,
        maxTokens: request.maxTokens,
        promptCharacters: request.messages.reduce(
          (sum, message) => sum + message.content.length,
          0,
        ),
      };
      requests.push(evidence);
      return chat(request, (event) => {
        if (event.kind === 'done') evidence.completion = event.completion;
        if (event.kind === 'error') evidence.error = event.error;
        if (event.kind === 'progress') evidence.lastProgress = event.progress;
        onEvent(event);
      });
    };
    const reviewStart = performance.now();
    try {
      (await until(() => document.querySelector('.db-ai-toolbar-trigger'))).click();
      const action = await until(() =>
        [...document.querySelectorAll('[role=menuitem]')].find(
          (node) => node.textContent.trim() === 'Review document…' && !node.disabled,
        ),
      );
      action.click();
      const panel = await until(() => document.querySelector('.db-ai-review-panel'));
      await until(() => panel.querySelector('[role=alert], .db-ai-review-count'), 2400);
      assert(
        !panel.querySelector('[role=alert]'),
        JSON.stringify({ text: panel.textContent, requests }),
      );
      assert(
        requests.some((request) => request.purpose === 'review' && request.promptCharacters > 8000),
        'Review must include the full default document',
      );
      review = {
        elapsedMs: Math.round(performance.now() - reviewStart),
        requests,
        text: panel.textContent,
      };
    } finally {
      ai.chat = chat;
    }
  }
  await ai.setPreferences({ enabled: false, model: null });
  return {
    model: installed.value.label,
    contextWindow: installed.value.contextWindow,
    downloadBytes: candidate?.downloadBytes,
    elapsedMs: Math.round(performance.now() - start),
    completion: result.value,
    review,
  };
}
await ai.setPreferences({ enabled: true, model: modelId });
const results = [];
for (const purpose of ['write', 'review', 'illustrate']) {
  const events = [];
  const result = await ai.chat(
    { purpose, messages: [{ role: 'user', content: 'Hello' }], maxTokens: 16 },
    (event) => events.push(event),
  ).done;
  assert(result.ok && result.value.text.length, JSON.stringify(result));
  assert(
    events.filter((event) => event.kind === 'done' || event.kind === 'error').length === 1,
    'Exactly one terminal event',
  );
  assert(
    events
      .filter((event) => event.kind === 'delta')
      .map((event) => event.text)
      .join('') === result.value.text,
    'Stream must match the completed answer',
  );
  results.push({
    purpose,
    completion: result.value,
    phases: events
      .filter((event) => event.kind === 'progress')
      .map((event) => event.progress.phase),
  });
}
await ai.setPreferences({ enabled: false, model: null });
assert((await ai.status()).reason === 'opt-out', 'Disable must finish cleanup');
assert((await ai.getPreferences()).model === null, 'Do not leave the temporary model selected');
return { results };
