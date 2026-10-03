/** AI preferences persisted in the desktop settings file. */

import type { AiPreferences } from '@bendyline/docblocks/host';

import type { PersistedAiSettings, Settings } from '../settings-schema.js';
import { DEFAULT_AI_PREFERENCES, type AiPreferenceStore } from './ai-service.js';

export function aiPreferencesFromSettings(settings: Pick<Settings, 'ai'>): AiPreferences {
  const stored = settings.ai;
  if (!stored) return DEFAULT_AI_PREFERENCES;
  return {
    enabled: stored.enabled,
    model: stored.model ?? null,
    reviewMode: stored.reviewMode ?? DEFAULT_AI_PREFERENCES.reviewMode,
  };
}

export function aiSettingsFromPreferences(preferences: AiPreferences): PersistedAiSettings {
  return {
    enabled: preferences.enabled,
    ...(preferences.model === null ? {} : { model: preferences.model }),
    reviewMode: preferences.reviewMode,
  };
}

export interface SettingsAccess {
  read(): Promise<Settings>;
  update(update: (settings: Settings) => Settings | void): Promise<Settings>;
}

export function createSettingsAiPreferenceStore(settings: SettingsAccess): AiPreferenceStore {
  return {
    async read() {
      return aiPreferencesFromSettings(await settings.read());
    },
    async write(preferences) {
      await settings.update((draft) => {
        draft.ai = aiSettingsFromPreferences(preferences);
      });
    },
  };
}
