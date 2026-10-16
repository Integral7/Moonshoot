import { describe, expect, it } from 'vitest';
import { AscentSim, ascentAutopilot, flyAscent, TARGET_ALTITUDE } from '../src/sim/ascent';
import { STANDARD_EPHEMERIS } from '../src/sim/presets';
import { TEMPLATES, analyzeDesign, allocateBudget } from '../src/sim/vehicle';

describe('ascent autopilot', () => {
  for (const t of TEMPLATES.slice(0, 2)) {
    it(`flies "${t.name}" into a ~185 km parking orbit`, () => {
      const sim = flyAscent(t, STANDARD_EPHEMERIS);
      expect(sim.failed).toBeNull();
      expect(sim.apoapsisAltitude).toBeGreaterThan(TARGET_ALTITUDE - 25e3);
      expect(sim.apoapsisAltitude).toBeLessThan(TARGET_ALTITUDE + 40e3);
      expect(sim.periapsisAltitude).toBeGreaterThan(140e3);
      // Ascent delta-v (with losses) should be in line with the 9.4 km/s design allocation.
      expect(sim.dvUsed).toBeGreaterThan(8_000);
      expect(sim.dvUsed).toBeLessThan(9_800);
      expect(sim.maxQ).toBeGreaterThan(15_000);
      expect(sim.maxQ).toBeLessThan(60_000);
      expect(sim.maxG).toBeLessThan(6);
      expect(sim.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['liftoff', 'max-q', 'staging', 'go-orbit', 'meco']));
      // The design budget predicted this flight would fit in the allocated stages.
      const b = allocateBudget(analyzeDesign(t));
      const ascentStages = b.legs[0].stages;
      expect(sim.vehicle.state.stage).toBeLessThanOrEqual(Math.max(...ascentStages));
    });
  }

  it('does not lift off with TWR < 1', () => {
    const sim = new AscentSim({ name: 'x', parts: ['chutes-3', 'capsule-3', 'shield-39', 'dec-l', 'tank-l2', 'tank-l2', 'eng-f1'] }, STANDARD_EPHEMERIS);
    while (sim.t < 15 && !sim.failed) sim.step({ throttle: 1, pitch: 0 });
    expect(sim.launched).toBe(false);
    expect(sim.failed).toContain('never left the pad');
  });

  it('breaks up when pitched hard in the dense atmosphere', () => {
    const sim = new AscentSim(TEMPLATES[0], STANDARD_EPHEMERIS);
    while (sim.t < 120 && !sim.failed) {
      const c = ascentAutopilot(sim);
      sim.step(sim.t > 40 ? { throttle: 1, pitch: 80 } : c);
    }
    expect(sim.failed).toContain('Structural breakup');
  });

  it('holds on the pad co-rotating with Earth before liftoff', () => {
    const sim = new AscentSim(TEMPLATES[0], STANDARD_EPHEMERIS);
    for (let i = 0; i < 200; i++) sim.step({ throttle: 0, pitch: 0 });
    expect(sim.launched).toBe(false);
    expect(Math.abs(sim.altitude)).toBeLessThan(1e-3);
    expect(sim.surfaceSpeed).toBeLessThan(1e-6);
  });
});
