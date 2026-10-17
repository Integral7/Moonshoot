import { describe, expect, it } from 'vitest';
import { TrackRecorder, compactReplay, listReplays, saveReplay, deleteReplay, trackAt, type Replay, type KeyValueStore } from '../src/sim/replay';
import { TelemetryRecorder } from '../src/sim/telemetry';
import { DEFAULT_DESIGN } from '../src/sim/vehicle';
import { STANDARD_EPHEMERIS } from '../src/sim/presets';

function memStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

function makeReplay(id: string, n = 4000): Replay {
  const tr = new TrackRecorder(0.5, 10_000);
  const tel = new TelemetryRecorder([{ id: 'alt', label: 'Altitude', unit: 'm' }], 0.5, 10_000);
  for (let i = 0; i < n; i++) {
    const t = i * 0.5;
    tr.sample(t, { body: i < n / 2 ? 'earth' : 'moon', r: { x: t * 100, y: 0, z: 1 }, dir: { x: 1, y: 0, z: 0 }, throttle: 0.5, stage: 0 });
    tel.sample(t, { alt: t * 10 });
  }
  return { id, phase: 'launch', title: 'Launch', date: new Date(2026, 9, 16, 12, 0, Number(id.slice(1))).toISOString(), score: 900, success: true, design: DEFAULT_DESIGN, eph: STANDARD_EPHEMERIS, track: tr.track, telemetry: tel.data };
}

describe('replays', () => {
  it('interpolates the track and does not interpolate across a body switch', () => {
    const r = makeReplay('r1', 10);
    const s = trackAt(r.track, 1.25);
    expect(s.r.x).toBeCloseTo(125, 6);
    expect(s.body).toBe('earth');
    const sw = trackAt(r.track, 2.1); // between sample 4 (earth) and 5 (moon)
    expect(['earth', 'moon']).toContain(sw.body);
    expect(sw.r.x === 200 || sw.r.x === 250).toBe(true);
  });

  it('compacts to a bounded size and round-trips through storage', () => {
    const st = memStore();
    const r = makeReplay('r1');
    const c = compactReplay(r, 500);
    expect(c.track.t.length).toBeLessThanOrEqual(501);
    expect(c.telemetry.t.length).toBeLessThanOrEqual(501);
    saveReplay(r, st);
    const list = listReplays(st);
    expect(list.some((x) => x.id === 'r1')).toBe(true);
    expect(st.data.get('moonshot.replays.v1')!.length).toBeLessThan(400_000);
    deleteReplay('r1', st);
    expect(listReplays(st).some((x) => x.id === 'r1')).toBe(false);
  });

  it('keeps at most 8 and survives a failing store', () => {
    const st = memStore();
    for (let i = 0; i < 11; i++) saveReplay(makeReplay(`r${i + 10}`, 50), st);
    expect(JSON.parse(st.data.get('moonshot.replays.v1')!).length).toBe(8);
    const bad: KeyValueStore = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(() => saveReplay(makeReplay('r99', 50), bad)).not.toThrow();
  });
});
