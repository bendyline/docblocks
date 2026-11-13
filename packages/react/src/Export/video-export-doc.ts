/**
 * The document the video exporter renders.
 *
 * Squisq's exporter mounts its player on exactly the Doc it is handed, so it
 * must receive the projection the editor's Video preview and Timeline
 * composition monitor play — Squisq editor-react's `usePreviewProjection`:
 * narration audio, data-table previews, the document's transform style, then
 * `buildPreviewDoc`. That last step is not cosmetic. `markdownToDoc` gives an
 * untemplated `##` section the `sectionHeader` template, which renders only
 * the title; `buildPreviewDoc` is what turns a section with a body into a
 * `content` slide carrying its paragraphs and tables. Skipping it is how the
 * preview showed a table while the MP4 showed a title card.
 *
 * The editor also holds each block open for the videos it plays, measuring
 * the files in the browser (Squisq's `applyVideoDurations`). The export
 * measures them the same way, first, so a slide over a long clip plays the
 * whole clip in the MP4 as it does in the preview.
 */

import { parseMarkdown } from '@bendyline/squisq/markdown';
import type { Doc, MediaProvider } from '@bendyline/squisq/schemas';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { PresentationInvalidError } from './export-errors.js';
import { frontmatterTransformId } from './export-options.js';

/** Rows per `{[dataTable src=…]}` preview — the editor's own window. */
const DATA_PREVIEW_ROWS = 50;

export interface VideoExportDocOptions {
  /** Workspace path of the document; its base name titles a heading-less preamble. */
  fileName?: string | null;
  /** Resolves narration audio and data-table sidecars, as the preview does. */
  workspaceContainer?: ContentContainer | null;
  /**
   * Resolves the document's video files so their lengths can be measured —
   * pass the editor's provider to reuse its measurements. Without one, a
   * provider over `workspaceContainer` is made for the purpose.
   */
  mediaProvider?: MediaProvider | null;
}

/**
 * The transform style the preview is playing, as persisted in frontmatter.
 * Mirrors the editor: the canonical key wins whenever it is present, ids are
 * normalized, and an unknown id means no transform rather than a guess.
 */
export function persistedTransformStyle(
  frontmatter: Readonly<Record<string, unknown>> | undefined,
  knownIds: ReadonlySet<string>,
): string | null {
  const id = frontmatterTransformId(frontmatter);
  return id && knownIds.has(id) ? id : null;
}

/**
 * Fill data-table references with bounded previews. The readers load only
 * here, and any failure keeps the input doc — the preview's own contract.
 */
async function withDataPreviews(
  doc: Doc,
  container: ContentContainer,
  resolveDataReferences: typeof import('@bendyline/squisq/doc').resolveDataReferences,
): Promise<Doc> {
  try {
    const { defaultDataReaders } = await import('@bendyline/squisq-formats/data');
    const resolved = await resolveDataReferences(doc, container, {
      readers: defaultDataReaders(),
      maxPreviewRows: DATA_PREVIEW_ROWS,
    });
    return resolved.doc;
  } catch {
    return doc;
  }
}

/**
 * Hold each block open for the videos it plays, measuring the files the
 * document names without an out-point. A file that cannot be measured keeps
 * its block's text timing — the preview's own fallback — so this never fails
 * the export.
 */
async function withVideoDurations(
  doc: Doc,
  provider: MediaProvider | null | undefined,
  container: ContentContainer | null | undefined,
): Promise<Doc> {
  const owned =
    !provider && container
      ? (await import('@bendyline/squisq/storage')).createMediaProviderFromContainer(container)
      : null;
  try {
    const { resolveVideoDurations } = await import('@bendyline/squisq-react');
    return await resolveVideoDurations(doc, { provider: provider ?? owned });
  } catch {
    return doc;
  } finally {
    owned?.dispose();
  }
}

export async function buildVideoExportDoc(
  markdownSource: string,
  options: VideoExportDocOptions = {},
): Promise<Doc> {
  const [
    {
      buildPreviewDoc,
      collectVideoDurationSources,
      documentTitleFromFileName,
      markdownToDoc,
      resolveAudioMapping,
      resolveDataReferences,
    },
    { applyTransform, getTransformStyleSummaries },
  ] = await Promise.all([import('@bendyline/squisq/doc'), import('@bendyline/squisq/transform')]);

  let doc = markdownToDoc(parseMarkdown(markdownSource));
  const container = options.workspaceContainer;
  // Video lengths before audio: recorded narration then re-times the blocks
  // it covers and keeps precedence, as in the preview.
  if (collectVideoDurationSources(doc).length > 0) {
    doc = await withVideoDurations(doc, options.mediaProvider, container);
  }
  if (container) {
    // Audio before transforms, so generated slides inherit narration timing.
    // Discovery is optional here as it is in the preview: a failure exports
    // the timing the preview would fall back to, not nothing at all.
    doc = await resolveAudioMapping(doc, container).catch(() => doc);
    doc = await withDataPreviews(doc, container, resolveDataReferences);
  }

  const knownIds = new Set(getTransformStyleSummaries().map((summary) => summary.id));
  const transformStyle = persistedTransformStyle(doc.frontmatter, knownIds);
  const contentDoc = transformStyle ? applyTransform(doc, transformStyle).doc : doc;
  // A take anchored to the whole document owns the timeline; interleaved
  // filler slides would push every later slide off its audio.
  const narrationOwnsTimeline = (contentDoc.documentMedia ?? []).some(
    (clip) => clip.anchor === 'document',
  );
  const projected = buildPreviewDoc(contentDoc, {
    documentTitle: documentTitleFromFileName(options.fileName ?? undefined),
    interleaveImages: !narrationOwnsTimeline,
  });
  const invalidPresentation = projected.diagnostics?.find(
    (diagnostic) => diagnostic.code === 'presentation-invalid',
  );
  if (invalidPresentation) throw new PresentationInvalidError(invalidPresentation.message);
  // A document without narration gets a placeholder `{ src: '' }` segment
  // from `buildPreviewDoc` so a live player has a clock to run. The exporter
  // would treat it as real audio to fetch and mix; the preview likewise takes
  // its audio from the content document, never the placeholder.
  return { ...projected, audio: contentDoc.audio };
}
