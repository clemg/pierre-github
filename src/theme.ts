// GitHub's resolved light/dark mode. `data-color-mode` is "auto" for logged-out
// users (and never changes from there), so we fall back to OS preference.
import type { ThemeMode } from './protocol';

export function currentTheme(): ThemeMode {
  const mode = document.documentElement.getAttribute('data-color-mode');
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function watchTheme(onChange: (theme: ThemeMode) => void): void {
  let last = currentTheme();
  const check = () => {
    const next = currentTheme();
    if (next !== last) {
      last = next;
      onChange(next);
    }
  };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', check);
  new MutationObserver(check).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-color-mode'],
  });
}
