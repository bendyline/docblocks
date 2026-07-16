/**
 * Mocha setup for the React package: install a DOM via happy-dom before
 * any test imports React. Required because `react-dom/client` looks up
 * `document` at import time and our hooks call `localStorage`.
 *
 * Registered globally for the workspace (see root .mocharc.yml) — the
 * other packages don't read DOM globals, so this is benign for them.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  GlobalRegistrator.register({ url: 'http://localhost/' });
}

// A parallel ../squisq checkout is linked into this repository for local
// development. Node resolves dependencies from a symlink's physical target,
// which would give linked React packages ../squisq/node_modules/react instead
// of this test renderer's React instance. Alias the linked CommonJS cache keys
// to the host peers so hooks always use the renderer's dispatcher. Registry
// packages already resolve to the same files, making this a no-op for them.
const hostRequire = createRequire(import.meta.url);
const linkedEditorRequire = createRequire(
  fileURLToPath(import.meta.resolve('@bendyline/squisq-editor-react')),
);

for (const request of ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime']) {
  const hostPath = hostRequire.resolve(request);
  const linkedPath = linkedEditorRequire.resolve(request);
  if (linkedPath === hostPath) continue;

  hostRequire(request);
  const hostModule = hostRequire.cache[hostPath];
  if (hostModule) hostRequire.cache[linkedPath] = hostModule;
}

// React 18's `act` checks this flag to decide whether to apply test-mode
// scheduling semantics. Without it, every `act` call logs "The current
// testing environment is not configured to support act(...)".
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
