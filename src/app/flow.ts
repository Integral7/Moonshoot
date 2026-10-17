// Shared navigation after a phase ends: continue / retry / menu, plus campaign
// saving and the end-of-mission summary.

import type { App } from './App';
import { createPhaseScreen, phaseAvailable } from './phases';
import { PHASES, type Mission } from '../sim/mission';
import type { PhaseResult } from '../sim/scoring';
import { clearCampaign, saveCampaign } from '../sim/campaignStore';
import type { ResultAction } from '../ui/ResultsPanel';
import { MissionSummaryScreen } from '../screens/MissionSummaryScreen';

/** Open the screen for the mission's current phase (saving campaign progress first). */
export function goToPhase(app: App, mission: Mission): void {
  if (mission.mode === 'campaign') saveCampaign(mission);
  const s = createPhaseScreen(mission);
  if (s) app.go(s);
  else app.go('menu');
}

export function phaseEndActions(app: App, mission: Mission, result: PhaseResult, retry: () => void): ResultAction[] {
  const actions: ResultAction[] = [];
  const next = mission.nextPhase();
  if (result.success && mission.mode === 'campaign' && next) {
    const ok = phaseAvailable(next);
    actions.push({
      id: 'continue',
      label: ok ? `Continue: ${PHASES[next].title}` : `${PHASES[next].title} (coming soon)`,
      primary: ok,
      onClick: () => {
        if (!ok) return;
        mission.advance();
        goToPhase(app, mission);
      },
    });
  }
  if (result.success && mission.mode === 'campaign' && !next) {
    actions.push({
      id: 'summary',
      label: 'Mission summary',
      primary: true,
      onClick: () => {
        clearCampaign();
        app.go(new MissionSummaryScreen(mission));
      },
    });
  }
  actions.push({ id: 'retry', label: 'Retry phase', primary: !result.success, onClick: retry });
  actions.push({ id: 'menu', label: 'Main menu', onClick: () => app.go('menu') });
  return actions;
}
