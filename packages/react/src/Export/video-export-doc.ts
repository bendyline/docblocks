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
 */

import { parseMarkdown } from '@bendyline/squisq/markdown';
import type { Doc } from '@bendyline/squisq/schemas';
import type { ContentContainer } from '@bendyline/squisq/storage';

/** Rows per `{[dataTable src=…]}` preview — the editor's own window. */
const DATA_PREVIEW_ROWS = 50;

/** Where the editor persists the preview's transform choice. */
const TRANSFORM_KEY = 'squisq-transform';
const LEGACY_TRANSFORM_KEY = 'transform-style';

export interface VideoExportDocOptions {
  /** Workspace path of the document; its base name titles a heading-less preamble. */
  fileName?: string | null;
  /** Resolves narration audio and data-table sidecars, as the preview does. */
  workspaceContainer?: ContentContainer | null;
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
  if (!frontmatter) return null;
  const value = Object.prototype.hasOwnProperty.call(frontmatter, TRANSFORM_KEY)
    ? frontmatter[TRANSFORM_KEY]
    : frontmatter[LEGACY_TRANSFORM_KEY];
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '-');
  // `dataDriven` was written by older Squisq versions.
  const id = normalized === 'datadriven' ? 'data-driven' : normalized;
  return knownIds.has(id) ? id : null;
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

export async function buildVideoExportDoc(
  markdownSource: string,
  options: VideoExportDocOptions = {},
): Promise<Doc> {
  const [
    {
      buildPreviewDoc,
      documentTitleFromFileName,
      markdownToDoc,
      resolveAudioMapping,
      resolveDataReferences,
    },
    { applyTransform, getTransformStyleSummaries },
  ] = await Promise.all([import('@bendyline/squisq/doc'), import('@bendyline/squisq/transform')]);

  let doc = markdownToDoc(parseMarkdown(markdownSource));
  const container = options.workspaceContainer;
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
  // A document without narration gets a placeholder `{ src: '' }` segment
  // from `buildPreviewDoc` so a live player has a clock to run. The exporter
  // would treat it as real audio to fetch and mix; the preview likewise takes
  // its audio from the content document, never the placeholder.
  return { ...projected, audio: contentDoc.audio };
}
