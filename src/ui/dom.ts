// Tiny DOM helpers for building UI without a framework.

type Child = Node | string | number | null | undefined | false;
type Props = {
  class?: string;
  id?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  title?: string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
  onclick?: (ev: MouseEvent) => void;
  oninput?: (ev: Event) => void;
  onchange?: (ev: Event) => void;
  text?: string;
  html?: string;
  disabled?: boolean;
  type?: string;
  value?: string;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.id) el.id = props.id;
  if (props.title) el.title = props.title;
  if (typeof props.style === 'string') el.setAttribute('style', props.style);
  else if (props.style) Object.assign(el.style, props.style);
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) el.dataset[k] = v;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) el.setAttribute(k, v);
  if (props.onclick) el.addEventListener('click', props.onclick as EventListener);
  if (props.oninput) el.addEventListener('input', props.oninput);
  if (props.onchange) el.addEventListener('change', props.onchange);
  if (props.text !== undefined) el.textContent = props.text;
  if (props.html !== undefined) el.innerHTML = props.html;
  if (props.disabled !== undefined) (el as HTMLButtonElement).disabled = props.disabled;
  if (props.type !== undefined) (el as HTMLInputElement).type = props.type;
  if (props.value !== undefined) (el as HTMLInputElement).value = props.value;
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}
