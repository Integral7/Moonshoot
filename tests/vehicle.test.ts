import { describe, expect, it } from 'vitest';
import { G0 } from '../src/physics/constants';
import { deltaV } from '../src/physics/rocket';
import { PARTS } from '../src/sim/parts';
import {
  TEMPLATES,
  Vehicle,
  allocateBudget,
  analyzeDesign,
  combineEngines,
  createVehicleState,
  splitStages,
  type VehicleDesign,
} from '../src/sim/vehicle';
import { getPart } from '../src/sim/parts';

const nova = TEMPLATES[0];

describe('parts catalog', () => {
  it('has unique ids and sane values', () => {
    const ids = new Set(PARTS.map((p) => p.id));
    expect(ids.size).toBe(PARTS.length);
    for (const p of PARTS) {
      expect(p.mass).toBeGreaterThan(0);
      if (p.engine) {
        expect(p.engine.ispVac).toBeGreaterThan(p.engine.ispSl);
        expect(p.engine.thrustVac).toBeGreaterThanOrEqual(p.engine.thrustSl);
      }
    }
  });

  it('three-main parachutes give an Apollo-like ~8.5 m/s splashdown at 5.5 t', () => {
    const c = getPart('chutes-3').chutes!;
    const v = Math.sqrt((2 * 5500 * G0) / (1.225 * c.mainCdA));
    expect(v).toBeGreaterThan(7.5);
    expect(v).toBeLessThan(9.5);
  });
});

describe('stage analysis', () => {
  it('splits stages at decouplers, bottom first', () => {
    const groups = splitStages(['capsule-3', 'dec-s', 'tank-s1', 'eng-sps'].map(getPart));
    expect(groups).toHaveLength(2);
    expect(groups[0].map((p) => p.id)).toEqual(['dec-s', 'tank-s1', 'eng-sps']);
    expect(groups[1].map((p) => p.id)).toEqual(['capsule-3']);
  });

  it('combines engine clusters (thrust adds, Isp preserved)', () => {
    const e = getPart('eng-f1').engine!;
    const c = combineEngines([e, e, e])!;
    expect(c.thrustVac).toBeCloseTo(3 * e.thrustVac, 6);
    expect(c.ispVac).toBeCloseTo(e.ispVac, 9);
  });

  it('stage delta-v follows the rocket equation with the mass above', () => {
    const d: VehicleDesign = { name: 't', parts: ['chutes-3', 'capsule-3', 'shield-39', 'dec-s', 'tank-s2', 'eng-sps'] };
    const a = analyzeDesign(d);
    const s = a.stages[0];
    const top = 250 + 4700 + 850;
    expect(s.massAbove).toBe(top);
    const m0 = top + 150 + 1400 + 18000 + 600;
    expect(s.ignitionMass).toBe(m0);
    expect(s.dvVac).toBeCloseTo(deltaV(314, m0, m0 - 18000), 6);
  });

  it('counts the escape tower only during the first stage burn', () => {
    const a = analyzeDesign(nova);
    const les = 4200;
    const withoutLes = analyzeDesign({ name: 'x', parts: nova.parts.filter((p) => p !== 'les') });
    expect(a.stages[0].ignitionMass - withoutLes.stages[0].ignitionMass).toBeCloseTo(les, 6);
    expect(a.stages[1].ignitionMass).toBeCloseTo(withoutLes.stages[1].ignitionMass, 6);
    expect(a.stages.at(-1)!.ignitionMass).toBeCloseTo(5800, 6);
  });
});

describe('validation', () => {
  it('flags missing capsule, shield, chutes, engines', () => {
    const a = analyzeDesign({ name: 'bad', parts: ['tank-s1', 'dec-s', 'tank-m1'] });
    const text = a.errors.join(' ');
    expect(text).toContain('No crew capsule');
    expect(text).toContain('heat shield');
    expect(text).toContain('parachute');
    expect(text).toContain('no engine');
  });

  it('rejects a vehicle that cannot lift off', () => {
    const a = analyzeDesign({ name: 'heavy', parts: ['chutes-3', 'capsule-3', 'shield-39', 'dec-l', 'tank-l2', 'tank-l2', 'eng-f1'] });
    expect(a.errors.some((e) => e.includes('cannot leave the pad'))).toBe(true);
  });

  it('rejects overloaded parachutes', () => {
    const a = analyzeDesign({ name: 'x', parts: ['chutes-2', 'capsule-3', 'shield-39', 'dec-s', 'tank-s1', 'eng-sps'] });
    expect(a.errors.some((e) => e.includes('Parachutes are rated'))).toBe(true);
  });
});

