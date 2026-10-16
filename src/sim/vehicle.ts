// Vehicle design analysis (stages, mass, thrust, delta-v), mission delta-v
// budget allocation, and the runtime vehicle state used in flight.

import { G0, MU_MOON, R_MOON } from '../physics/constants';
import { deltaV } from '../physics/rocket';
import { getPart, type EngineSpec, type PartDef } from './parts';

/** A design is the list of part ids from top (nose) to bottom (first stage). */
export interface VehicleDesign {
  name: string;
  parts: string[];
}

export interface StageInfo {
  /** 0 = fires first (bottom). */
  index: number;
  /** Parts in this stage, top to bottom. */
  parts: PartDef[];
  dryMass: number;
  propMass: number;
  /** Mass of everything above this stage at ignition (excluding jettisoned LES for stages > 0), kg. */
  massAbove: number;
  /** Total vehicle mass at this stage's ignition, kg. */
  ignitionMass: number;
  engine: EngineSpec | null;
  engineCount: number;
  dvVac: number;
  /** Delta-v using the average of sea-level and vacuum Isp (first stage ascent estimate). */
  dvAscent: number;
  /** Ignition thrust-to-weight at Earth sea level (sea-level thrust). */
  twrEarth: number;
  /** Ignition thrust-to-weight in lunar surface gravity (vacuum thrust). */
  twrMoon: number;
  burnTime: number;
  hasLegs: boolean;
  hasCapsule: boolean;
  maxDiameter: number;
  length: number;
}

export interface DesignAnalysis {
  stages: StageInfo[];
  totalMass: number;
  totalLength: number;
  liftoffTwr: number;
  crew: number;
  hasLes: boolean;
  errors: string[];
  warnings: string[];
}

const LUNAR_G = MU_MOON / (R_MOON * R_MOON);

/** Combine identical or mixed engines in a stage into one equivalent engine. */
export function combineEngines(engines: EngineSpec[]): EngineSpec | null {
  if (!engines.length) return null;
  const thrustVac = engines.reduce((s, e) => s + e.thrustVac, 0);
  const thrustSl = engines.reduce((s, e) => s + e.thrustSl, 0);
  // Isp of a cluster is thrust-weighted by mass flow: F_total / sum(F_i / Isp_i).
  const ispVac = thrustVac / engines.reduce((s, e) => s + e.thrustVac / e.ispVac, 0);
  const ispSl = thrustSl / engines.reduce((s, e) => s + e.thrustSl / e.ispSl, 0);
  const minThrottle = Math.max(...engines.map((e) => e.minThrottle));
  return { thrustVac, thrustSl, ispVac, ispSl, minThrottle };
}

/** Split a top-to-bottom part list into stages at decouplers (a decoupler goes with the stage below it). */
export function splitStages(parts: PartDef[]): PartDef[][] {
  const groups: PartDef[][] = [[]];
  for (const p of parts) {
    if (p.category === 'decoupler') groups.push([]);
    groups[groups.length - 1].push(p);
  }
  return groups.filter((g) => g.length > 0).reverse(); // bottom first
}

