import { describe, expect, it } from 'vitest';
import { LunarTerrain, craterProfile } from '../src/sim/terrain';
import { DescentSim, descentAutopilot } from '../src/sim/descent';
import { STANDARD_EPHEMERIS } from '../src/sim/presets';
import { TEMPLATES, createVehicleState } from '../src/sim/vehicle';
import { MU_MOON, R_MOON } from '../src/physics/constants';
import { norm, vec } from '../src/physics/vec';

describe('lunar terrain', () => {
  const t = new LunarTerrain(vec(1, 0.2, 0.05), 7);

  it('round-trips map coordinates', () => {
    for (const [x, y] of [[0, 0], [1200, -800], [-150_000, 90_000], [310_000, 5]]) {
      const p = t.toLocal(t.toDir(x, y));
      expect(p.x).toBeCloseTo(x, 3);
      expect(p.y).toBeCloseTo(y, 3);
    }
  });

  it('is deterministic and bounded', () => {
    const t2 = new LunarTerrain(vec(1, 0.2, 0.05), 7);
    for (let i = 0; i < 200; i++) {
      const x = (i * 7919) % 200_000 - 100_000;
      const y = (i * 104729) % 200_000 - 100_000;
      const h = t.height(x, y);
      expect(h).toBe(t2.height(x, y));
      expect(Math.abs(h)).toBeLessThan(4_000);
    }
    expect(t.bouldersNear(500, 500, 300)).toEqual(t2.bouldersNear(500, 500, 300));
  });

  it('crater profile: bowl below, rim above the mean surface', () => {
    expect(craterProfile(0)).toBeLessThan(-0.9);
    expect(craterProfile(1)).toBeGreaterThan(0.3);
    expect(Math.abs(craterProfile(3))).toBeLessThan(0.01);
  });

  it('has boulders, mostly small', () => {
    const bs = t.bouldersNear(0, 0, 2000);
    expect(bs.length).toBeGreaterThan(50);
    const big = bs.filter((b) => b.radius > 2).length;
    expect(big / bs.length).toBeLessThan(0.2);
  });
});

describe('powered descent', () => {
  // Lander stack of the recommended design: return stage + capsule above a descent stage with legs.
  const lander = () => createVehicleState({ name: 'lander', parts: TEMPLATES[0].parts.slice(1, 15) });

  /** Start at the 15 km periapsis of a 110 x 15 km lunar orbit. */
  function start(): DescentSim {
    const rp = R_MOON + 15e3;
    const ra = R_MOON + 110e3;
    const a = (rp + ra) / 2;
    const vp = Math.sqrt(MU_MOON * (2 / rp - 1 / a));
    const st = lander();
    return new DescentSim(vec(rp, 0, 0), vec(0, vp, 0), st, STANDARD_EPHEMERIS, 0);
  }

  it('the autopilot lands within the leg limits with fuel to spare', () => {
    const sim = start();
    expect(sim.vehicle.hasLegs).toBe(true);
    const prop0 = sim.vehicle.prop;
    while (!sim.landed && sim.t < 2_000) sim.step(descentAutopilot(sim));
    expect(sim.landed).toBe(true);
    const td = sim.touchdown!;
    expect(td.vertical).toBeLessThan(3);
    expect(td.horizontal).toBeLessThan(1.5);
    expect(sim.vehicle.prop).toBeGreaterThan(0);
    expect(sim.dvUsed).toBeGreaterThan(1_600);
    expect(sim.dvUsed).toBeLessThan(2_300);
    expect(prop0 - sim.vehicle.prop).toBeGreaterThan(0);
  });

  it('a lander dropped from 2 km without firing crashes', () => {
    const sim = new DescentSim(vec(R_MOON + 2_000, 0, 0), vec(0, 0, 0), lander(), STANDARD_EPHEMERIS, 0);
    while (!sim.landed && sim.t < 3_000) sim.step({ throttle: 0, dir: norm(sim.r) });
    expect(sim.landed).toBe(true);
    expect(sim.touchdown!.outcome).toBe('crashed');
  });
});
