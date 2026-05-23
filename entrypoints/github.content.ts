/**
 * Orchestrator. Runs in the content-script isolated world: detects the surface,
 * hides GitHub's diff/tree, injects the main-world renderer, feeds it data,
 * and keeps Pierre in place across SPA navs and DOM re-mounts. It never
 * imports Pierre (whose custom elements an isolated world can't host).
 */
import { defineContentScript, browser } from '#imports';
import {
  detectSurface, isDiffSurface, surfaceId, SURFACE_TARGETS, firstMatch,
  type Surface,
} from '../src/surfaces';
import { currentTheme, watchTheme } from '../src/theme';
import { fetchDiff, fetchFileContents, fetchTreePaths, activePath } from '../src/data';
import { embeddedCommits, extractThreads, readViewerLogin } from '../src/comments';
import { createToggleBar, type ToggleBar } from '../src/toggle';
import {
  sendToRenderer, onOrchestratorMessage, readDiffStyle, writeDiffStyle,
  type FileTexts,
} from '../src/protocol';
const ON_CLASS = 'gh-pierre-on';
const WRAP_ID = 'gh-pierre-root';
const HIDDEN_CLASS = 'gh-pierre-hidden';
const STYLE_ID = 'gh-pierre-style';
const SCRIPT_ID = 'gh-pierre-renderer';
const STORAGE_KEY = 'enabled';

const LAYOUT_CSS =
  `#${WRAP_ID}{position:relative;z-index:30;width:100%;min-width:0;box-sizing:border-box;` +
  `display:flex;flex-direction:column;contain:layout}` +
  `html.${ON_CLASS} .${HIDDEN_CLASS}{display:none!important}` +
  `.gh-pierre-mount{width:100%}` +
  `html:not(.${ON_CLASS}) .gh-pierre-mount{display:none}` +
  // Loading placeholder while the .diff fetch is in flight (huge PRs serve a
  // 40 MB+ unified diff). Replaced when the renderer mounts.
  `.gh-pierre-loading{display:flex;align-items:center;gap:10px;padding:24px;` +
  `color:var(--fgColor-muted,#59636e);font:13px system-ui,sans-serif}` +
  `.gh-pierre-loading::before{content:"";width:14px;height:14px;border-radius:50%;` +
  `border:2px solid currentColor;border-top-color:transparent;animation:gh-pierre-spin .8s linear infinite}` +
  `@keyframes gh-pierre-spin{to{transform:rotate(360deg)}}`;

// On diff surfaces, hide everything after the panel + the footer, so the page's
// scroll range ends exactly at Pierre.
const CLIP_CSS = `html.${ON_CLASS} #${WRAP_ID}~*,html.${ON_CLASS} footer{display:none!important}`;

export default defineContentScript({
  matches: ['*://github.com/*'],
  runAt: 'document_start',
  main() {
    new Orchestrator().start();
  },
});

class Orchestrator {
  private enabled = true;
  private current: Surface | null = null;
  private currentId: string | null = null;
  private toggle: ToggleBar | null = null;
  private rendererLoad: Promise<void> | null = null;
  private activating = false;
  private lastPath = location.pathname;
  // Fetched diff/tree data, keyed by surface id — avoids re-fetch on re-mount.
  private cache = new Map<string, { diff?: string; contents?: FileTexts; paths?: string[] }>();

  start(): void {
    this.current = detectSurface(location.pathname);
    this.currentId = this.current ? surfaceId(this.current) : null;
    if (this.current) {
      this.applyStyle(this.current);
      document.documentElement.classList.add(ON_CLASS); // boot() corrects if disabled
    }
    void this.boot();
  }

  private async boot(): Promise<void> {
    this.enabled = await this.readEnabled();
    if (!this.enabled) document.documentElement.classList.remove(ON_CLASS);
    onOrchestratorMessage((msg) => {
      if (msg.kind === 'rendered' && !msg.ok) {
        document.documentElement.classList.remove(ON_CLASS); // graceful fallback
      }
    });
    watchTheme((theme) => sendToRenderer({ kind: 'theme', theme }));
    this.watchNavigation();
    this.watchDom();
    if (this.current) void this.activate(this.current);
  }

