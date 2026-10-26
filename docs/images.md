# Images: generation and design graphics

DocBlocks desktop can generate an image from a description and insert it, and
Illustrate can draw a **design graphic** — a poster, infographic or title card —
for a passage. Images are rendered on the user's computer by Gezel's image
engine, stable-diffusion.cpp's `sd-server`. Images are **desktop only**, and not
in the Mac App Store build, which ships no image engine.

DocBlocks never runs `sd-server` itself. It asks the AI connection it already
has:

|               | Hosted (built-in AI)                               | Connected (the person's Gezel app)                         |
| ------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| Who renders   | `@bendyline/gezel-inference` in DocBlocks' process | the Gezel daemon, or its machine broker                    |
| Models        | DocBlocks' Gezel home, plus `~/.gezel` read-only   | the daemon's model store                                   |
| Permission    | none: the host token carries `images`              | the `images` app scope, asked for separately from Settings |
| Engine binary | the `gezel-sd-server` DocBlocks already bundles    | the daemon's own                                           |

## Host contract

`packages/core/src/host/ai-images.ts` defines `AiImagesAPI`, exposed as
`host.ai.images`. `aiImages` capability = `ai.images.generate` exists.

- `access()` / `onAccess()` — `ready`, `needs-approval` (a connected Gezel
  serves images but has not allowed DocBlocks), `awaiting-approval` (with the
  code the person types into Gezel), `provider-outdated`, or `unavailable`
  with a reason: `not-connected`, `no-engine`, `graphics-driver` (Windows x64
  without the Vulkan loader), `platform`.
- `requestAccess()` — from an explicit gesture only. It widens the existing
  grant: chat keeps working throughout, and a denial changes nothing.
- `models()`, `installModel()` (cancel stops the download; starting again
  resumes), `removeModel()` (refuses a model shared from Gezel's own store).
  Image models never appear in the chat model list.
- `getPreferences()` / `setPreferences()` — the model for Generate image, the
  model for design graphics (`rendersText` models only), and the default shape.
  Stored in `userData/ai/images.json`, never `settings.json`, whose parser
  quarantines a file with unknown keys on older builds.
- `generate(request, onEvent)` — a prompt, an aspect ratio (Gezel picks the
  pixels inside the model's range), an optional model and seed. Progress has
  phases: `queued`, `loading-model` (the first render after the engine starts
  loads the weights — minutes for a 49 GB model), `sampling`, `decoding`. It
  ends in one `done` with the PNG bytes, or one `error`. Cancelling stops the
  engine, because a running render cannot be interrupted any other way; the
  next render reloads the weights.

`ai-images.ts` parses every value with exact keys on both sides of IPC, and
checks the PNG signature of a finished render.

## Desktop main

- `main/ai/ai-image-service.ts` (`AiImageService`) reads the live connection's
  image surface from `AiService.imageProvider()` on every call, and **never**
  reaches `AiService`'s failure handling: a missing images grant or a full
  graphics card is an image problem and must not tear down the connection
  chat uses. It serializes nothing itself (Gezel queues renders) but caps
  renders in flight at two across windows.
- `main/ai/gezel-connector.ts` asks the SDK for `images: true` (not on MAS)
  and adapts `connection.images` to the provider-neutral `ProviderImages`.
- `main/ipc-ai.ts` registers `ai:images:*` handlers keyed by
  `(webContents, requestId)` like chat; a renderer that navigates, reloads,
  crashes or closes has its renders and downloads cancelled.
- `main/ai/graphics-driver.ts` checks for `vulkan-1.dll` on Windows x64.
- Main stamps `--docblocks-ai-images=1` on the renderer argv when the build can
  render, and the preload (`preload/ai-images-bridge.ts`) exposes
  `ai.images` only then.

## Renderer

- **Generate image** (`Ai/AiImagePanel.tsx`) is a side panel, opened from the
  AI menu, the Insert menu ("Image from a description…") or the context menu
  ("Generate image from selection…", which prefills the description). Results
  stay in the panel until inserted or discarded.
- Inserting (`Ai/insert-generated-image.ts`) saves the PNG to the document's
  `<stem>_files/` folder through the media provider and inserts an image block
  at the cursor as one undo step. File names carry the seed and a time stamp,
  because the media provider overwrites a file of the same name.
- **Settings → AI assistance → Image generation** (`Settings/AiImageSettings.tsx`)
  lists models with size, license, "Not for commercial use", "Draws legible
  text", and "Workstation · 96 GB+" where they apply. Models the provider says
  cannot run here cannot be downloaded.

## Design graphics

Illustrate offers the **Design graphic** kind when a design model is chosen in
Settings and installed. It follows the diagram rule: the model never writes the
image prompt.

1. **Brief** (`Ai/design-brief.ts`): the chat model returns JSON — a title, a
   layout (poster, infographic, title-card, comparison, timeline, stats),
   labels, numbers and a style. Every label and number must come from the
   passage (numbers by value, labels by a shared word, or verbatim for a token
   like `Q1`); one repair is allowed.
2. **Render**: the brief compiles deterministically into a sentence-style
   prompt that quotes every piece of text exactly and asks for a light neutral
   background, rendered with the design model at the layout's aspect ratio.
   Figures are printed, never plotted, and chart words are dropped from the
   style: an image model draws bars at whatever height it likes (FLUX.2 Klein
   drew 4.2 taller than 5.6 and dropped a quarter), and a chart that looks
   right but is wrong is worse than a misspelling. Plotting numbers is the
   compiled chart kind's job.

Design picks draw after diagram picks. The preview shows the picture from
memory and lists the text it should contain, because image models misspell;
the bytes are saved beside the document only when the person inserts it.

The target design model is Ming Image 0.1 Design: MIT, about 49 GB, a 96 GB
machine, 12 steps; about 24 s per 1024px image on a DGX Spark and 5–7 minutes
on a 128 GB M5 Max. FLUX.2 Klein renders text too, faster and smaller, but
misspells more often.

## Testing

- Unit: `core/test/ai-images.test.ts`, `desktop/test/ai-image-service.test.ts`,
  `desktop/test/ai-images-bridge.test.ts`, `react/test/ai-image-panel.test.ts`,
  `react/test/ai-design-graphics.test.ts`.
- `npm run eval:ai-diagrams -- --images <image-model>` runs the design path
  over the diagram corpus against a Gezel that serves `/v1/images`
  (`DOCBLOCKS_EVAL_IMAGES_BASE_URL`, `DOCBLOCKS_EVAL_IMAGES_TOKEN`), writing
  each render beside the compiled diagram for the same passage in
  `index.html`. With a vision judge (`DOCBLOCKS_EVAL_JUDGE_BASE_URL`,
  `DOCBLOCKS_EVAL_JUDGE_MODEL`) it scores the spelling of the brief's text and
  any text the brief never asked for. The corpus is written for diagrams, so
  a good planner rarely picks a design graphic there; `--design-all` draws
  every pick as one to exercise the brief and the render. The chat calls send
  `reasoning_effort: 'none'` outside writing, as the desktop host does.
