// Mission/campaign state machine. Holds the state carried between phases and
// snapshots it at each phase start so a failed phase can be retried.

import type { PhaseResult } from './scoring';

export const PHASE_IDS = ['design', 'launch', 'orbit', 'cruise', 'landing', 'return'] as const;
export type PhaseId = (typeof PHASE_IDS)[number];

export interface PhaseInfo {
  id: PhaseId;
  index: number;
  title: string;
  short: string;
  description: string;
}

export const PHASES: Record<PhaseId, PhaseInfo> = {
  design: {
    id: 'design',
    index: 1,
    title: 'Vehicle Design',
    short: 'Design',
    description: 'Assemble a launch vehicle and crew spacecraft from parts. Balance mass, thrust and delta-v against the mission budget.',
  },
  launch: {
    id: 'launch',
    index: 2,
    title: 'Launch & Ascent',
    short: 'Launch',
    description: 'Fly the ascent: gravity turn, max-Q, staging, and insertion into a low parking orbit.',
  },
  orbit: {
    id: 'orbit',
    index: 3,
    title: 'Earth Orbit & TLI',
    short: 'Orbit',
    description: 'Circularize, then plan and execute the trans-lunar injection burn with the maneuver node tool.',
  },
  cruise: {
    id: 'cruise',
    index: 4,
    title: 'Translunar Cruise',
    short: 'Cruise',
    description: 'Coast to the Moon under time warp. Trim the approach with a mid-course correction.',
  },
  landing: {
    id: 'landing',
    index: 5,
    title: 'Lunar Orbit & Landing',
    short: 'Landing',
    description: 'Brake into lunar orbit, then fly the powered descent by hand to a safe touchdown.',
  },
  return: {
    id: 'return',
    index: 6,
    title: 'Return & Splashdown',
    short: 'Return',
    description: 'Lift off, burn for Earth, hit the reentry corridor, and ride the parachutes to splashdown.',
  },
};

export type MissionMode = 'campaign' | 'freeplay';

/**
 * State carried between phases. Fields are JSON-serializable (no class
 * instances) so the mission can be snapshotted, saved and replayed.
 */
export interface MissionCarry {
  /** Mission elapsed time at the start of the next phase, s. */
  t: number;
  /** Arbitrary per-system payloads filled by phases (vehicle design, flight state...). */
  [key: string]: unknown;
}

export class Mission {
  results: PhaseResult[] = [];
  private startSnapshot: MissionCarry;

  constructor(
    readonly mode: MissionMode,
    public phase: PhaseId,
    public carry: MissionCarry = { t: 0 },
  ) {
    this.startSnapshot = structuredClone(carry);
  }

  get info(): PhaseInfo {
    return PHASES[this.phase];
  }

  /** The phase after the current one, or null at the end. */
  nextPhase(): PhaseId | null {
    const i = PHASE_IDS.indexOf(this.phase);
    return i >= 0 && i < PHASE_IDS.length - 1 ? PHASE_IDS[i + 1] : null;
  }

  /** Record a phase result. */
  complete(result: PhaseResult): void {
    this.results = this.results.filter((r) => r.phase !== result.phase);
    this.results.push(result);
  }

  /** Move on to the next phase (campaign only). Returns the new phase or null if finished. */
  advance(): PhaseId | null {
    if (this.mode !== 'campaign') return null;
    const n = this.nextPhase();
    if (!n) return null;
    this.phase = n;
    this.startSnapshot = structuredClone(this.carry);
    return n;
  }

  /** Restore the carried state to how it was when the current phase began. */
  retry(): void {
    this.carry = structuredClone(this.startSnapshot);
  }

  get totalScore(): number {
    return this.results.reduce((s, r) => s + r.score, 0);
  }

  get finished(): boolean {
    return this.phase === 'return' && this.results.some((r) => r.phase === 'return' && r.success);
  }
}
