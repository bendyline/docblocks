import type { AiImageModel } from '@bendyline/docblocks/host';
import { formatModelSize } from '../Speech/format.js';

/** What the person should know about a model before downloading it. */
export function imageModelFacts(model: AiImageModel): string[] {
  const facts: string[] = [];
  if (model.downloadBytes !== null) facts.push(formatModelSize(model.downloadBytes));
  if (model.license) facts.push(model.license);
  if (model.commercialUse === false) facts.push('Not for commercial use');
  if (model.rendersText) facts.push('Draws legible text');
  if (model.hardwareTier === 'workstation') {
    facts.push(
      model.minRamGb !== null
        ? `Workstation · ${String(model.minRamGb)} GB+ memory`
        : 'Workstation',
    );
  }
  if (model.shared) facts.push('Shared with Gezel, no download needed');
  if (model.fit && model.fit.verdict !== 'fits' && model.fit.reason) facts.push(model.fit.reason);
  return facts;
}
