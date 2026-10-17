import { describe, expect, it } from 'vitest';
import { EntrySim, entryAutopilot, entryState } from '../src/sim/reentry';
import { STANDARD_EPHEMERIS } from '../src/sim/presets';
import { TEMPLATES, createVehicleState } from '../src/sim/vehicle';
import { MU_EARTH, R_EARTH } from '../src/physics/constants';

const DEG = Math.PI / 180;
const capsule = () => createVehicleState({ name: 'cm', parts: TEMPLATES[0].parts.slice(1, 7) });

/** Lunar-return speed at 140 km (apogee at lunar distance). */
const vEntry = () => {
  const r = R_EARTH + 140e3;
  const a = (r + 384_400e3) / 2;
  return Math.sqrt(MU_EARTH * (2 / r - 1 / a));
};

function fly(gammaDeg: number, auto = true) {
  const s = entryState(140e3, vEntry(), gammaDeg * DEG);
  const sim = new EntrySim(s.r, s.v, capsule(), STANDARD_EPHEMERIS, 0);
  while (!sim.failed && !sim.splash && sim.t < 4_000) sim.step(auto ? entryAutopilot(sim) : { bank: 0 });
  return sim;
}

describe('reentry', () => {
  it('separates down to the capsule', () => {
    const s = entryState(140e3, 11_000, -6 * DEG);
    const sim = new EntrySim(s.r, s.v, capsule(), STANDARD_EPHEMERIS, 0);
    expect(sim.vehicle.isLastStage).toBe(true);
    expect(sim.vehicle.mass).toBeCloseTo(5_800, 0);
  });

  it('autopilot lunar return at -6.5 deg stays in the corridor and splashes down under chutes', () => {
    const sim = fly(-6.2);
    expect(sim.failed).toBeNull();
    expect(sim.splash).not.toBeNull();
    expect(sim.splash!.speed).toBeLessThan(10);
    expect(sim.peakG).toBeGreaterThan(3);
    expect(sim.peakG).toBeLessThan(9);
    expect(sim.entryAngle / DEG).toBeGreaterThan(-7.5);
    expect(sim.entryAngle / DEG).toBeLessThan(-5);
    expect(sim.vehicle.state.chutes).toBe('main');
    // Apollo-class peak heating: hundreds of W/cm^2.
    expect(sim.peakFlux / 1e4).toBeGreaterThan(60);
    expect(sim.peakFlux / 1e4).toBeLessThan(550);
  });

  it('too shallow skips out', () => {
    const sim = fly(-3.5, false);
    expect(sim.failed).toContain('Skip-out');
  });

  it('too steep exceeds the g or heating limit', () => {
    const sim = fly(-11, false);
    expect(sim.failed).toMatch(/g \(crew limit|burn-through/);
  });

  it('opening the mains at high dynamic pressure shreds them', () => {
    const s = entryState(140e3, vEntry(), -6.2 * DEG);
    const sim = new EntrySim(s.r, s.v, capsule(), STANDARD_EPHEMERIS, 0);
    while (!sim.failed && !sim.splash && sim.t < 4_000) {
      const c = entryAutopilot(sim);
      sim.step({ ...c, deployMain: sim.altitude < 40_000 });
    }
    expect(sim.events.some((e) => e.kind === 'chute-fail')).toBe(true);
    expect(sim.failed).toContain('Impact');
  });
});
