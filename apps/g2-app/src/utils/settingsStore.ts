/**
 * Persists the selected language pair. Inside the Even App WebView the
 * bridge's app-scoped storage is used; in a plain browser or the simulator it
 * gracefully falls back to window.localStorage. All failures are swallowed —
 * settings persistence is a convenience, never a hard dependency.
 */

import {
  DEFAULT_MY_LANGUAGE,
  DEFAULT_OTHER_LANGUAGE,
  isSupportedLanguageCode,
} from '@turntranslate/shared';
import type { LanguageSettings } from '../types';

const STORAGE_KEY = 'turntranslate.languages.v1';

export interface SettingsBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export function createBridgeSettingsBackend(bridge: {
  getLocalStorage(key: string): Promise<string>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
}): SettingsBackend {
  return {
    async get(key) {
      const value = await bridge.getLocalStorage(key);
      return value || null;
    },
    async set(key, value) {
      await bridge.setLocalStorage(key, value);
    },
  };
}

export function createBrowserSettingsBackend(): SettingsBackend {
  return {
    async get(key) {
      if (typeof localStorage === 'undefined') return null;
      return localStorage.getItem(key);
    },
    async set(key, value) {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, value);
    },
  };
}

export function defaultLanguageSettings(): LanguageSettings {
  return { myLanguage: DEFAULT_MY_LANGUAGE, otherLanguage: DEFAULT_OTHER_LANGUAGE };
}

export async function loadLanguageSettings(backend: SettingsBackend): Promise<LanguageSettings> {
  try {
    const raw = await backend.get(STORAGE_KEY);
    if (!raw) return defaultLanguageSettings();
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      isSupportedLanguageCode((parsed as Record<string, unknown>).myLanguage) &&
      isSupportedLanguageCode((parsed as Record<string, unknown>).otherLanguage)
    ) {
      const record = parsed as { myLanguage: string; otherLanguage: string };
      if (record.myLanguage !== record.otherLanguage) {
        return record as LanguageSettings;
      }
    }
  } catch {
    // Corrupt or unavailable storage — fall through to defaults.
  }
  return defaultLanguageSettings();
}

export async function saveLanguageSettings(
  backend: SettingsBackend,
  settings: LanguageSettings,
): Promise<void> {
  try {
    await backend.set(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Persistence is best-effort.
  }
}
