import { expect } from 'chai';
import type { Doc } from '@bendyline/squisq/schemas';
import { VIEWPORT_PRESETS } from '@bendyline/squisq/schemas';
import {
  expandDocBlocks,
  flattenRenderableBlocks,
  resolvePersistentLayers,
  resolveThemeForDoc,
} from '@bendyline/squisq/doc';
import { docToPptx } from '@bendyline/squisq-formats/pptx';
import { getPartXml, NS_PML, openPackage } from '@bendyline/squisq-formats/ooxml';
import { DEFAULT_OPTIONS } from '../src/Export/export-options.js';
import { runExport } from '../src/Export/run-export.js';

const CORPUS = [
  {
    name: 'risk table',
    markdown: `---
squisq-transform: documentary
---
# Questions and risks

## Risk register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Scope explosion across many independent use cases | High | High | Deliver vertical slices with explicit exit criteria and recut phases when work slips. |
| Dependency drift makes remembered APIs unreliable | High | Medium | Pin exact releases and ship generated current-version guidance beside the code. |
| Golden-image flakiness teaches contributors to ignore failures | High | Medium | Pin the renderer, use perceptual tolerance, and quarantine only after repeated proof. |
| Security hardening conflicts with runtime integrations | Medium | High | Run a bounded compatibility spike and retain a fallback behind the same interface. |

## Owner decisions

- Accept browser automation as the canonical capture path.
- Keep the deterministic kernel isolated from environment-specific loaders.
- Revisit binary deltas only after profiling proves JSON is the bottleneck.
`,
  },
  {
    name: 'nested prose and quote',
    markdown: `# Architecture review

## Context

The system serves several delivery surfaces from one document model while keeping storage and rendering boundaries explicit.

### Evidence

> One source should produce the same presentation structure everywhere.

### Implication

Exporters must consume the player-ready block sequence instead of reconstructing it from lossy prose.
`,
  },
  {
    name: 'authored templates',
    markdown: `# Release readout {[title]}

## Adoption {[statHighlight stat="73%" description="Teams enabled the new workflow"]}

## What changed {[list]}

- Shared projection
- Native visual layers
- Theme parity
- Managed cover parity
`,
  },
] as const;

function projectedSlideCount(doc: Doc): number {
  const theme = resolveThemeForDoc(doc, doc.themeId);
  const expanded = expandDocBlocks(flattenRenderableBlocks(doc.blocks), {
    audioSegments: doc.audio.segments.map(({ startTime, duration }) => ({ startTime, duration })),
    viewport: VIEWPORT_PRESETS.landscape,
    persistentLayers: resolvePersistentLayers({ persistentLayers: doc.persistentLayers }, theme),
    theme,
    customTemplates: doc.customTemplates,
  });
  const coverSetting = doc.frontmatter?.['squisq-cover-slide'] ?? doc.frontmatter?.['cover-slide'];
  const includeCover = coverSetting !== false && coverSetting !== 'false';
  return expanded.length + (includeCover && doc.startBlock ? 1 : 0);
}

async function presentationSlideCount(bytes: ArrayBuffer): Promise<number> {
  const pkg = await openPackage(bytes);
  const presentation = await getPartXml(pkg, 'ppt/presentation.xml');
  expect(presentation).not.to.equal(null);
  return presentation!.getElementsByTagNameNS(NS_PML, 'sldId').length;
}

// Temporarily skipped until the slideshow-aware docToPptx implementation is
// available in the published @bendyline/squisq-formats dependency.
describe.skip('PPTX slideshow parity integration', () => {
  for (const { name, markdown } of CORPUS) {
    for (const themeId of ['documentary', 'tech-dark', 'warm-earth']) {
      it(`matches slideshow expansion for ${name} in ${themeId}`, async () => {
        let projected: Doc | undefined;
        let saved: Blob | undefined;

        await runExport(
          markdown,
          `/${name.replaceAll(' ', '-')}.md`,
          {
            ...DEFAULT_OPTIONS,
            format: 'pptx',
            themeId,
            transformStyle: 'documentary',
          },
          null,
          (blob) => {
            saved = blob;
          },
          {
            docToPptx: async (doc, options) => {
              projected = doc;
              return docToPptx(doc, options);
            },
          },
        );

        expect(projected, 'the export should pass a player-ready Doc').not.to.equal(undefined);
        expect(saved, 'the export should save a PPTX Blob').not.to.equal(undefined);
        const expected = projectedSlideCount(projected!);
        const actual = await presentationSlideCount(await saved!.arrayBuffer());
        expect(expected).to.be.greaterThan(1);
        expect(actual).to.equal(expected);
      });
    }
  }
});
