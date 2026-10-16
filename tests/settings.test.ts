import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type KeyValueStore } from '../src/app/settings';
import { QUALITY_PRESETS } from '../src/render/quality';

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('settings', () => {
  it('returns defaults with no store', () => {
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips through a store', () => {
    const store = memoryStore();
    saveSettings({ ...DEFAULT_SETTINGS, quality: 'high', callouts: false }, store);
    expect(loadSettings(store)).toMatchObject({ quality: 'high', callouts: false });
  });

  it('ignores corrupt or invalid data', () => {
    const store = memoryStore();
    store.data.set('moonshot.settings.v1', '{not json');
    expect(loadSettings(store)).toEqual(DEFAULT_SETTINGS);
    store.data.set('moonshot.settings.v1', JSON.stringify({ quality: 'ultra' }));
    expect(loadSettings(store).quality).toBe('medium');
  });

  it('survives a store that throws', () => {
    const bad: KeyValueStore = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(loadSettings(bad)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(DEFAULT_SETTINGS, bad)).not.toThrow();
  });
});

describe('quality presets', () => {
  it('scale monotonically from low to high', () => {
    const { low, medium, high } = QUALITY_PRESETS;
    for (const key of ['sphereSegments', 'starCount', 'terrainResolution', 'particleCount', 'trailPoints', 'planetTextureSize'] as const) {
      expect(low[key]).toBeLessThan(medium[key]);
      expect(medium[key]).toBeLessThan(high[key]);
    }
    expect(low.bloom).toBe(false);
    expect(high.shadows).toBe(true);
  });
});
