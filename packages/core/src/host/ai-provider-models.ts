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
  /** The entry's model id; it names Apple's model, which Gezel does not rate. */
  readonly id?: unknown;
  readonly recommendation?: unknown;
  readonly docbench_recommendation?: unknown;
  readonly docbench?: unknown;
}

/** Apple Foundation Models' id in every Gezel listing, desktop and mobile. */
const APPLE_FOUNDATION_MODELS_ID = 'apple-foundation-models:apple-foundation-models';

/**
 * Apple's on-device model as docbench measured it: version 0.2.2, public
 * fixtures, macOS 27.2 on an M5 Max, judged by Claude Opus 5.5 (Gezel round
 * `docbench-mac-public-2026-11-12`; the holdout round scored 56.5). Gezel
 * publishes docbench only into the catalog models it downloads, so its Apple
 * entry carries none, and Settings showed every model's score but Apple's.
 * Gezel's own result wins once it sends one. The band is this round's, where
 * the cloud references set the top. Rerun and update this on a docbench
 * version that changes scores, or a new Apple model.
 */
const APPLE_FOUNDATION_MODELS_DOCBENCH: AiModelDocbench = {
  score: 54.4,
  band: 6,
  version: '0.2.2',
  families: {
    review: 25.8,
    writing: 78.5,
    visuals: 44.9,
    presentations: 72.7,
    study: 55.4,
    narration: 74.9,
  },
};

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
 * scores still reads, with none. Apple's model, which Gezel does not rate,
 * reads as DocBlocks measured it.
 */
export function providerModelDocbench(entry: ProviderModelRatings): AiModelDocbench | undefined {
  return (
    readDocbench(entry.docbench) ??
    (entry.id === APPLE_FOUNDATION_MODELS_ID ? APPLE_FOUNDATION_MODELS_DOCBENCH : undefined)
  );
}

function readDocbench(value: unknown): AiModelDocbench | undefined {
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

/**
 * Whether the operating system supplies this model (Apple Foundation Models)
 * instead of weights the app downloads: Gezel reports that as a system
 * `preparation`. An entry from a Gezel that predates the field reads false.
 */
export function providerModelIsSystem(entry: { readonly preparation?: unknown }): boolean {
  return entry.preparation === 'system-download' || entry.preparation === 'system-settings';
}

/** Best match first: the recommendation, then by score. Unrated entries keep the provider's order. */
export function sortModelDownloads<T extends Pick<AiModelDownloadInfo, 'recommended' | 'score'>>(
  models: readonly T[],
): T[] {
  return [...models].sort(
    (a, b) => Number(b.recommended) - Number(a.recommended) || (b.score ?? -1) - (a.score ?? -1),
  );
}
