// Parts catalog. Figures are rounded, Saturn/Apollo-class values (masses in kg,
// thrust in N, Isp in s, dimensions in m).

export type PartCategory = 'capsule' | 'shield' | 'chutes' | 'les' | 'tank' | 'engine' | 'decoupler' | 'legs';

export interface EngineSpec {
  thrustVac: number;
  thrustSl: number;
  ispVac: number;
  ispSl: number;
  /** Lowest throttle setting while running (1 = fixed thrust). */
  minThrottle: number;
}

export interface PartDef {
  id: string;
  name: string;
  category: PartCategory;
  /** Dry mass, kg. */
  mass: number;
  diameter: number;
  length: number;
  description: string;
  /** Propellant capacity, kg (tanks). */
  prop?: number;
  engine?: EngineSpec;
  crew?: number;
  heatShield?: {
    /** Peak stagnation heat flux tolerated, W/m^2. */
    maxFlux: number;
    /** Integrated heat load tolerated, J/m^2. */
    maxLoad: number;
  };
  chutes?: {
    /** Maximum suspended mass for a safe splashdown, kg. */
    maxMass: number;
    /** Drogue and main drag areas (Cd*A), m^2. */
    drogueCdA: number;
    mainCdA: number;
  };
  legs?: {
    maxVertical: number;
    maxHorizontal: number;
    /** Max tilt at touchdown, rad. */
    maxTilt: number;
  };
  /** Paint scheme hint for the 3D model. */
  paint?: 'white' | 'roll' | 'metal' | 'gold' | 'dark';
}

const kN = 1000;
const DEG = Math.PI / 180;

