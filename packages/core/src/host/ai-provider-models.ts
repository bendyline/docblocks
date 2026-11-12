/**
 * Reading Gezel's model ratings into the AI wire types.
 *
 * Every host that lists Gezel models for Settings (the desktop connector, the
 * mobile host) reads the same three things from each entry: Gezel's general
 * `recommendation`, its `docbench_recommendation` (the same question ranked
 * by measured quality on DocBlocks' own work), and the `docbench` result.
 * They read them here, so the two surfaces cannot disagree about which
 * ranking wins or what a malformed field becomes.
 */

import type { AiModelDocbench, AiModelDownloadInfo } from './ai.js';
import { parseAiModelDocbench } from './ai-wire-policy.js';

/** How a provider rates one model for this device. */
export interface ProviderModelRanking {
  /** 0–100, or null when the provider sent no usable rating. */
  readonly score: number | null;
  readonly recommended: boolean;
}

/** The rating fields a Gezel model entry may carry; unknown until read. */
export interface ProviderModelRatings {
  readonly recommendation?: unknown;
  readonly docbench_recommendation?: unknown;
  readonly docbench?: unknown;
}

function readRanking(value: unknown): ProviderModelRanking | null {
  if (typeof value !== 'object' || value === null) return null;
  const { score, recommended } = value as Record<string, unknown>;
  return {
    score:
      typeof score === 'number' && Number.isInteger(score) && score >= 0 && score <= 100
        ? score
        : null,
    recommended: recommended === true,
  };
}

/**
 * Gezel's rating of a model for this device. The docbench ranking wins when
 * Gezel sent one (it does once anything in the catalog is measured): the
 * general ranking weighs the curated agent-work score, and DocBlocks never
 * runs an agent.
 */
export function providerModelRanking(entry: ProviderModelRatings): ProviderModelRanking {
  return (
    readRanking(entry.docbench_recommendation) ??
    readRanking(entry.recommendation) ?? { score: null, recommended: false }
  );
}

/**
 * The model's docbench result, bounded as it must be to cross the host
 * boundary; undefined when absent or malformed. A result without family
 * scores still reads, with none.
 */
export function providerModelDocbench(entry: ProviderModelRatings): AiModelDocbench | undefined {
  const value = entry.docbench;
  if (typeof value !== 'object' || value === null) return undefined;
  const { score, band, version, families } = value as Record<string, unknown>;
  return (
    parseAiModelDocbench({
      score,
      band,
      version,
      families: families === undefined ? {} : families,
    }) ?? undefined
  );
}

/** Best match first: the recommendation, then by score. Unrated entries keep the provider's order. */
export function sortModelDownloads<T extends Pick<AiModelDownloadInfo, 'recommended' | 'score'>>(
  models: readonly T[],
): T[] {
  return [...models].sort(
    (a, b) => Number(b.recommended) - Number(a.recommended) || (b.score ?? -1) - (a.score ?? -1),
  );
}
