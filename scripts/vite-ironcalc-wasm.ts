import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connect, Plugin } from 'vite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directory each surface publishes the engine under, relative to its own base. */
export const IRONCALC_PUBLIC_DIRECTORY = 'ironcalc';

/** Stable file name passed to Squisq's IronCalc adapter. */
export const IRONCALC_WASM_FILE_NAME = 'wasm_bg.wasm';

/** Published file name → source path relative to the repository root. */
export const IRONCALC_PUBLISHED_FILES: ReadonlyMap<string, string> = new Map([
  [IRONCALC_WASM_FILE_NAME, path.join('node_modules', '@ironcalc', 'wasm', 'wasm_bg.wasm')],
  // @ironcalc/wasm@0.8.4's npm archive omits the repository license files.
  // Ship the upstream MIT option with the redistributed binary.
  ['LICENSE-MIT.txt', path.join('scripts', 'licenses', 'ironcalc', 'LICENSE-MIT.txt')],
]);

const IRONCALC_DEFAULT_WASM_SOURCE = "module_or_path = new URL('wasm_bg.wasm', import.meta.url);";
const IRONCALC_EXPLICIT_SOURCE_ERROR = `throw new Error(
            '@ironcalc/wasm has no bundled default binary in DocBlocks. Every surface passes an explicit ' +
                'wasmSource to createIronCalcEngine — see scripts/vite-ironcalc-wasm.ts.',
        );`;

function ironCalcPackageDirectory(): string {
  return path.join(repoRoot, 'node_modules', '@ironcalc', 'wasm');
}

/**
 * Publish IronCalc's calculation engine beside a surface's own assets.
 *
 * The engine remains a deferred, same-origin runtime asset: Squisq imports the
 * adapter and fetches this binary only when a spreadsheet formula session is
 * opened. Site builds precache it for offline use; desktop and VS Code package
 * it inside their installed artifacts.
 *
 * wasm-bindgen's glue also contains a default `new URL(...)` branch. Every
 * DocBlocks host passes an explicit URL, so leaving that dead branch intact
 * makes Vite emit an unused content-hashed second copy. The transform below
 * replaces the fallback with a loud assertion while preserving the explicit
 * source path used at runtime.
 */
export function ironCalcWasmPlugin(): Plugin {
  const packageDir = ironCalcPackageDirectory();
  const gluePath = path.join(packageDir, 'wasm.js');
  const publishedFiles = new Map(
    [...IRONCALC_PUBLISHED_FILES].map(([fileName, relativePath]) => [
      fileName,
      path.join(repoRoot, relativePath),
    ]),
  );

  const servePublishedFile: Connect.NextHandleFunction = (request, response, next) => {
    const pathname = request.url?.split('?', 1)[0] ?? '';
    const match = /(?:^|\/)ironcalc\/([^/]+)$/u.exec(pathname);
    const sourcePath = match?.[1] ? publishedFiles.get(match[1]) : undefined;
    if (!sourcePath || !fs.existsSync(sourcePath)) return next();

    const stat = fs.statSync(sourcePath);
    response.setHeader('Content-Length', stat.size);
    response.setHeader(
      'Content-Type',
      pathname.endsWith('.wasm') ? 'application/wasm' : 'text/plain; charset=utf-8',
    );
    fs.createReadStream(sourcePath).pipe(response);
  };

  return {
    name: 'docblocks-ironcalc-wasm',
    enforce: 'pre',

    transform(code, id) {
      if (path.resolve(id.split('?', 1)[0]) !== gluePath) return null;
      if (!code.includes(IRONCALC_DEFAULT_WASM_SOURCE)) {
        throw new Error(
          '@ironcalc/wasm changed its default WASM resolution. Review ' +
            'scripts/vite-ironcalc-wasm.ts before updating the package.',
        );
      }
      return {
        code: code.replace(IRONCALC_DEFAULT_WASM_SOURCE, IRONCALC_EXPLICIT_SOURCE_ERROR),
        map: null,
      };
    },

    configureServer(server) {
      server.middlewares.use(servePublishedFile);
    },

    configurePreviewServer(server) {
      server.middlewares.use(servePublishedFile);
    },

    writeBundle(options) {
      const outDir = options.dir;
      if (!outDir) throw new Error('IronCalc publishing requires a directory build output.');

      const destinationDir = path.join(outDir, IRONCALC_PUBLIC_DIRECTORY);
      fs.mkdirSync(destinationDir, { recursive: true });
      for (const [fileName, sourcePath] of publishedFiles) {
        if (!fs.existsSync(sourcePath)) {
          throw new Error(
            `@ironcalc/wasm is missing ${path.relative(repoRoot, sourcePath)}. ` +
              'Run `npm install` — calculation needs the engine installed at the workspace root.',
          );
        }
        fs.copyFileSync(sourcePath, path.join(destinationDir, fileName));
      }
    },
  };
}
