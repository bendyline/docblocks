import { createHash } from 'node:crypto';
import {
  DOCBLOCKS_MCP_WIRE_VERSION,
  MCP_WIRE_LIMITS,
  parseDocumentRevisionResult,
  type AppliedBlockRevision,
  type DocumentRevisionRequest,
  type DocumentRevisionResult,
} from '@bendyline/docblocks/mcp';
import type { Block } from '@bendyline/squisq/schemas';
import type { MarkdownHeading } from '@bendyline/squisq/markdown';
import { ArtifactStore } from './artifact-store.js';
import { convertPreparedDocument } from './conversion-service.js';
import { DocumentService, sha256, throwIfAborted } from './document-service.js';
import { computeBlockSourceRanges } from './intelligence.js';
import { toWireIdentifier } from './output-bounds.js';

interface PreparedReplacement {
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly markdown: string;
  readonly applied: AppliedBlockRevision;
}

/**
 * Apply bounded heading-scoped replacements to one immutable DBK artifact and
 * publish a new immutable DBK artifact. The parent artifact is never mutated.
 */
export async function reviseDocumentArtifact(
  artifacts: ArtifactStore,
  documents: DocumentService,
  request: DocumentRevisionRequest,
  signal?: AbortSignal,
): Promise<DocumentRevisionResult> {
  throwIfAborted(signal);
  const parentArtifact = await artifacts.get(request.artifactUri, signal);
  if (parentArtifact.sha256 !== request.expectedSha256) {
    throw revisionError(
      'conflict',
      `Revision precondition failed: expected ${request.expectedSha256}, but the parent artifact is ${parentArtifact.sha256}.`,
      `Use expectedSha256 "${parentArtifact.sha256}" only if this is still the intended parent artifact.`,
    );
  }
  if (parentArtifact.format !== 'dbk') {
    throw revisionError(
      'invalid-revision-source',
      `Artifact-native block revision requires a DBK parent, not ${parentArtifact.format}.`,
      'Stage Markdown and assets with create_document_bundle, or convert the source to DBK first.',
    );
  }
  if (new Set(request.edits.map((edit) => edit.blockId)).size !== request.edits.length) {
    throw revisionError(
      'duplicate-block-edit',
      'Each block id may be revised at most once per request.',
      'Combine changes to the same block into one replacement fragment.',
    );
  }
  const totalReplacementCharacters = request.edits.reduce(
    (sum, edit) => sum + edit.markdown.length,
    0,
  );
  if (totalReplacementCharacters > MCP_WIRE_LIMITS.documentCharacters) {
    throw revisionError(
      'revision-too-large',
      'Combined replacement Markdown exceeds the MCP document character limit.',
      'Use fewer or smaller block replacements.',
    );
  }

  const prepared = await documents.prepare({ kind: 'artifact', uri: parentArtifact.uri }, signal);
  const { flattenBlocks } = await import('@bendyline/squisq/doc');
  const blocks = flattenBlocks(prepared.doc.blocks);
  const ranges = await computeBlockSourceRanges(blocks, prepared.markdown.length, signal);
  const blockRecords = indexEditableBlocks(blocks, ranges);
  const replacements: PreparedReplacement[] = [];

  for (let index = 0; index < request.edits.length; index += 1) {
    throwIfAborted(signal);
    const edit = request.edits[index]!;
    const record = blockRecords.get(edit.blockId);
    if (!record) {
      throw revisionError(
        'block-not-found',
        `Block "${edit.blockId}" is not an editable heading block in the parent artifact.`,
        'Call inspect_document on the exact parent artifact and use a returned block id with a non-null sourceRange.',
      );
    }
    const replacementMarkdown = await canonicalReplacement(
      edit.markdown,
      record.block,
      edit.blockId,
    );
    const before = prepared.markdown.slice(record.start, record.end);
    if (replacementMarkdown === before) {
      throw revisionError(
        'no-op-block-edit',
        `Replacement for block "${edit.blockId}" does not change its heading or body.`,
        'Omit no-op block edits from the revision request.',
      );
    }
    replacements.push({
      blockId: edit.blockId,
      start: record.start,
      end: record.end,
      markdown: replacementMarkdown,
      applied: {
        kind: 'replace_block',
        blockId: edit.blockId,
        beforeSha256: sha256(Buffer.from(before, 'utf8')),
        afterSha256: sha256(Buffer.from(replacementMarkdown, 'utf8')),
      },
    });
    if ((index + 1) % 16 === 0) await yieldForCancellation(signal);
  }

  const revisedMarkdown = applyReplacements(prepared.markdown, replacements);
  if (revisedMarkdown.length > MCP_WIRE_LIMITS.documentCharacters) {
    throw revisionError(
      'revision-too-large',
      'The revised Markdown exceeds the MCP document character limit.',
      'Use smaller block replacements or split the document before revising it.',
    );
  }
  if (revisedMarkdown === prepared.markdown) {
    throw revisionError(
      'no-op-revision',
      'The requested block replacements do not change the document.',
      'Submit only replacements that change heading or body Markdown.',
    );
  }

  const [{ parseMarkdown }, { markdownToDoc, flattenBlocks: flattenRevisedBlocks }] =
    await Promise.all([import('@bendyline/squisq/markdown'), import('@bendyline/squisq/doc')]);
  const markdownDoc = parseMarkdown(revisedMarkdown);
  const doc = markdownToDoc(markdownDoc, { defaultTemplate: 'content', autoTemplates: false });
  const revisedIds = new Set(
    flattenRevisedBlocks(doc.blocks).map((block) => toWireIdentifier(block.id, 'block')),
  );
  for (const replacement of replacements) {
    if (!revisedIds.has(replacement.blockId)) {
      throw revisionError(
        'unstable-block-id',
        `Replacement for block "${replacement.blockId}" did not preserve its stable id.`,
        'Keep the replacement heading id unchanged and retry from the parent artifact.',
      );
    }
  }
  throwIfAborted(signal);
  await prepared.container.writeDocument(revisedMarkdown);

  const revisionSourceSha256 = createHash('sha256')
    .update('docblocks-artifact-revision-v1\0', 'utf8')
    .update(parentArtifact.sha256, 'utf8')
    .update('\0', 'utf8')
    .update(revisedMarkdown, 'utf8')
    .digest('hex');
  const [conversion] = await convertPreparedDocument(
    artifacts,
    {
      ...prepared,
      markdown: revisedMarkdown,
      markdownDoc,
      doc,
      sourceSha256: revisionSourceSha256,
    },
    { targets: [{ format: 'dbk', fidelity: 'semantic' }] },
    signal,
  );
  if (!conversion) throw new Error('Document revision produced no DBK artifact');
  const result: DocumentRevisionResult = {
    version: DOCBLOCKS_MCP_WIRE_VERSION,
    kind: 'revision',
    parentArtifact,
    artifact: conversion.artifact,
    edits: replacements.map((replacement) => replacement.applied),
    diagnostics: conversion.diagnostics,
  };
  const parsed = parseDocumentRevisionResult(result);
  if (!parsed) throw new Error('Document revision produced an invalid MCP result');
  return parsed;
}