export function analyzeDesign(design: VehicleDesign): DesignAnalysis {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parts: PartDef[] = [];
  try {
    parts = design.parts.map(getPart);
  } catch (e) {
    errors.push(String((e as Error).message));
  }
  if (!parts.length) errors.push('The design is empty.');
  const groups = splitStages(parts);
  const lesMass = parts.filter((p) => p.category === 'les').reduce((s, p) => s + p.mass, 0);
  const hasLes = lesMass > 0;

  const stageMass = groups.map((g) => g.reduce((s, p) => s + p.mass + (p.prop ?? 0), 0));
  const stages: StageInfo[] = groups.map((g, i) => {
    const dryMass = g.reduce((s, p) => s + p.mass, 0);
    const propMass = g.reduce((s, p) => s + (p.prop ?? 0), 0);
    let massAbove = 0;
    for (let k = i + 1; k < groups.length; k++) massAbove += stageMass[k];
    // The escape tower is jettisoned after the first staging.
    const lesHere = groups[groups.length - 1].some((p) => p.category === 'les');
    const isTop = i === groups.length - 1;
    if (i > 0 && !isTop && lesHere) massAbove -= lesMass;
    // The top stage's own dry mass never includes the escape tower; it is counted
    // only while attached (first-stage burn).
    const ownDry = isTop ? dryMass - lesMass : dryMass;
    const ignitionMass = ownDry + propMass + massAbove + (i === 0 && isTop ? lesMass : 0);
    const engines = g.filter((p) => p.engine).map((p) => p.engine!);
    const engine = combineEngines(engines);
    const mf = ignitionMass - propMass;
    const dvVac = engine ? deltaV(engine.ispVac, ignitionMass, mf) : 0;
    const dvAscent = engine ? deltaV((engine.ispVac + engine.ispSl) / 2, ignitionMass, mf) : 0;
    const twrEarth = engine ? engine.thrustSl / (ignitionMass * G0) : 0;
    const twrMoon = engine ? engine.thrustVac / (ignitionMass * LUNAR_G) : 0;
    const burnTime = engine ? (propMass * engine.ispVac * G0) / engine.thrustVac : 0;
    return {
      index: i,
      parts: g,
      dryMass: ownDry,
      propMass,
      massAbove,
      ignitionMass,
      engine,
      engineCount: engines.length,
      dvVac,
      dvAscent,
      twrEarth,
      twrMoon,
      burnTime,
      hasLegs: g.some((p) => p.category === 'legs'),
      hasCapsule: g.some((p) => p.category === 'capsule'),
      maxDiameter: Math.max(0, ...g.map((p) => (p.category === 'legs' ? 0 : p.diameter))),
      // Engines hang side by side in a cluster: count the longest once.
      length:
        g.reduce((s, p) => s + (p.category === 'legs' || p.category === 'engine' ? 0 : p.length), 0) +
        Math.max(0, ...g.filter((p) => p.category === 'engine').map((p) => p.length)),
    };
  });

  const totalMass = stageMass.reduce((s, m) => s + m, 0);
  const liftoffTwr = stages[0]?.twrEarth ?? 0;
  const capsules = parts.filter((p) => p.category === 'capsule');
  const crew = capsules.reduce((s, p) => s + (p.crew ?? 0), 0);

  // ---- Validation ----
  if (parts.length) {
    const top = stages[stages.length - 1];
    if (capsules.length === 0) errors.push('No crew capsule.');
    else if (capsules.length > 1) errors.push('Only one crew capsule is allowed.');
    else if (!top.hasCapsule) errors.push('The crew capsule must be in the top stage (above every decoupler).');
    if (top && !top.parts.some((p) => p.category === 'shield')) errors.push('The capsule stage needs a heat shield for reentry.');
    const chutes = top?.parts.find((p) => p.category === 'chutes');
    if (!chutes) errors.push('The capsule stage needs a parachute system.');
    else {
      const landingMass = top.dryMass + top.propMass;
      if (landingMass > chutes.chutes!.maxMass)
        errors.push(`Parachutes are rated for ${chutes.chutes!.maxMass.toLocaleString('en-US')} kg but the capsule stage is ${Math.round(landingMass).toLocaleString('en-US')} kg.`);
    }
    if (parts[0] && parts[0].category === 'decoupler') errors.push('A decoupler cannot be the topmost part.');
    if (parts[parts.length - 1]?.category === 'decoupler') errors.push('A decoupler cannot be the bottom part.');
    const lesIdx = parts.findIndex((p) => p.category === 'les');
    if (lesIdx > 0) errors.push('The launch escape tower must be the topmost part.');
    for (const s of stages) {
      const label = `Stage ${s.index + 1}`;
      if (s.engine && s.propMass === 0) errors.push(`${label} has engines but no propellant tanks.`);
      if (!s.engine && s.propMass > 0) errors.push(`${label} has tanks but no engine.`);
    }
    if (stages.length && !stages[0].engine) errors.push('The first stage has no engines.');
    else if (liftoffTwr < 1.0) errors.push(`Liftoff thrust-to-weight is ${liftoffTwr.toFixed(2)}: the vehicle cannot leave the pad.`);
    else if (liftoffTwr < 1.15) warnings.push(`Liftoff TWR ${liftoffTwr.toFixed(2)} is low: expect heavy gravity losses.`);
    else if (liftoffTwr > 2.2) warnings.push(`Liftoff TWR ${liftoffTwr.toFixed(2)} is very high: high max-Q and g-loads.`);
    if (!stages.some((s) => s.hasLegs)) warnings.push('No landing legs: the vehicle cannot land on the Moon.');
    if (!hasLes) warnings.push('No launch escape tower: crew safety score reduced.');
  }

  return {
    stages,
    totalMass,
    totalLength: stages.reduce((s, st) => s + st.length, 0),
    liftoffTwr,
    crew,
    hasLes,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Mission budget

export interface MissionLeg {
  id: string;
  label: string;
  /** Required delta-v including typical losses, m/s. */
  dv: number;
  /** The stage active at the end of this leg must carry landing legs and is left on the Moon. */
  landing?: boolean;
}

/** Nominal mission delta-v budget (losses included for launch and landing). */
export const MISSION_LEGS: MissionLeg[] = [
  { id: 'ascent', label: 'Launch to parking orbit', dv: 9_100 },
  { id: 'tli', label: 'Trans-lunar injection', dv: 3_150 },
  { id: 'mcc', label: 'Mid-course correction', dv: 60 },
  { id: 'loi', label: 'Lunar orbit insertion', dv: 870 },
  { id: 'descent', label: 'Powered descent + hover', dv: 2_050, landing: true },
  { id: 'lunar-ascent', label: 'Lunar ascent', dv: 1_870 },
  { id: 'tei', label: 'Trans-Earth injection', dv: 1_000 },
  { id: 'return-mcc', label: 'Return correction', dv: 40 },
];

export interface LegAllocation {
  leg: MissionLeg;
  /** Stage indices used for this leg. */
  stages: number[];
  ok: boolean;
}

export interface BudgetAllocation {
  legs: LegAllocation[];
  feasible: boolean;
  /** Delta-v left over after the final leg (in stages still attached), m/s. */
  margin: number;
  /** Margin as a fraction of the post-landing requirement. */
  marginFraction: number;
  /** Stage left on the Moon, or -1. */
  landingStage: number;
  /** Total delta-v the vehicle can deliver (sum of stage delta-v), m/s. */
  totalDv: number;
  issues: string[];
}

/**
 * Walk the mission legs, consuming each stage's delta-v in firing order.
 * Delta-v within one stage is additive for sequential burns, so this is exact
 * for a vehicle that keeps every upper stage attached until its own stage fires.
 */
export function allocateBudget(a: DesignAnalysis, legs: MissionLeg[] = MISSION_LEGS): BudgetAllocation {
  const stages = a.stages;
  const remaining = stages.map((s, i) => (i === 0 ? s.dvAscent : s.dvVac));
  const issues: string[] = [];
  const out: LegAllocation[] = [];
  let i = 0;
  let landingStage = -1;
  let feasible = stages.length > 0;
  for (const leg of legs) {
    let need = leg.dv;
    const used: number[] = [];
    // After landing, the landed stage stays behind with whatever it has left.
    if (landingStage >= 0 && i <= landingStage) i = landingStage + 1;
    while (need > 1e-6 && i < stages.length) {
      if (remaining[i] <= 1e-6) {
        i++;
        if (leg.landing) continue;
        continue;
      }
      const take = Math.min(remaining[i], need);
      remaining[i] -= take;
      need -= take;
      used.push(i);
      if (need > 1e-6) i++;
    }
    const ok = need <= 1e-6;
    if (leg.landing && ok) {
      const ls = used[used.length - 1];
      landingStage = ls;
      if (!stages[ls].hasLegs) {
        issues.push(`Stage ${ls + 1} performs the landing but has no landing legs.`);
        feasible = false;
      }
      if (stages[ls].engine && stages[ls].engine!.minThrottle > 0.5) {
        issues.push(`Stage ${ls + 1} lands with a fixed-thrust engine: it cannot hover or throttle down.`);
      }
      if (stages[ls].twrMoon < 1.4) issues.push(`Stage ${ls + 1} lunar TWR ${stages[ls].twrMoon.toFixed(2)} is too low for a controlled landing (need > 1.4).`);
    }
    if (leg.id === 'lunar-ascent' && ok) {
      const s0 = used[0];
      if (s0 !== undefined && stages[s0].twrMoon < 1.2) issues.push(`Stage ${s0 + 1} cannot lift off the Moon (lunar TWR ${stages[s0].twrMoon.toFixed(2)}).`);
    }
    if (!ok) {
      feasible = false;
      issues.push(`Not enough delta-v for ${leg.label.toLowerCase()} (short by ${Math.round(need)} m/s).`);
    }
    out.push({ leg, stages: used, ok });
  }
  const margin = remaining.reduce((s, r, k) => (k >= i && k !== landingStage ? s + r : s), 0);
  const postLanding = legs.slice(legs.findIndex((l) => l.landing) + 1).reduce((s, l) => s + l.dv, 0) || 1;
  if (a.errors.length) feasible = false;
  return {
    legs: out,
    feasible: feasible && !issues.some((s) => s.includes('cannot')),
    margin,
    marginFraction: margin / postLanding,
    landingStage,
    totalDv: stages.reduce((s, st, k) => s + (k === 0 ? st.dvAscent : st.dvVac), 0),
    issues,
  };
}

// ---------------------------------------------------------------------------
// Templates

const rep = (id: string, n: number): string[] => Array<string>(n).fill(id);

export const TEMPLATES: VehicleDesign[] = [
  {
    // Direct-return (no lunar-orbit rendezvous) needs a Nova-class booster, which
    // is exactly why Apollo chose LOR. Five stages plus the capsule.
    name: 'Nova-class (recommended)',
    parts: [
      'les', 'chutes-3', 'capsule-3', 'shield-39',
      'dec-s', 'tank-s2', 'eng-sps',
      'dec-s', 'tank-m1', 'tank-s2', ...rep('eng-dps', 4), 'legs',
      'dec-m', 'tank-m2', 'tank-m1', 'eng-j2',
      'dec-l', 'tank-l1', 'tank-l1', ...rep('eng-j2', 8),
      'dec-l', 'tank-l2', 'tank-l2', 'tank-l2', 'tank-l1', ...rep('eng-f1', 9),
    ],
  },
  {
    name: 'Methalox light (2 crew)',
    parts: [
      'chutes-2', 'capsule-2', 'shield-30',
      'dec-s', 'tank-s1', 'tank-s1', 'eng-sps',
      'dec-s', 'tank-s2', 'tank-s2', ...rep('eng-dps', 3), 'legs',
      'dec-m', 'tank-m2', 'eng-j2',
      'dec-l', 'tank-l2', ...rep('eng-meth', 3),
      'dec-l', 'tank-l2', 'tank-l2', ...rep('eng-meth', 21),
    ],
  },
  { name: 'Empty', parts: [] },
];

export const DEFAULT_DESIGN: VehicleDesign = TEMPLATES[0];

// ---------------------------------------------------------------------------
// Runtime state (flight)

export interface VehicleStageState {
  /** Remaining propellant, kg. */
  prop: number;
}

/** Plain, serializable flight state of the vehicle. */
export interface VehicleState {
  design: VehicleDesign;
  /** Index of the lowest attached stage (0 at liftoff). */
  stage: number;
  stages: VehicleStageState[];
  lesAttached: boolean;
  chutes: 'stowed' | 'drogue' | 'main' | 'cut';
  /** Accumulated heat-shield load, J/m^2. */
  heatLoad: number;
}

export function createVehicleState(design: VehicleDesign): VehicleState {
  const a = analyzeDesign(design);
  return {
    design,
    stage: 0,
    stages: a.stages.map((s) => ({ prop: s.propMass })),
    lesAttached: a.hasLes,
    chutes: 'stowed',
    heatLoad: 0,
  };
}

/** Derived (non-serialized) helper around a VehicleState. */
export class Vehicle {
  readonly analysis: DesignAnalysis;

  constructor(public state: VehicleState) {
    this.analysis = analyzeDesign(state.design);
  }

  get stageInfo(): StageInfo | undefined {
    return this.analysis.stages[this.state.stage];
  }

  get stageCount(): number {
    return this.analysis.stages.length;
  }

  get isLastStage(): boolean {
    return this.state.stage >= this.analysis.stages.length - 1;
  }

  /** Current total mass, kg. */
  get mass(): number {
    let m = 0;
    const st = this.analysis.stages;
    for (let i = this.state.stage; i < st.length; i++) m += st[i].dryMass + this.state.stages[i].prop;
    if (this.state.lesAttached) m += this.lesMass;
    return m;
  }

  get lesMass(): number {
    return this.analysis.stages.flatMap((s) => s.parts).filter((p) => p.category === 'les').reduce((s, p) => s + p.mass, 0);
  }

  /** Engine of the current stage, if any and if it has propellant. */
  get engine(): EngineSpec | null {
    const s = this.stageInfo;
    if (!s?.engine) return null;
    return this.state.stages[this.state.stage].prop > 0 ? s.engine : null;
  }

  get prop(): number {
    return this.state.stages[this.state.stage]?.prop ?? 0;
  }

  /** Delta-v remaining in the current stage (vacuum), m/s. */
  get stageDv(): number {
    const e = this.stageInfo?.engine;
    if (!e) return 0;
    return deltaV(e.ispVac, this.mass, this.mass - this.prop);
  }

  /** Delta-v remaining in all attached stages (vacuum, sequential), m/s. */
  get totalDv(): number {
    let dv = 0;
    let above = this.state.lesAttached ? this.lesMass : 0;
    const st = this.analysis.stages;
    for (let i = st.length - 1; i >= this.state.stage; i--) {
      const s = st[i];
      const prop = this.state.stages[i].prop;
      const m0 = above + s.dryMass + prop;
      if (s.engine) dv += deltaV(s.engine.ispVac, m0, m0 - prop);
      above = m0;
    }
    return dv;
  }

  /** Actual throttle given engine limits (0 = off). */
  effectiveThrottle(cmd: number): number {
    const e = this.engine;
    if (!e || cmd <= 0.001) return 0;
    return Math.min(1, Math.max(e.minThrottle, cmd));
  }

  /** Burn propellant from the current stage; returns kg actually burned. */
  consume(kg: number): number {
    const s = this.state.stages[this.state.stage];
    if (!s) return 0;
    const used = Math.min(s.prop, Math.max(0, kg));
    s.prop -= used;
    return used;
  }

  /** Separate the current (lowest) stage. Returns false if nothing to separate. */
  separate(): boolean {
    if (this.isLastStage) return false;
    this.state.stage++;
    if (this.state.lesAttached && this.state.stage >= 1) {
      // The LES is jettisoned at the first staging event.
      this.state.lesAttached = false;
    }
    return true;
  }

  jettisonLes(): boolean {
    if (!this.state.lesAttached) return false;
    this.state.lesAttached = false;
    return true;
  }

  get hasLegs(): boolean {
    return this.analysis.stages.slice(this.state.stage).some((s) => s.hasLegs);
  }

  get legs(): PartDef['legs'] | null {
    for (let i = this.state.stage; i < this.analysis.stages.length; i++) {
      const p = this.analysis.stages[i].parts.find((x) => x.legs);
      if (p) return p.legs!;
    }
    return null;
  }

  get heatShield(): PartDef['heatShield'] | null {
    const top = this.analysis.stages[this.analysis.stages.length - 1];
    return top?.parts.find((p) => p.heatShield)?.heatShield ?? null;
  }

  get chutes(): PartDef['chutes'] | null {
    const top = this.analysis.stages[this.analysis.stages.length - 1];
    return top?.parts.find((p) => p.chutes)?.chutes ?? null;
  }

  /** Largest diameter among attached stages, m. */
  get diameter(): number {
    return Math.max(...this.analysis.stages.slice(this.state.stage).map((s) => s.maxDiameter), 1);
  }

  /** Aerodynamic drag area Cd*A, m^2, for the current configuration. */
  get cdA(): number {
    const d = this.diameter;
    const area = (Math.PI / 4) * d * d;
    if (this.isLastStage) {
      // Blunt capsule, heat shield forward. Parachutes add their own area.
      const base = 1.3 * area;
      if (this.state.chutes === 'drogue') return base + (this.chutes?.drogueCdA ?? 0);
      if (this.state.chutes === 'main') return base + (this.chutes?.mainCdA ?? 0);
      return base;
    }
    return 0.5 * area; // slender stack
  }

  get liftToDrag(): number {
    return this.isLastStage && this.state.chutes === 'stowed' ? 0.3 : 0;
  }

  /** Effective nose radius for heating (blunt capsule ~1.2 x diameter). */
  get noseRadius(): number {
    return this.isLastStage ? 1.2 * this.diameter : 0.5 * this.diameter;
  }
}
