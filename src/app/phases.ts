// Registry mapping mission phases to the screens that fly them. Lives in its own
// module so screens can navigate to the next phase without import cycles.

import type { Mission, PhaseId } from '../sim/mission';
import type { Screen } from './Screen';

export type PhaseScreenFactory = (mission: Mission) => Screen;

const registry = new Map<PhaseId, PhaseScreenFactory>();

export function registerPhase(id: PhaseId, factory: PhaseScreenFactory): void {
  registry.set(id, factory);
}

export function phaseAvailable(id: PhaseId): boolean {
  return registry.has(id);
}

export function createPhaseScreen(mission: Mission): Screen | null {
  return registry.get(mission.phase)?.(mission) ?? null;
}
