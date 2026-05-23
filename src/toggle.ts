/**
 * The bar above every overridden surface: flips Pierre / GitHub, and (on diff
 * surfaces) Unified / Split. Borrows GitHub's Primer CSS variables so it
 * follows the theme.
 */
import type { DiffStyle } from './protocol';

export interface ToggleBar {
  readonly el: HTMLElement;
  setState(on: boolean): void;
}

export interface DiffStyleConfig {
  initial: DiffStyle;
  onChange: (next: DiffStyle) => void;
}

// The diffshub "+/-" mark, in currentColor so it tracks the theme.
const MARK =
  '<svg viewBox="0 0 32 32" width="13" height="13" fill="currentColor" aria-hidden="true" style="display:block">' +
  '<path d="m17.5 8.592c0-.828-.672-1.5-1.5-1.5s-1.5.672-1.5 1.5v3.908h-4c-.828 0-1.5.672-1.5 1.5s.672 1.5 1.5 1.5h4v3h3v-3h4c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5h-4z"/>' +
  '<path d="m10.5 20c-.828 0-1.5.672-1.5 1.5s.672 1.5 1.5 1.5h11c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5z"/></svg>';

export function createToggleBar(
  initial: boolean,
  onToggle: (on: boolean) => void,
  diffStyle?: DiffStyleConfig,
): ToggleBar {
  const bar = document.createElement('div');
  bar.style.cssText =
    'flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px;' +
    'font:600 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'border-bottom:1px solid var(--borderColor-default,#d1d9e0);' +
    'background:var(--bgColor-muted,#f6f8fa);color:var(--fgColor-default,#1f2328)';
  bar.innerHTML =
    `<span style="display:flex;color:var(--fgColor-muted,#59636e)">${MARK}</span>` +
    '<span>Pierre</span><span style="flex:1"></span>';

  if (diffStyle) bar.append(diffStyleSegment(diffStyle));

  const pierreBtn = segButton('Pierre');
  const ghBtn = segButton('GitHub');
  bar.append(segmented([pierreBtn, ghBtn]));

  let on = initial;
  const paint = () => {
    paintSegment(pierreBtn, on);
    paintSegment(ghBtn, !on);
  };
  const set = (next: boolean, fire: boolean) => {
    on = next;
    paint();
    if (fire) onToggle(next);
  };
  pierreBtn.addEventListener('click', () => { if (!on) set(true, true); });
  ghBtn.addEventListener('click', () => { if (on) set(false, true); });
  paint();

  return { el: bar, setState: (next) => set(next, false) };
}

function diffStyleSegment(config: DiffStyleConfig): HTMLElement {
  const unifiedBtn = segButton('Unified');
  const splitBtn = segButton('Split');
  let style = config.initial;
  const paint = () => {
    paintSegment(unifiedBtn, style === 'unified');
    paintSegment(splitBtn, style === 'split');
  };
  const set = (next: DiffStyle) => {
    if (next === style) return;
    style = next;
    paint();
    config.onChange(next);
  };
  unifiedBtn.addEventListener('click', () => set('unified'));
  splitBtn.addEventListener('click', () => set('split'));
  paint();
  return segmented([unifiedBtn, splitBtn]);
}

function segButton(text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.style.cssText = 'border:0;padding:3px 10px;font:inherit;cursor:pointer';
  return b;
}

function segmented(buttons: HTMLButtonElement[]): HTMLElement {
  const seg = document.createElement('div');
  seg.style.cssText =
    'display:flex;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;overflow:hidden';
  seg.append(...buttons);
  return seg;
}

function paintSegment(button: HTMLButtonElement, active: boolean): void {
  button.style.background = active ? 'var(--bgColor-accent-emphasis,#0969da)' : 'transparent';
  button.style.color = active ? '#fff' : 'var(--fgColor-muted,#59636e)';
}
