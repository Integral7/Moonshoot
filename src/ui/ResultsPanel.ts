import type { PhaseResult } from '../sim/scoring';
import { formatMET } from '../sim/time';
import { h } from './dom';

export interface ResultAction {
  id: string;
  label: string;
  primary?: boolean;
  onClick: () => void;
}

/** Post-phase debrief: score, metric breakdown, failure analysis, next actions. */
export function createResultsPanel(result: PhaseResult, title: string, actions: ResultAction[], extra?: HTMLElement): HTMLElement {
  const ok = result.success;
  const metrics = h(
    'div',
    { class: 'metrics' },
    ...result.metrics.map((m) =>
      h(
        'div',
        { class: 'metric' },
        h('div', { class: 'metric-head' }, h('span', { text: m.label }), h('span', { class: 'mono', text: m.value })),
        h('div', { class: 'bar' }, h('div', { class: `bar-fill ${m.score > 0.75 ? 'good' : m.score > 0.4 ? 'warn' : 'bad'}`, style: { width: `${Math.round(m.score * 100)}%` } })),
        m.target ? h('div', { class: 'muted small', text: m.target }) : null,
      ),
    ),
  );
  const findings = result.findings.length
    ? h(
        'div',
        { class: 'findings' },
        h('h3', { text: ok ? 'Debrief notes' : 'Failure analysis' }),
        h('ul', {}, ...result.findings.map((f) => h('li', { text: f }))),
      )
    : null;
  return h(
    'div',
    { class: 'modal-backdrop results-backdrop' },
    h(
      'div',
      { class: 'panel modal results', id: 'results-panel', dataset: { success: String(ok) } },
      h('div', { class: `results-banner ${ok ? 'good' : 'bad'}`, text: ok ? 'PHASE COMPLETE' : 'MISSION FAILURE' }),
      h('h2', { text: title }),
      h(
        'div',
        { class: 'score-row' },
        h('div', { class: 'score mono', id: 'result-score', text: String(result.score) }),
        h('div', {}, h('div', { class: `rating rating-${result.rating}`, text: result.rating.toUpperCase() }), h('div', { class: 'muted small', text: formatMET(result.t) })),
      ),
      h('p', { class: 'summary', text: result.summary }),
      metrics,
      findings,
      extra ?? null,
      h(
        'div',
        { class: 'row end results-actions' },
        ...actions.map((a) => h('button', { class: `btn ${a.primary ? 'btn-primary' : ''}`, id: `result-${a.id}`, text: a.label, onclick: a.onClick })),
      ),
    ),
  );
}
