/** Enforce the upstream inference boundary on the final artifact, including nested dependencies. */
const path = require('node:path');
const requiredInferenceAssets = [
  'LICENSE',
  ...[
    'index.js',
    'native-release-entry.js',
    'engines/native-file-manifest.json',
    'knowledge/search-worker.js',
    'memory/embed-worker.js',
    'relevance/relevance-worker.js',
    'providers/llama-cpp/gguf-metadata-worker.js',
    'providers/mlx/python/gezel_mlx_server.py',
    'catalog/chat-models/raw-index.json',
    'catalog/knowledge-catalogs/raw-index.json',
    'catalog/LICENSE',
    'catalog/provenance.json',
    'kokoro-lexicon/LICENSE',
    'kokoro-lexicon/lexicon-us-en.txt.gz',
    'kokoro-lexicon/lexicon-gb-en.txt.gz',
  ].map((file) => `dist/${file}`),
];
async function verifyGezelRuntimeFiles(asarPath) {
  const asar = await import('@electron/asar');
  const files = asar
    .listPackage(asarPath)
    .filter((filename) => !asar.statFile(asarPath, path.normalize(filename.slice(1)), false).files)
    .map((filename) => filename.replaceAll('\\', '/'));
  const overhead = files.filter((filename) =>
    /\/node_modules\/@bendyline\/(gezel-service|gilde|gezel-mcp)\//.test(filename),
  );
  if (overhead.length)
    throw new Error(
      `Full Gezel product dependency in app.asar: ${overhead.slice(0, 5).join(', ')}`,
    );
  const root = '/node_modules/@bendyline/gezel-inference/';
  for (const relative of requiredInferenceAssets) {
    if (!files.includes(root + relative))
      throw new Error(`Missing Gezel runtime asset in app.asar: ${relative}`);
  }
}
exports.requiredInferenceAssets = requiredInferenceAssets;
exports.verifyGezelRuntimeFiles = verifyGezelRuntimeFiles;