  private async activate(surface: Surface): Promise<void> {
    if (this.activating) return;
    this.activating = true;
    try {
      const wrapper = await this.ensureWrapper(surface);
      if (!wrapper || !this.enabled) {
        // Drop the class so GitHub's view re-shows — otherwise the page stays
        // blank from our document_start optimistic hide.
        document.documentElement.classList.remove(ON_CLASS);
        return;
      }
      document.documentElement.classList.add(ON_CLASS);
      if (isDiffSurface(surface)) unstickAbove(wrapper);
      await this.ensureRenderer();

      const id = surfaceId(surface);
      const theme = currentTheme();
      if (isDiffSurface(surface)) {
        const cached = this.cache.get(id);
        let diff = cached?.diff;
        if (diff == null) {
          diff = await fetchDiff(surface);
          this.cache.set(id, { diff, contents: cached?.contents });
        }
        const commits = surface.kind === 'pr' ? embeddedCommits() : null;
        const comments = surface.kind === 'pr' ? extractThreads(readViewerLogin()) : [];
        const contents = this.cache.get(id)?.contents;
        sendToRenderer({
          kind: 'diff', surface, diff, theme, comments, contents: contents ?? {}, commits,
        });
        // Fetch file text in the background; renderer folds it in via
        // addContents so Pierre can offer "expand unchanged" buttons.
        if (contents == null) void this.loadContents(surface, id);
      } else {
        let paths = this.cache.get(id)?.paths;
        if (paths == null) {
          paths = await fetchTreePaths(surface);
          this.cache.set(id, { paths });
        }
        sendToRenderer({ kind: 'tree', surface, paths, activePath: activePath(), theme });
      }
    } catch (err) {
      console.warn('[gh-pierre] could not render, keeping GitHub:', err);
      document.documentElement.classList.remove(ON_CLASS);
    } finally {
      this.activating = false;
    }
  }

  private async loadContents(surface: Surface, id: string): Promise<void> {
    const contents = await fetchFileContents(surface).catch((): FileTexts => ({}));
    const entry = this.cache.get(id);
    if (entry) entry.contents = contents;
    if (this.currentId === id && Object.keys(contents).length > 0) {
      sendToRenderer({ kind: 'contents', contents });
    }
  }

  // Slot `#gh-pierre-root` in where GitHub's diff/tree are. Their branches
  // (direct children of their common container) are marked hidden and Pierre
  // takes their place — so sibling chrome, like the PR review toolbar, stays.
  private async ensureWrapper(surface: Surface): Promise<HTMLElement | null> {
    const existing = document.getElementById(WRAP_ID);
    if (existing?.isConnected) return existing;

    const targets = SURFACE_TARGETS[surface.kind];
    // Wait for our target OR (on a diff surface) a visible placeholder GitHub
    // served instead. The short timeout keeps the user from staring at
    // GitHub's "diff cannot be displayed" page for ten seconds.
    await waitFor(() => {
      if (firstMatch([...targets.diff, ...targets.tree])) return true;
      return isDiffSurface(surface) && findDiffPlaceholder() != null;
    }, 5000);
    const live = document.getElementById(WRAP_ID);
    if (live?.isConnected) return live;

    const found = [firstMatch(targets.diff), firstMatch(targets.tree)].filter(
      (e): e is Element => e != null,
    );
    if (found.length === 0 && isDiffSurface(surface)) {
      const placeholder = findDiffPlaceholder();
      if (placeholder) found.push(placeholder);
    }
    if (found.length === 0) {
      console.warn(`[gh-pierre] no known diff/tree element on this ${surface.kind} page`);
      return null;
    }

    const container =
      found.length === 2 ? commonAncestor(found[0]!, found[1]!) : found[0]!.parentElement;
    if (!container) return null;
    const branches = found.map((el) => childOf(container, el));
    for (const branch of branches) branch.classList.add(HIDDEN_CLASS);

    const wrap = document.createElement('div');
    wrap.id = WRAP_ID;
    // Code surface: the tree replaces a sidebar, so the wrap is sticky 100dvh.
    if (!isDiffSurface(surface)) {
      wrap.style.cssText = 'position:sticky;top:0;height:100dvh';
    }
    // Keep keystrokes typed inside our subtree (Pierre's tree-search,
    // comment composer, …) from reaching GitHub's document-level `hotkey`
    // listener, which would otherwise steal letters (`s` for search, `t` for
    // file finder, …) since the shadow host doesn't look like an input.
    for (const ev of ['keydown', 'keypress', 'keyup'] as const) {
      wrap.addEventListener(ev, (e) => e.stopPropagation());
    }
    const diffStyleConfig = isDiffSurface(surface)
      ? {
          initial: readDiffStyle(),
          onChange: (next: 'unified' | 'split') => {
            writeDiffStyle(next);
            sendToRenderer({ kind: 'diff-style', style: next });
          },
        }
      : undefined;
    this.toggle = createToggleBar(
      this.enabled,
      (on) => void this.onToggle(on),
      diffStyleConfig,
    );
    const mount = document.createElement('div');
    mount.className = 'gh-pierre-mount';
    // Spinner stays visible until the renderer replaces it.
    if (isDiffSurface(surface)) {
      const loading = document.createElement('div');
      loading.className = 'gh-pierre-loading';
      loading.textContent = 'Loading diff…';
      mount.append(loading);
    }
    wrap.append(this.toggle.el, mount);

    const anchor = branches.reduce((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? b : a,
    );
    container.insertBefore(wrap, anchor);
    return wrap;
  }

  private ensureRenderer(): Promise<void> {
    if (this.rendererLoad) return this.rendererLoad;
    this.rendererLoad = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = browser.runtime.getURL('/renderer.js');
      script.addEventListener('load', () => resolve());
      script.addEventListener('error', () => reject(new Error('renderer failed to load')));
      (document.head ?? document.documentElement).appendChild(script);
    });
    return this.rendererLoad;
  }

  private async onToggle(on: boolean): Promise<void> {
    this.enabled = on;
    document.documentElement.classList.toggle(ON_CLASS, on);
    this.toggle?.setState(on);
    try { await browser.storage.local.set({ [STORAGE_KEY]: on }); } catch { /**/ }
    if (on && this.current) void this.activate(this.current);
    else if (!on) sendToRenderer({ kind: 'hide' });
  }

  // Handle a GitHub SPA navigation that changes which surface we are on.
  private reconcile(): void {
    this.lastPath = location.pathname;
    const surface = detectSurface(location.pathname);
    const id = surface ? surfaceId(surface) : null;
    if (id === this.currentId) return; // same surface — watchDom() copes
    document.getElementById(WRAP_ID)?.remove();
    this.toggle = null;
    sendToRenderer({ kind: 'hide' });
    this.current = surface;
    this.currentId = id;
    if (surface) {
      this.applyStyle(surface);
      document.documentElement.classList.toggle(ON_CLASS, this.enabled);
      void this.activate(surface);
    } else {
      document.documentElement.classList.remove(ON_CLASS);
      document.getElementById(STYLE_ID)?.remove();
    }
  }

  private watchNavigation(): void {
    const onNav = () => queueMicrotask(() => this.reconcile());
    for (const ev of ['turbo:load', 'turbo:frame-load', 'soft-nav:end', 'soft-nav:success']) {
      document.addEventListener(ev, onNav);
    }
    window.addEventListener('popstate', onNav);
  }

  // Covers the two ways GitHub mutates the page under us: a pathname change
  // (SPA nav we caught no event for — Turbo frame load), and a re-mount of
  // GitHub's diff/tree subtree that destroys our wrapper.
  private watchDom(): void {
    let queued = false;
    const tick = () => {
      queued = false;
      if (location.pathname !== this.lastPath) return this.reconcile();
      if (!this.current || this.activating) return;
      if (document.getElementById(WRAP_ID)?.isConnected) return;
      const targets = SURFACE_TARGETS[this.current.kind];
      if (firstMatch([...targets.diff, ...targets.tree])) void this.activate(this.current);
    };
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(tick);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  private applyStyle(surface: Surface): void {
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head ?? document.documentElement).appendChild(style);
    }
    const targets = SURFACE_TARGETS[surface.kind];
    const hidden = [...targets.diff, ...targets.tree].map((sel) => `html.${ON_CLASS} ${sel}`);
    const clip = isDiffSurface(surface) ? CLIP_CSS : '';
    style.textContent = `${LAYOUT_CSS}${clip}${hidden.join(',')}{display:none!important}`;
  }

  private async readEnabled(): Promise<boolean> {
    try {
      const stored = await browser.storage.local.get(STORAGE_KEY);
      return stored[STORAGE_KEY] !== false; // default on
    } catch {
      return true;
    }
  }
}

