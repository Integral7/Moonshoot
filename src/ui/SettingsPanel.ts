import type { App } from '../app/App';
import type { QualityLevel } from '../render/quality';
import { h } from './dom';

/** Settings dialog: graphics quality and callout preferences. */
export function createSettingsPanel(app: App, onClose: () => void): HTMLElement {
  const levels: { id: QualityLevel; label: string; hint: string }[] = [
    { id: 'low', label: 'Low', hint: 'Integrated GPUs. No bloom or clouds, low-res planets.' },
    { id: 'medium', label: 'Medium', hint: 'Balanced. Bloom, clouds, medium resolution.' },
    { id: 'high', label: 'High', hint: 'Dedicated GPUs. Full resolution, shadows, dense stars.' },
  ];
  const hint = h('p', { class: 'muted small' });
  const buttons = levels.map((l) =>
    h('button', {
      class: 'seg',
      dataset: { quality: l.id },
      text: l.label,
      onclick: () => {
        app.setQuality(l.id);
        sync();
      },
    }),
  );
  const callouts = h('input', { type: 'checkbox' }) as HTMLInputElement;
  callouts.checked = app.settings.callouts;
  callouts.addEventListener('change', () => app.updateSettings({ callouts: callouts.checked }));

  function sync() {
    for (const b of buttons) b.classList.toggle('active', b.dataset.quality === app.settings.quality);
    hint.textContent = levels.find((l) => l.id === app.settings.quality)!.hint;
  }
  sync();

  return h(
    'div',
    { class: 'modal-backdrop', onclick: (e) => e.target === e.currentTarget && onClose() },
    h(
      'div',
      { class: 'panel modal', id: 'settings-panel' },
      h('h2', { text: 'Settings' }),
      h('label', { class: 'field-label', text: 'Graphics quality' }),
      h('div', { class: 'segmented' }, ...buttons),
      hint,
      h('label', { class: 'check' }, callouts, ' Flight director callout pop-ups'),
      h('div', { class: 'row end' }, h('button', { class: 'btn', text: 'Close', onclick: onClose })),
    ),
  );
}
