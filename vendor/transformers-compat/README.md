# Transformers.js compatibility stubs

The desktop app installs `@huggingface/transformers` so the Gezel service it
hosts can embed knowledge-catalog queries and load its relevance model. Both
run on the native `onnxruntime-node` CPU backend. Two of Transformers.js's
dependencies would add nothing to that and are replaced, through root
`package.json#overrides`, by the private packages in this folder:

- **`sharp/`** — Transformers.js's Node build imports Sharp eagerly, even for
  text-only pipelines. Real Sharp would ship libvips and a native binary per
  platform for an image path DocBlocks never uses. The stub lets the module
  load; any image call fails with `DOCBLOCKS_TRANSFORMERS_IMAGE_UNSUPPORTED`.
  Gezel's own app ships the same kind of stub.
- **`onnxruntime-web/`** — Transformers.js's Node build inlines the parts of
  ONNX Runtime Web it needs and never imports the package. The published
  package is 145 MB of browser WebAssembly builds plus a protobufjs install
  script. The stub throws if anything ever loads it.

`check-electron-builder-config.ts` fails a packaged-dependency check if either
slot holds anything but these stubs. If DocBlocks ever needs Transformers.js
image pipelines or its WebAssembly backend, remove the matching override and
review the real package like any other dependency.
