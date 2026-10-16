// Phase scoring and failure analysis.

export type Rating = 'excellent' | 'good' | 'fair' | 'poor' | 'fail';

export interface Metric {
  label: string;
  /** Formatted value for display. */
  value: string;
  /** 0..1 */
  score: number;
  weight: number;
  /** Optional explanation of the target. */
  target?: string;
}

export interface PhaseResult {
  phase: string;
  success: boolean;
  /** 0..1000 */
  score: number;
  rating: Rating;
  metrics: Metric[];
  /** Failure analysis: what went wrong and why (empty on a clean success). */
  findings: string[];
  /** Mission time at end of phase. */
  t: number;
  summary: string;
}

/**
 * Linear score: 1 at or better than `best`, 0 at or worse than `worst`.
 * Works for both "lower is better" (best < worst) and "higher is better".
 */
export function linearScore(value: number, best: number, worst: number): number {
  if (!Number.isFinite(value)) return 0;
  const f = (value - worst) / (best - worst);
  return Math.min(1, Math.max(0, f));
}

/** Score 1 within +/- tol of target, falling to 0 at +/- zeroAt. */
export function toleranceScore(value: number, target: number, tol: number, zeroAt: number): number {
  const err = Math.abs(value - target);
  if (err <= tol) return 1;
  return linearScore(err, tol, zeroAt);
}

export function rate(score: number, success: boolean): Rating {
  if (!success) return 'fail';
  if (score >= 900) return 'excellent';
  if (score >= 750) return 'good';
  if (score >= 500) return 'fair';
  return 'poor';
}

/** Combine weighted metrics into a phase result. A failure caps the score at 300. */
export function buildResult(
  phase: string,
  t: number,
  success: boolean,
  metrics: Metric[],
  findings: string[],
  summary: string,
): PhaseResult {
  const wsum = metrics.reduce((s, m) => s + m.weight, 0) || 1;
  let score = Math.round((1000 * metrics.reduce((s, m) => s + m.score * m.weight, 0)) / wsum);
  if (!success) score = Math.min(score, 300);
  return { phase, success, score, rating: rate(score, success), metrics, findings, t, summary };
}