function waitFor(predicate: () => boolean, timeout: number): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const observer = new MutationObserver(() => {
      if (predicate()) done();
    });
    const timer = setTimeout(done, timeout);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

// Pin GitHub's sticky toolbars above the panel to `static`, so they scroll
// away with the header instead of overlapping Pierre.
function unstickAbove(wrap: HTMLElement): void {
  for (let node: Element | null = wrap; node && node !== document.body; node = node.parentElement) {
    for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
      for (const el of [sib, ...sib.querySelectorAll('*')]) {
        if (el instanceof HTMLElement && getComputedStyle(el).position === 'sticky') {
          el.style.setProperty('position', 'static', 'important');
        }
      }
    }
  }
}

// When GitHub serves a "diff too big" placeholder instead of the normal diff,
// pick its widget as the mount point — the `.diff` URL still works.
function findDiffPlaceholder(): Element | null {
  const main = document.querySelector('main') ?? document.body;
  const candidates = main.querySelectorAll(
    '.blankslate,[data-testid="blank-state"],[class*="Blankslate"],[class*="EmptyState"],' +
      '.flash-error,.flash-warn,[role="alert"]',
  );
  for (const el of candidates) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.offsetParent == null && el.getClientRects().length === 0) continue;
    const text = (el.textContent ?? '').toLowerCase();
    // Anchored to PR-content widgets so site-wide alerts don't slip through.
    if (
      /\b(?:diff|file|files|change|changes)\b/.test(text) &&
      /\b(?:too|large|big|cannot|can'?t|unable|unavailable|failed|sorry|error|display|render|load|show|view)\b/.test(text)
    ) {
      return el;
    }
  }
  return null;
}

function childOf(ancestor: Element, descendant: Element): Element {
  let node = descendant;
  while (node.parentElement && node.parentElement !== ancestor) node = node.parentElement;
  return node;
}

function commonAncestor(a: Element, b: Element): Element {
  const ancestors = new Set<Element>();
  for (let node: Element | null = a; node; node = node.parentElement) ancestors.add(node);
  for (let node: Element | null = b; node; node = node.parentElement) {
    if (ancestors.has(node)) return node;
  }
  return a;
}
