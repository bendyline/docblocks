import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connect, Plugin } from 'vite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directory each surface publishes the engine under, relative to its own base. */
export const HARPER_PUBLIC_DIRECTORY = 'harper';

/**
 * The binary the provider is pointed at. harper derives its slim sibling by
 * substituting this exact file name, so the pair must sit side by side and
 * this name must never be hashed or rewritten.
 */
export const HARPER_WASM_FILE_NAME = 'harper_wasm_bg.wasm';

/** Published file name → path inside the installed harper.js package. */
export const HARPER_PUBLISHED_FILES: ReadonlyMap<string, string> = new Map([
  [HARPER_WASM_FILE_NAME, path.join('dist', HARPER_WASM_FILE_NAME)],
  // harper loads BOTH binaries: the slim one initializes the default glue
  // (best effort) before the full one initializes the real engine. Serving
  // only the full binary degrades the engine silently.
  ['harper_wasm_slim_bg.wasm', path.join('dist', 'harper_wasm_slim_bg.wasm')],
  ['LICENSE.txt', 'LICENSE'],
]);

/**
 * `harper.js/binary` is the engine's bundler-resolved default binary. It
 * carries `new URL('harper_wasm_bg.wasm', import.meta.url)`, which Vite turns
 * into a second, content-hashed 15 MiB copy of the WASM in every surface's
 * `assets/` — and a useless one, because the hashed name defeats the runtime
 * substitution that finds the slim sibling.
 *
 * Squisq only reaches that module when a host supplies no `wasmUrl`. Every
 * DocBlocks surface supplies one (that is the entire point of this plugin), so
 * the import is dead code whose only effect is the duplicate. Replace it with a
 * module that throws if the dead branch ever becomes live.
 */
const HARPER_BINARY_SPECIFIER = 'harper.js/binary';
const HARPER_BINARY_STUB_ID = '\0docblocks:harper-binary';
const HARPER_BINARY_STUB_SOURCE = `export const binary = {
  get url() {
    throw new Error(
      'harper.js/binary is not bundled by DocBlocks. Every surface passes an explicit ' +
        'wasmUrl to createHarperProofingProvider — see scripts/vite-harper-wasm.ts.',
    );
  },
};
`;

function harperPackageDirectory(): string {
  return path.join(repoRoot, 'node_modules', 'harper.js');
}

/**
 * Publish harper.js's WebAssembly engine beside a surface's own assets.
 *
 * The engine is a deferred, same-origin runtime asset rather than a bundled
 * chunk: proofing downloads it only once a markdown document is open with
 * checking effective, so the shell paints and the document opens whether or
 * not the ~30 MiB pair has arrived yet. Apache-2.0 requires the license to
 * travel with the binaries, so it is published alongside them.
 */
export function harperWasmPlugin(): Plugin {
  const packageDir = harperPackageDirectory();
  const publishedFiles = new Map(
    [...HARPER_PUBLISHED_FILES].map(([fileName, relativePath]) => [
      fileName,
      path.join(packageDir, relativePath),
    ]),
  );

  const servePublishedFile: Connect.NextHandleFunction = (request, response, next) => {
    const pathname = request.url?.split('?', 1)[0] ?? '';
    const match = /(?:^|\/)harper\/([^/]+)$/u.exec(pathname);
    const sourcePath = match?.[1] ? publishedFiles.get(match[1]) : undefined;
    if (!sourcePath || !fs.existsSync(sourcePath)) return next();

    const stat = fs.statSync(sourcePath);
    response.setHeader('Content-Length', stat.size);
    // A missing .wasm answered as text/html by an SPA fallback surfaces as a
    // confusing compile error rather than a clean 404.
    response.setHeader(
      'Content-Type',
      pathname.endsWith('.wasm') ? 'application/wasm' : 'text/plain; charset=utf-8',
    );
    fs.createReadStream(sourcePath).pipe(response);
  };

  return {
    name: 'docblocks-harper-wasm',
    enforce: 'pre',

    resolveId(source) {
      return source === HARPER_BINARY_SPECIFIER ? HARPER_BINARY_STUB_ID : null;
    },

    load(id) {
      return id === HARPER_BINARY_STUB_ID ? HARPER_BINARY_STUB_SOURCE : null;
    },

    configureServer(server) {
      server.middlewares.use(servePublishedFile);
    },

    configurePreviewServer(server) {
      server.middlewares.use(servePublishedFile);
    },

    writeBundle(options) {
      const outDir = options.dir;
      if (!outDir) throw new Error('harper.js publishing requires a directory build output.');

      const destinationDir = path.join(outDir, HARPER_PUBLIC_DIRECTORY);
      fs.mkdirSync(destinationDir, { recursive: true });
      for (const [fileName, sourcePath] of publishedFiles) {
        if (!fs.existsSync(sourcePath)) {
          throw new Error(
            `harper.js is missing ${path.relative(repoRoot, sourcePath)}. ` +
              'Run `npm install` — proofing needs the engine installed at the workspace root.',
          );
        }
        fs.copyFileSync(sourcePath, path.join(destinationDir, fileName));
      }
    },
  };
}