function indexEditableBlocks(
  blocks: readonly Block[],
  ranges: readonly ({ start: number; end: number } | null)[],
): Map<string, { block: Block; start: number; end: number }> {
  const indexed = new Map<string, { block: Block; start: number; end: number }>();
  const ambiguous = new Set<string>();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const range = ranges[index];
    if (!block || !range || !block.sourceHeading) continue;
    const wireId = toWireIdentifier(block.id, 'block');
    if (indexed.has(wireId)) {
      indexed.delete(wireId);
      ambiguous.add(wireId);
    } else if (!ambiguous.has(wireId)) {
      indexed.set(wireId, { block, start: range.start, end: range.end });
    }
  }
  return indexed;
}

async function canonicalReplacement(
  markdown: string,
  target: Block,
  wireBlockId: string,
): Promise<string> {
  const { parseMarkdown, stringifyMarkdown } = await import('@bendyline/squisq/markdown');
  const fragment = parseMarkdown(markdown);
  if (fragment.frontmatter && Object.keys(fragment.frontmatter).length > 0) {
    throw revisionError(
      'invalid-block-replacement',
      `Replacement for block "${wireBlockId}" cannot contain frontmatter.`,
      'Provide one heading and its direct body only.',
    );
  }
  const headings = fragment.children.filter(
    (node): node is MarkdownHeading => node.type === 'heading',
  );
  const heading = headings[0];
  if (!heading || fragment.children[0] !== heading || headings.length !== 1) {
    throw revisionError(
      'invalid-block-replacement',
      `Replacement for block "${wireBlockId}" must begin with exactly one heading and cannot contain nested headings.`,
      'Use a complete fragment such as `# Heading {[content]}\n\nReplacement body`.',
    );
  }
  const sourceHeading = target.sourceHeading;
  if (!sourceHeading) throw new Error('Editable replacement target has no source heading');
  if (heading.depth !== sourceHeading.depth) {
    throw revisionError(
      'invalid-block-replacement',
      `Replacement for block "${wireBlockId}" must keep heading depth ${sourceHeading.depth}.`,
      `Begin the replacement with ${'#'.repeat(sourceHeading.depth)} followed by the heading text.`,
    );
  }
  if (heading.attributes?.id && heading.attributes.id !== target.id) {
    throw revisionError(
      'block-id-change-not-allowed',
      `Replacement for block "${wireBlockId}" cannot change its id to "${heading.attributes.id}".`,
      `Omit the explicit id or keep {#${target.id}}.`,
    );
  }

  const sourceAttributes = sourceHeading.attributes;
  const replacementAttributes = heading.attributes;
  const attributes = {
    ...sourceAttributes,
    ...replacementAttributes,
    id: target.id,
    ...(replacementAttributes?.classes === undefined && sourceAttributes?.classes
      ? { classes: sourceAttributes.classes }
      : {}),
    ...(replacementAttributes?.params === undefined && sourceAttributes?.params
      ? { params: sourceAttributes.params }
      : {}),
    ...(replacementAttributes?.blockMeta === undefined && sourceAttributes?.blockMeta
      ? { blockMeta: sourceAttributes.blockMeta }
      : {}),
    ...(replacementAttributes?.metadata === undefined && sourceAttributes?.metadata
      ? { metadata: sourceAttributes.metadata }
      : {}),
  };
  const pinnedHeading: MarkdownHeading = {
    ...heading,
    attributes,
    templateAnnotation: heading.templateAnnotation ?? sourceHeading.templateAnnotation,
  };
  return stringifyMarkdown({
    type: 'document',
    children: [pinnedHeading, ...fragment.children.slice(1)],
  });
}

function applyReplacements(source: string, replacements: readonly PreparedReplacement[]): string {
  let revised = source;
  const descending = [...replacements].sort((left, right) => right.start - left.start);
  for (const replacement of descending) {
    revised =
      revised.slice(0, replacement.start) + replacement.markdown + revised.slice(replacement.end);
  }
  return revised;
}

function revisionError(
  code: string,
  message: string,
  hint: string,
): Error & { code: string; hint: string; retryable: false } {
  return Object.assign(new Error(message), { code, hint, retryable: false as const });
}

async function yieldForCancellation(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfAborted(signal);
}
