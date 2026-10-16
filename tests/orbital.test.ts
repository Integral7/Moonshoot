import { describe, expect, it } from 'vitest';
import { flyAscent } from '../src/sim/ascent';
import { OrbitalFlight, lunarApproach, refineNodeFinite } from '../src/sim/orbital';
import { STANDARD_EPHEMERIS, parkingOrbit } from '../src/sim/presets';
import { TEMPLATES, createVehicleState } from '../src/sim/vehicle';
import { planTli } from '../src/physics/planner';
import { R_EARTH } from '../src/physics/constants';

describe('orbital flight', () => {
  const ascent = flyAscent(TEMPLATES[0], STANDARD_EPHEMERIS);

  it('circularizes the insertion orbit with a finite burn', () => {
    const f = new OrbitalFlight(ascent.orbitState(), structuredClone(ascent.vehicle.state), STANDARD_EPHEMERIS);
    const node = f.circularizeNode('apoapsis')!;
    expect(node).not.toBeNull();
    f.setNode(node);
    expect(f.executeNode()).toBe(true);
    f.advance(node.t - f.t + 120);
    const el = f.elements();
    expect(f.events.some((e) => e.kind === 'burn-end')).toBe(true);
    expect(el.e).toBeLessThan(0.003);
    expect(el.rp - R_EARTH).toBeGreaterThan(180e3);
  });

  it('a planned TLI flown as a finite burn reaches the Moon', () => {
    const park = parkingOrbit(0);
    const f = new OrbitalFlight(park, createVehicleState({ name: 'tli', parts: TEMPLATES[0].parts.slice(1, 19) }), STANDARD_EPHEMERIS);
    const plan = planTli(f.s, { eph: STANDARD_EPHEMERIS, targetAltitude: 110e3 })!;
    const target = 1_737_400 + 110e3;
    const node = refineNodeFinite(f, { t: plan.burnTime, dv: plan.dv }, (after) => {
      const ap = lunarApproach(after.predict(8 * 86400, 2));
      return ap ? ap.signedRadius - target : NaN;
    });
    f.setNode(node);
    const tb = f.nodeBurnTime();
    expect(tb).toBeGreaterThan(60);
    expect(f.executeNode()).toBe(true);
    f.advance(node.t - f.t + tb);
    expect(f.events.some((e) => e.kind === 'burn-end')).toBe(true);
    expect(f.dvUsed).toBeGreaterThan(3_100);
    expect(f.dvUsed).toBeLessThan(3_300);
    const ap = lunarApproach(f.predict(8 * 86400))!;
    expect(ap).not.toBeNull();
    // The refined finite burn lands close to the 110 km target.
    expect(Math.abs(ap.periapsis - 110e3)).toBeLessThan(30e3);
  });

  it('coasting is exact and halts at the atmosphere', () => {
    const f = new OrbitalFlight(parkingOrbit(0), createVehicleState(TEMPLATES[0]), STANDARD_EPHEMERIS);
    const r0 = f.s.r;
    const T = f.elements().period;
    f.advance(T);
    expect(Math.hypot(f.s.r.x - r0.x, f.s.r.y - r0.y, f.s.r.z - r0.z)).toBeLessThan(1);
    // Retro burn into the atmosphere.
    f.attitude = 'retrograde';
    f.throttle = 1;
    f.advance(30);
    f.throttle = 0;
    f.advance(3 * 3600);
    expect(f.halted?.kind).toBe('atmosphere');
  });
});

describe('mid-course correction planner', () => {
  it('corrects the free-play cruise (900 km) to a 110 km lunar periapsis with a few m/s', async () => {
    const { cruisePreset, cruiseVehicle } = await import('../src/sim/presets');
    const { planLunarCorrection } = await import('../src/sim/orbital');
    const p = cruisePreset();
    const f = new OrbitalFlight(p.orbit, cruiseVehicle(), p.eph);
    const node = planLunarCorrection(f, f.t + 1800)!;
    expect(node).not.toBeNull();
    const mag = Math.hypot(node.dv.prograde, node.dv.normal, node.dv.radial);
    expect(mag).toBeLessThan(20);
    f.setNode(node);
    f.executeNode();
    f.advance(node.t - f.t + 120);
    const ap = lunarApproach(f.predict(8 * 86400))!;
    expect(Math.abs(ap.periapsis - 110e3)).toBeLessThan(10e3);
    expect(ap.signedRadius).toBeGreaterThan(0);
  });
});
