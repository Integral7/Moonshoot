import { describe, expect, it } from 'vitest';
import { returnPreset } from '../src/sim/presets';
import { DescentSim, lunarAscentAutopilot } from '../src/sim/descent';
import { OrbitalFlight, planTei, earthApproach } from '../src/sim/orbital';
import { EntrySim, entryAutopilot } from '../src/sim/reentry';
import { moonRotation } from '../src/physics/bodies';
import { MOON } from '../src/physics/bodies';
import { cross, norm, rotateZ, vec } from '../src/physics/vec';
import { R_MOON } from '../src/physics/constants';

const DEG = Math.PI / 180;

describe('return to Earth', () => {
  it('lifts off, reaches lunar orbit, injects for Earth, and splashes down', () => {
    const p = returnPreset();
    const rot = moonRotation(p.surface.t, p.surface.eph);
    const r = rotateZ(p.surface.r, rot);
    const w = MOON.rotationRate;
    const sim = new DescentSim(r, vec(-w * r.y, w * r.x, 0), p.vehicle, p.surface.eph, p.surface.t, 1969, true);
    expect(sim.grounded).toBe(true);
    expect(sim.vehicle.separate()).toBe(true); // leave the descent stage on the Moon
    const east = norm(cross(vec(0, 0, 1), sim.up));
    while (sim.t < p.surface.t + 2_000 && !sim.landed) {
      const c = lunarAscentAutopilot(sim, east);
      if (c.throttle === 0) break;
      sim.step(c);
    }
    expect(sim.landed).toBe(false);
    expect(sim.altitude).toBeGreaterThan(8_000);

    const f = new OrbitalFlight({ body: 'moon', t: sim.t, r: sim.r, v: sim.v }, sim.vehicle.state, p.surface.eph);
    const el = f.elements();
    expect(el.rp - R_MOON).toBeGreaterThan(5_000);
    expect(el.e).toBeLessThan(0.1);

    const tei = planTei(f)!;
    expect(tei).not.toBeNull();
    const mag = Math.hypot(tei.dv.prograde, tei.dv.radial, tei.dv.normal);
    expect(mag).toBeGreaterThan(700);
    expect(mag).toBeLessThan(1_200);
    f.setNode(tei);
    f.executeNode();
    f.advance(tei.t - f.t + f.nodeBurnTime() + 60);
    const ap = earthApproach(f.predict(6 * 86400, 3))!;
    expect(ap).not.toBeNull();
    expect(ap.gamma / DEG).toBeGreaterThan(-7.2);
    expect(ap.gamma / DEG).toBeLessThan(-5.8);

    f.advance(6 * 86400);
    expect(f.halted?.kind).toBe('atmosphere');
    const e = new EntrySim(f.s.r, f.s.v, f.vehicle.state, f.eph, f.t);
    while (!e.failed && !e.splash && e.t < f.t + 4_000) e.step(entryAutopilot(e));
    expect(e.failed).toBeNull();
    expect(e.splash!.outcome).toBe('nominal');
  });
});