describe('mission budget', () => {
  it('both flight templates are feasible with positive margin', () => {
    for (const t of TEMPLATES.slice(0, 2)) {
      const a = analyzeDesign(t);
      expect(a.errors).toEqual([]);
      const b = allocateBudget(a);
      expect(b.issues).toEqual([]);
      expect(b.feasible).toBe(true);
      expect(b.margin).toBeGreaterThan(100);
      expect(a.stages[b.landingStage].hasLegs).toBe(true);
      expect(a.liftoffTwr).toBeGreaterThan(1.15);
    }
  });

  it('removing the TLI stage makes the mission infeasible', () => {
    const parts = [...nova.parts];
    const i = parts.indexOf('dec-m');
    parts.splice(i, 5); // dec-m, tank-m2, tank-m1, eng-j2, dec-l -> merge stages
    const b = allocateBudget(analyzeDesign({ name: 'x', parts }));
    expect(b.feasible).toBe(false);
  });

  it('flags a landing stage without legs', () => {
    const parts = nova.parts.filter((p) => p !== 'legs');
    const b = allocateBudget(analyzeDesign({ name: 'x', parts }));
    expect(b.issues.some((s) => s.includes('no landing legs'))).toBe(true);
    expect(b.feasible).toBe(false);
  });
});

describe('runtime vehicle state', () => {
  it('tracks mass, staging, LES jettison and delta-v', () => {
    const v = new Vehicle(createVehicleState(nova));
    const a = analyzeDesign(nova);
    expect(v.mass).toBeCloseTo(a.totalMass, 6);
    expect(v.state.lesAttached).toBe(true);
    const dv0 = v.totalDv;
    v.consume(1e9);
    expect(v.prop).toBe(0);
    expect(v.engine).toBeNull();
    expect(v.separate()).toBe(true);
    expect(v.state.lesAttached).toBe(false);
    expect(v.mass).toBeCloseTo(a.stages[1].ignitionMass, 6);
    expect(v.totalDv).toBeLessThan(dv0);
    // State is plain JSON (serializable for carry/replay).
    expect(JSON.parse(JSON.stringify(v.state))).toEqual(v.state);
  });

  it('respects minimum throttle', () => {
    const v = new Vehicle(createVehicleState(nova));
    expect(v.effectiveThrottle(0.3)).toBe(1); // F-1 is fixed thrust
    expect(v.effectiveThrottle(0)).toBe(0);
  });

  it('capsule aerodynamics: blunt body with lift, chutes add drag', () => {
    const v = new Vehicle(createVehicleState({ name: 'c', parts: ['chutes-3', 'capsule-3', 'shield-39'] }));
    expect(v.isLastStage).toBe(true);
    expect(v.liftToDrag).toBeCloseTo(0.3);
    const base = v.cdA;
    v.state.chutes = 'main';
    expect(v.cdA).toBeGreaterThan(base * 50);
    expect(v.liftToDrag).toBe(0);
  });
});

describe('engine cluster layout', () => {
  it('places engines without overlap (Saturn 5, Nova 9, methalox 21)', async () => {
    const { clusterLayout } = await import('../src/render/vehicleMesh');
    for (const [n, ed, D] of [[5, 3.7, 10.1], [9, 3.7, 10.1], [21, 1.3, 10.1], [3, 1.5, 6.6], [1, 2, 3.9], [8, 2, 10.1]]) {
      const pts = clusterLayout(n, ed, D);
      expect(pts).toHaveLength(n);
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) expect(Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z)).toBeGreaterThanOrEqual(ed * 0.99);
    }
    const saturn = clusterLayout(5, 3.7, 10.1);
    expect(saturn.some((p) => Math.hypot(p.x, p.z) < 1e-9)).toBe(true); // center engine
  });
});

describe('vehicle dimensions', () => {
  it('reports a plausible stack height (clustered engines counted once)', () => {
    const a = analyzeDesign(TEMPLATES[0]);
    expect(a.totalLength).toBeGreaterThan(90);
    expect(a.totalLength).toBeLessThan(220); // Nova-class on a 10.1 m core is tall (~195 m)
  });
});
