import type { Plugin } from 'vite';

/**
 * Packages whose `browser` export needs a DOM, mapped to the DOM-only file
 * and the file their own `worker` export points at.
 *
 * decode-named-character-reference (micromark, so every Markdown parse)
 * decodes entities through `document.createElement` in its browser build.
 */
const DOM_ONLY_BROWSER_BUILDS: Readonly<Record<string, { dom: string; worker: string }>> = {
  'decode-named-character-reference': { dom: '/index.dom.js', worker: '/index.js' },
};

/**
 * Vite bundles workers with the page's resolve conditions, so a package's
 * DOM-only `browser` build wins inside a worker too and throws on load
 * ("document is not defined"). For worker bundles only, resolve those
 * packages to the build their `worker` export names.
 */
export function workerSafeBuilds(): Plugin {
  return {
    name: 'docblocks-worker-safe-builds',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const build = DOM_ONLY_BROWSER_BUILDS[source];
      if (!build) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || !resolved.id.endsWith(build.dom)) return resolved;
      return { ...resolved, id: `${resolved.id.slice(0, -build.dom.length)}${build.worker}` };
    },
  };
}
