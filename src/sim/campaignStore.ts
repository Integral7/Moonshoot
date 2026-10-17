// Campaign save slot (one), guarded localStorage. Saved at the start of each
// campaign phase so "Continue campaign" resumes exactly where the player was.

import { Mission, PHASE_IDS, type MissionSave } from './mission';

const KEY = 'moonshot.campaign.v1';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function store(): KeyValueStore | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function saveCampaign(m: Mission, s: KeyValueStore | null = store()): boolean {
  if (m.mode !== 'campaign' || !s) return false;
  try {
    s.setItem(KEY, JSON.stringify(m.toSave()));
    return true;
  } catch {
    return false;
  }
}

export function loadCampaign(s: KeyValueStore | null = store()): Mission | null {
  if (!s) return null;
  try {
    const raw = s.getItem(KEY);
    if (!raw) return null;
    const save = JSON.parse(raw) as MissionSave;
    if (save.version !== 1 || save.mode !== 'campaign' || !PHASE_IDS.includes(save.phase)) return null;
    return Mission.fromSave(save);
  } catch {
    return null;
  }
}

export function clearCampaign(s: KeyValueStore | null = store()): void {
  try {
    if (s?.removeItem) s.removeItem(KEY);
    else s?.setItem(KEY, '');
  } catch {
    /* ignore */
  }
}
