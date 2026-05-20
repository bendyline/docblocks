/**
 * Mocha setup for the React package: install a DOM via happy-dom before
 * any test imports React. Required because `react-dom/client` looks up
 * `document` at import time and our hooks call `localStorage`.
 *
 * Registered globally for the workspace (see root .mocharc.yml) — the
 * other packages don't read DOM globals, so this is benign for them.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  GlobalRegistrator.register({ url: 'http://localhost/' });
}

// React 18's `act` checks this flag to decide whether to apply test-mode
// scheduling semantics. Without it, every `act` call logs "The current
// testing environment is not configured to support act(...)".
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