export const PARTS: PartDef[] = [
  // ---- Crew ----------------------------------------------------------------
  {
    id: 'capsule-3', name: 'Command Capsule (3 crew)', category: 'capsule', mass: 4700, diameter: 3.9, length: 3.4, crew: 3,
    description: 'Apollo-class crew capsule. Lift-to-drag 0.3 for guided reentry.', paint: 'metal',
  },
  {
    id: 'capsule-2', name: 'Light Capsule (2 crew)', category: 'capsule', mass: 3100, diameter: 3.0, length: 2.8, crew: 2,
    description: 'Compact two-seat capsule. Lighter, tighter margins.', paint: 'metal',
  },
  {
    id: 'shield-39', name: 'Ablative Heat Shield 3.9 m', category: 'shield', mass: 850, diameter: 3.9, length: 0.4,
    heatShield: { maxFlux: 5.5e6, maxLoad: 4.5e8 },
    description: 'Avcoat-style ablator rated for lunar-return speeds.', paint: 'dark',
  },
  {
    id: 'shield-30', name: 'Ablative Heat Shield 3.0 m', category: 'shield', mass: 560, diameter: 3.0, length: 0.35,
    heatShield: { maxFlux: 5.0e6, maxLoad: 3.8e8 },
    description: 'Smaller ablator for the light capsule.', paint: 'dark',
  },
  {
    id: 'chutes-3', name: 'Parachute System (3 mains)', category: 'chutes', mass: 250, diameter: 1.6, length: 0.6,
    chutes: { maxMass: 6500, drogueCdA: 2 * 0.6 * 20, mainCdA: 3 * 0.8 * 507 },
    description: 'Two drogues and three 25 m mains. Safe below 6.5 t.', paint: 'white',
  },
  {
    id: 'chutes-2', name: 'Parachute System (2 mains)', category: 'chutes', mass: 170, diameter: 1.3, length: 0.5,
    chutes: { maxMass: 4200, drogueCdA: 2 * 0.6 * 14, mainCdA: 2 * 0.8 * 507 },
    description: 'Two drogues and two mains. Safe below 4.2 t.', paint: 'white',
  },
  {
    id: 'les', name: 'Launch Escape Tower', category: 'les', mass: 4200, diameter: 1.0, length: 10,
    description: 'Solid-rocket abort tower. Jettisoned after first-stage separation. Improves crew-safety score.', paint: 'white',
  },
  // ---- Tanks ---------------------------------------------------------------
  { id: 'tank-s1', name: 'Tank S short (5 t)', category: 'tank', mass: 450, diameter: 3.9, length: 2.4, prop: 5_000, description: '3.9 m hypergolic tank.', paint: 'metal' },
  { id: 'tank-s2', name: 'Tank S long (18 t)', category: 'tank', mass: 1_400, diameter: 3.9, length: 7.0, prop: 18_000, description: '3.9 m hypergolic tank, service-module size.', paint: 'metal' },
  { id: 'tank-m1', name: 'Tank M short (40 t)', category: 'tank', mass: 2_600, diameter: 6.6, length: 6.0, prop: 40_000, description: '6.6 m cryogenic tank.', paint: 'white' },
  { id: 'tank-m2', name: 'Tank M long (110 t)', category: 'tank', mass: 7_000, diameter: 6.6, length: 14.0, prop: 110_000, description: '6.6 m cryogenic tank, third-stage size.', paint: 'white' },
  { id: 'tank-l1', name: 'Tank L short (450 t)', category: 'tank', mass: 30_000, diameter: 10.1, length: 18.0, prop: 450_000, description: '10.1 m tank, second-stage size.', paint: 'white' },
  { id: 'tank-l2', name: 'Tank L long (1000 t)', category: 'tank', mass: 60_000, diameter: 10.1, length: 21.0, prop: 1_000_000, description: '10.1 m kerosene/LOX tank. Two make a first stage.', paint: 'roll' },
  // ---- Engines -------------------------------------------------------------
  {
    id: 'eng-f1', name: 'F-1 class (kerolox)', category: 'engine', mass: 8_400, diameter: 3.7, length: 5.8,
    engine: { thrustVac: 7_770 * kN, thrustSl: 6_770 * kN, ispVac: 304, ispSl: 263, minThrottle: 1 },
    description: 'Huge first-stage engine. Fixed thrust. Five of them lift a Saturn V.', paint: 'dark',
  },
  {
    id: 'eng-j2', name: 'J-2 class (hydrolox)', category: 'engine', mass: 1_600, diameter: 2.0, length: 3.4,
    engine: { thrustVac: 1_033 * kN, thrustSl: 486 * kN, ispVac: 421, ispSl: 200, minThrottle: 0.75 },
    description: 'Efficient upper-stage engine. Poor at sea level.', paint: 'dark',
  },
  {
    id: 'eng-rl10', name: 'RL10 class (hydrolox)', category: 'engine', mass: 300, diameter: 1.2, length: 2.2,
    engine: { thrustVac: 110 * kN, thrustSl: 20 * kN, ispVac: 450, ispSl: 120, minThrottle: 0.3 },
    description: 'Small, very efficient vacuum engine.', paint: 'dark',
  },
  {
    id: 'eng-sps', name: 'Service Propulsion Engine', category: 'engine', mass: 600, diameter: 2.0, length: 3.0,
    engine: { thrustVac: 91 * kN, thrustSl: 30 * kN, ispVac: 314, ispSl: 150, minThrottle: 1 },
    description: 'Hypergolic, restartable, fixed thrust. Ideal for ascent and TEI.', paint: 'dark',
  },
  {
    id: 'eng-dps', name: 'Descent Engine (throttleable)', category: 'engine', mass: 250, diameter: 1.5, length: 1.6,
    engine: { thrustVac: 70 * kN, thrustSl: 25 * kN, ispVac: 311, ispSl: 140, minThrottle: 0.1 },
    description: 'Deep-throttling hypergolic engine for powered descent (10-100%).', paint: 'dark',
  },
  {
    id: 'eng-meth', name: 'Methalox (full-flow)', category: 'engine', mass: 1_600, diameter: 1.3, length: 3.1,
    engine: { thrustVac: 2_300 * kN, thrustSl: 2_050 * kN, ispVac: 350, ispSl: 327, minThrottle: 0.4 },
    description: 'Modern high-pressure engine. Good everywhere, throttleable.', paint: 'dark',
  },
  // ---- Structure -----------------------------------------------------------
  { id: 'dec-s', name: 'Decoupler S', category: 'decoupler', mass: 150, diameter: 3.9, length: 0.5, description: 'Separation ring, 3.9 m. Jettisoned with the stage below.', paint: 'dark' },
  { id: 'dec-m', name: 'Decoupler M', category: 'decoupler', mass: 600, diameter: 6.6, length: 1.0, description: 'Interstage, 6.6 m.', paint: 'dark' },
  { id: 'dec-l', name: 'Decoupler L', category: 'decoupler', mass: 4_000, diameter: 10.1, length: 2.0, description: 'Interstage, 10.1 m.', paint: 'dark' },
  {
    id: 'legs', name: 'Landing Legs (4)', category: 'legs', mass: 350, diameter: 4.5, length: 1.5,
    legs: { maxVertical: 3.0, maxHorizontal: 1.5, maxTilt: 12 * DEG },
    description: 'Crushable-core legs. Touchdown limits: 3 m/s vertical, 1.5 m/s horizontal, 12 deg tilt.', paint: 'gold',
  },
];

export const PART_BY_ID: Record<string, PartDef> = Object.fromEntries(PARTS.map((p) => [p.id, p]));

export function getPart(id: string): PartDef {
  const p = PART_BY_ID[id];
  if (!p) throw new Error(`Unknown part: ${id}`);
  return p;
}

export const CATEGORY_LABELS: Record<PartCategory, string> = {
  capsule: 'Crew capsules',
  shield: 'Heat shields',
  chutes: 'Parachutes',
  les: 'Abort',
  tank: 'Tanks',
  engine: 'Engines',
  decoupler: 'Decouplers',
  legs: 'Landing',
};
