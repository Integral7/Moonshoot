// Flight director / mission control callouts. Pure logic: rules are evaluated
// against a telemetry snapshot each tick, and fire once (or re-arm on a condition).

/** Mission control console positions (Apollo-era call signs). */
export type ControllerRole =
  | 'FLIGHT'
  | 'CAPCOM'
  | 'FIDO'
  | 'GUIDO'
  | 'BOOSTER'
  | 'RETRO'
  | 'EECOM'
  | 'CONTROL'
  | 'SURGEON'
  | 'CDR';

export type CalloutKind = 'info' | 'good' | 'warn' | 'bad';

export interface Callout {
  /** Mission time, s. */
  t: number;
  role: ControllerRole;
  text: string;
  kind: CalloutKind;
}

export interface CalloutRule<T> {
  id: string;
  role: ControllerRole;
  kind?: CalloutKind;
  /** Text, or a function of the snapshot. */
  text: string | ((s: T) => string);
  when: (s: T) => boolean;
  /**
   * If provided, the rule re-arms after firing once this returns true
   * (e.g. a warning that can recur after conditions clear).
   */
  rearm?: (s: T) => boolean;
}

export class CalloutSystem<T> {
  readonly log: Callout[] = [];
  private fired = new Set<string>();
  private listeners: ((c: Callout) => void)[] = [];

  constructor(private rules: CalloutRule<T>[] = []) {}

  addRules(rules: CalloutRule<T>[]): void {
    this.rules.push(...rules);
  }

  onCallout(fn: (c: Callout) => void): void {
    this.listeners.push(fn);
  }

  /** Emit an ad-hoc callout (from game events rather than rules). */
  say(t: number, role: ControllerRole, text: string, kind: CalloutKind = 'info'): Callout {
    const c: Callout = { t, role, text, kind };
    this.log.push(c);
    for (const l of this.listeners) l(c);
    return c;
  }

  /** Emit at most once per id. */
  sayOnce(id: string, t: number, role: ControllerRole, text: string, kind: CalloutKind = 'info'): void {
    if (this.fired.has(id)) return;
    this.fired.add(id);
    this.say(t, role, text, kind);
  }

  hasFired(id: string): boolean {
    return this.fired.has(id);
  }

  /** Evaluate rules against a snapshot at mission time t. */
  evaluate(t: number, snapshot: T): Callout[] {
    const out: Callout[] = [];
    for (const r of this.rules) {
      if (this.fired.has(r.id)) {
        if (r.rearm && r.rearm(snapshot)) this.fired.delete(r.id);
        continue;
      }
      if (r.when(snapshot)) {
        this.fired.add(r.id);
        const text = typeof r.text === 'function' ? r.text(snapshot) : r.text;
        out.push(this.say(t, r.role, text, r.kind ?? 'info'));
      }
    }
    return out;
  }
}
