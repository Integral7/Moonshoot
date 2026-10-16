// Persistent user settings. Storage access is always guarded: it can throw or be
// unavailable (private windows, blocked site data), and the game must still run.

import { isQualityLevel, type QualityLevel } from '../render/quality';

export interface Settings {
  quality: QualityLevel;
  /** Show flight director callouts as toasts in addition to the log. */
  callouts: boolean;
  /** Units used in HUD readouts. */
  units: 'metric';
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'medium',
  callouts: true,
  units: 'metric',
};

const KEY = 'moonshot.settings.v1';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadSettings(store: KeyValueStore | null = defaultStore()): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  if (!store) return s;
  try {
    const raw = store.getItem(KEY);
    if (!raw) return s;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    if (isQualityLevel(parsed.quality)) s.quality = parsed.quality;
    if (typeof parsed.callouts === 'boolean') s.callouts = parsed.callouts;
  } catch {
    // Corrupt or inaccessible storage: fall back to defaults.
  }
  return s;
}

export function saveSettings(settings: Settings, store: KeyValueStore | null = defaultStore()): void {
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Ignore: settings just won't persist.
  }
}
