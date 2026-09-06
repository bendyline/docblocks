import {
  createDocBlocksProofingProvider,
  createLocalProofingDictionary,
} from '@bendyline/docblocks-react/proofing';

/**
 * Desktop proofing provider, pointed at the harper engine packaged beside the
 * renderer (see the `harperWasmPlugin` in `vite.config.ts`; electron-builder
 * carries `dist/renderer/**` into `app.asar`).
 *
 * Nothing is fetched over the network here — the `app://` protocol serves the
 * binaries straight out of the installed application, so proofing works on a
 * first launch with no connection at all. `app://` is also what gives
 * `localStorage` a stable origin, so the accepted-word dictionary survives
 * relaunches and updates.
 *
 * A module-scope singleton, not a factory: the shell remounts the editor on
 * every document switch and a host-owned instance keeps the warm engine alive
 * across those remounts.
 */
export const DESKTOP_PROOFING_PROVIDER = createDocBlocksProofingProvider({
  wasmUrl: `${import.meta.env.BASE_URL}harper/harper_wasm_bg.wasm`,
  dictionary: createLocalProofingDictionary(),
});
