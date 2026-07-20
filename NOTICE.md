<!-- GENERATED FILE - run npm run generate:notices -->

# Third-Party Notices

This file is the distribution-level entry point for third-party software used by DocBlocks. The generated per-surface notices below are authoritative for their artifacts; they are derived from `package-lock.json`, workspace manifests, and the actual Vite/Rollup output graphs. This inventory is provided for engineering and review purposes and is not legal advice.

## Distribution notices

| Distribution                           | Notice shipped with the artifact                                                             | Inventory basis       |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------- |
| @bendyline/docblocks npm package       | [packages/core/THIRD_PARTY_NOTICES.txt](packages/core/THIRD_PARTY_NOTICES.txt)               | 112 locked components |
| @bendyline/docblocks-react npm package | [packages/react/THIRD_PARTY_NOTICES.txt](packages/react/THIRD_PARTY_NOTICES.txt)             | 343 locked components |
| @bendyline/docblocks-cli npm package   | [packages/cli/THIRD_PARTY_NOTICES.txt](packages/cli/THIRD_PARTY_NOTICES.txt)                 | 347 locked components |
| DocBlocks site distribution            | [packages/site/public/THIRD_PARTY_NOTICES.txt](packages/site/public/THIRD_PARTY_NOTICES.txt) | 207 locked components |
| DocBlocks VS Code extension (VSIX)     | [packages/vscode/THIRD_PARTY_NOTICES.txt](packages/vscode/THIRD_PARTY_NOTICES.txt)           | 197 locked components |
| DocBlocks desktop distribution         | [packages/desktop/THIRD_PARTY_NOTICES.txt](packages/desktop/THIRD_PARTY_NOTICES.txt)         | 237 locked components |

The public npm package notices are explicitly included by each package's `files` allowlist. The VSIX content check requires its notice. The site precaches its notice and component manifest. Electron Builder copies the desktop notice, Electron license, and Chromium notices into every desktop distribution, and the packaged-desktop smoke test verifies them.

## Material non-JavaScript distributions

- The site ships 15 font-family license files from [packages/site/public/fonts/licenses](packages/site/public/fonts/licenses). The font binaries and their license files are copied together.
- Site and desktop renderer builds ship @ffmpeg/core@0.12.9 (GPL-2.0-or-later) as `ffmpeg-core.js` and `ffmpeg-core.wasm`. The same directory contains `COPYING.GPL-2.0.txt`, upstream notices, third-party licenses, and exact source-release pointers.
- Desktop distributions embed Electron 42.2.0. Electron's MIT license and its Chromium third-party notice are copied from the pinned Electron distribution into the application resources directory.

## Major runtime components

- Squisq packages: @bendyline/squisq-cli@2.4.0, @bendyline/squisq-editor-react@2.4.0, @bendyline/squisq-formats@2.3.4, @bendyline/squisq-react@2.4.0, @bendyline/squisq-video-react@2.2.4, @bendyline/squisq-video@2.2.4, @bendyline/squisq@2.4.0.
- MCP SDK: @modelcontextprotocol/sdk@1.29.0.
- Monaco Editor: monaco-editor@0.50.0.
- Archive and PDF tooling: jszip@3.10.1, pdf-lib@1.17.1, pdfjs-dist@4.10.38, and @pdf-lib/upng@1.0.1.

## Distribution review flags

The following upstream npm archives declare a license identifier but omit a package-local license/copying/notice file:

- fsevents@2.3.2 (MIT); affected artifact: DocBlocks desktop distribution; source: https://www.npmjs.com/package/fsevents.
- lazy-val@1.0.5 (MIT); affected artifact: DocBlocks desktop distribution; source: https://github.com/develar/lazy-val.

## Development-only repository inputs

The root workspace pins Mocha 11.3.0 and Vite 6.4.3 for testing and building. It also pins ffmpeg-static 5.2.0 (GPL-3.0-or-later) as a local development/test fallback. These root development dependencies are not included by the generated DocBlocks distribution manifests; shipped browser GIF encoding instead uses the separately noticed @ffmpeg/core WebAssembly distribution.

## Regeneration and drift checking

Run `npm run generate:notices` after dependency or bundle changes. `npm run check:notices` regenerates the expected content in memory and fails on drift; it is a standalone check (not part of `npm run all`) and should be run before publishing a release. Artifact-specific checks additionally verify that the generated notices are present in npm tarballs, the VSIX, the site/PWA, and packaged desktop resources.
