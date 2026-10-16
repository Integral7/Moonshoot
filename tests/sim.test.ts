import { describe, expect, it } from 'vitest';
import { formatDistance, formatDuration, formatMET, formatSpeed } from '../src/sim/time';
import { CalloutSystem } from '../src/sim/callouts';
import { TelemetryRecorder, sampleAt } from '../src/sim/telemetry';
import { buildResult, linearScore, toleranceScore } from '../src/sim/scoring';
import { Mission } from '../src/sim/mission';

describe('mission clock', () => {
  it('formats MET', () => {
    expect(formatMET(0)).toBe('T+00:00:00');
    expect(formatMET(754)).toBe('T+00:12:34');
    expect(formatMET(3 * 86400 + 4 * 3600 + 12 * 60)).toBe('T+3d 04:12:00');
    expect(formatMET(-10)).toBe('T-00:00:10');
  });
  it('formats durations, distances, speeds', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(725)).toBe('12 m 05 s');
    expect(formatDuration(4.5 * 86400)).toBe('4 d 12 h');
    expect(formatDistance(500)).toBe('500 m');
    expect(formatDistance(185_000)).toBe('185.0 km');
    expect(formatDistance(384_400_000)).toBe('384,400 km');
    expect(formatSpeed(7790)).toBe('7.790 km/s');
  });
});

describe('callouts', () => {
  it('fires rules once and re-arms', () => {
    const cs = new CalloutSystem<{ q: number }>([
      { id: 'maxq', role: 'FLIGHT', text: 'Max Q', when: (s) => s.q > 30_000, rearm: (s) => s.q < 10_000 },
    ]);
    const heard: string[] = [];
    cs.onCallout((c) => heard.push(c.text));
    cs.evaluate(1, { q: 35_000 });
    cs.evaluate(2, { q: 36_000 });
    expect(heard).toEqual(['Max Q']);
    cs.evaluate(3, { q: 5_000 });
    cs.evaluate(4, { q: 40_000 });
    expect(heard).toEqual(['Max Q', 'Max Q']);
    cs.sayOnce('x', 5, 'CAPCOM', 'hello');
    cs.sayOnce('x', 6, 'CAPCOM', 'hello');
    expect(cs.log).toHaveLength(3);
  });
});

describe('telemetry', () => {
  it('samples at interval, interpolates, decimates', () => {
    const rec = new TelemetryRecorder([{ id: 'alt', label: 'Altitude', unit: 'm' }], 1, 100);
    for (let t = 0; t <= 50; t += 0.25) rec.sample(t, { alt: t * 10 });
    expect(rec.length).toBe(51);
    expect(sampleAt(rec.data, 'alt', 12.5)).toBeCloseTo(125, 6);
    for (let t = 50.25; t <= 200; t += 0.25) rec.sample(t, { alt: t * 10 });
    expect(rec.length).toBeLessThanOrEqual(100);
    expect(rec.data.t.at(-1)).toBeGreaterThan(195);
  });
});

describe('scoring', () => {
  it('linear and tolerance scores', () => {
    expect(linearScore(5, 0, 10)).toBe(0.5);
    expect(linearScore(-1, 0, 10)).toBe(1);
    expect(linearScore(80, 100, 50)).toBeCloseTo(0.6);
    expect(toleranceScore(102, 100, 5, 20)).toBe(1);
    expect(toleranceScore(120, 100, 5, 20)).toBe(0);
  });
  it('weights metrics and caps failures', () => {
    const r = buildResult('launch', 600, true, [
      { label: 'a', value: '', score: 1, weight: 3 },
      { label: 'b', value: '', score: 0, weight: 1 },
    ], [], '');
    expect(r.score).toBe(750);
    expect(r.rating).toBe('good');
    const f = buildResult('launch', 600, false, [{ label: 'a', value: '', score: 1, weight: 1 }], ['boom'], '');
    expect(f.score).toBe(300);
    expect(f.rating).toBe('fail');
  });
});

describe('mission state machine', () => {
  it('advances through campaign phases and restores on retry', () => {
    const m = new Mission('campaign', 'design', { t: 0 });
    expect(m.nextPhase()).toBe('launch');
    m.carry.t = 100;
    m.advance();
    expect(m.phase).toBe('launch');
    m.carry.t = 999;
    m.carry.flight = { body: 'earth' };
    m.retry();
    expect(m.carry.t).toBe(100);
    expect(m.carry.flight).toBeUndefined();
  });
  it('free play does not advance', () => {
    const m = new Mission('freeplay', 'landing');
    expect(m.advance()).toBeNull();
    expect(m.phase).toBe('landing');
  });
});
