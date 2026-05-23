/**
 * Renders Pierre components into the page's main world. `renderDiff` builds a
 * FileTree + virtualized CodeView for PR/commit/compare; `renderTree` builds
 * the code-browser sidebar.
 */
import {
  CodeView, processPatch, processFile, getFiletypeFromFileName, setLanguageOverride,
  type CodeViewItem, type CodeViewOptions, type DiffLineAnnotation, type FileDiffMetadata,
  type SelectedLineRange,
} from '@pierre/diffs';
import { FileTree } from '@pierre/trees';
import type { CommentThread, DiffStyle, FileTexts, ThemeMode } from './protocol';
import { readDiffStyle } from './protocol';
import type { Surface } from './surfaces';
import { surfaceId } from './surfaces';
import { KNOWN_LANGS } from './languages';

export interface RenderHandle {
  teardown(): void;
  setTheme(theme: ThemeMode): void;
  // Fold the full before/after file text into the diffs so expand-context works.
  addContents?(contents: FileTexts): void;
  setDiffStyle?(style: DiffStyle): void;
}

const PIERRE_THEME = { dark: 'pierre-dark', light: 'pierre-light' } as const;
const TREE_WIDTH = 272;
const TREE_ICONS = { set: 'complete', colored: true } as const;
// Files changing more than this many lines render collapsed (vendored / generated).
const HUGE_DIFF_LINES = 2000;
// Cap Shiki main-thread tokenization at this many lines per file; above this
// Pierre renders plain text — keeps the main thread free on huge files.
const TOKENIZE_MAX_LINES = 1500;
const HUGE_PR_FILE_THRESHOLD = 500;
const PIERRE_PADDING_TOP = 0;
const PIERRE_PADDING_BOTTOM = 8;

export function renderDiff(
  mount: Element,
  data: {
    surface: Surface; diff: string; theme: ThemeMode;
    comments: CommentThread[]; contents: FileTexts;
  },
): RenderHandle {
  const parsed = processPatch(data.diff).files;
  if (parsed.length === 0) throw new Error('empty diff');
  const chunks = data.diff.split(/\n(?=diff --git )/);
  const huge = new Set(parsed.filter(isHugeDiff).map((f) => f.name));
  const files = parsed.map((f, i) => withContent(f, chunks[i], data.contents));

  const surfaceKey = surfaceId(data.surface);
  const viewed = loadSet(`viewed:${surfaceKey}`);
  const drafts = loadDrafts(surfaceKey);
  const expandedHuge = new Set<string>();
  let diffStyle: DiffStyle = readDiffStyle();

  const outer = box('position:relative;width:100%');
  const panel = box('position:sticky;top:0;height:100dvh;display:flex;min-height:0');
  const treePane = box(
    `width:${TREE_WIDTH}px;flex:none;overflow:hidden;` +
      'border-right:1px solid var(--borderColor-default,#d1d9e0)',
  );
  const codePane = box('flex:1;min-width:0;height:100%;overflow:hidden');
  panel.append(treePane, codePane);
  outer.append(panel);
  mount.replaceChildren(outer);

  const annotations = groupAnnotations(files, data.comments);
  const byPath = new Map(files.map((f) => [f.name, f]));
  let version = 1;
  const annotationsFor = (path: string): DiffLineAnnotation<CommentThread>[] => [
    ...(annotations.get(path) ?? []),
    ...(drafts.get(path) ?? []).map((d) => ({
      side: (d.side === 'old' ? 'deletions' : 'additions') as 'deletions' | 'additions',
      lineNumber: d.line,
      metadata: draftThread(d),
    })),
  ];
  const itemFor = (fileDiff: FileDiffMetadata): CodeViewItem<CommentThread> => ({
    id: fileDiff.name,
    type: 'diff',
    fileDiff,
    version,
    annotations: annotationsFor(fileDiff.name),
    collapsed:
      viewed.has(fileDiff.name) ||
      (huge.has(fileDiff.name) && !expandedHuge.has(fileDiff.name)),
  });

  const buildOptions = (): CodeViewOptions<CommentThread> => ({
    ...codeViewOptions(data.theme, parsed.length, diffStyle),
    renderAnnotation: (annotation) =>
      annotation.metadata.draft
        ? draftCard(annotation.metadata, (body) => commitDraft(annotation.metadata, body), () => removeDraft(annotation.metadata))
        : commentCard(annotation.metadata),
    // CodeView's typing unions the file/diff callback shapes — we only ever
    // hold diff items here, so cast through to the diff-side properties.
    renderHeaderMetadata: (file) => viewedCheckbox((file as FileDiffMetadata).name),
    enableGutterUtility: true,
    onGutterUtilityClick: (range, context) => {
      if (context.type === 'diff') addDraft(context.item.fileDiff, range);
    },
  });
  const view = new CodeView<CommentThread>(buildOptions());
  view.setup(codePane);
  view.setItems(files.map(itemFor));
  view.render();

  // Window-scroll drives codePane.scrollTop; `inner` is Pierre's sizing
  // container (only DOM child of codePane). We observe it because codePane
  // itself never resizes (height:100%), so Pierre's content growth would go
  // unnoticed and outer.style.height would stay stuck at 0.
  const inner = codePane.firstElementChild as HTMLElement | null;
  let outerTopDoc = 0;
  let codePaneMaxScroll = 0;
  let lastOuterHeight = -1;
  let layoutRaf = 0;
  const refreshLayout = (): void => {
    if (layoutRaf) return;
    layoutRaf = requestAnimationFrame(() => {
      layoutRaf = 0;
      // PIERRE_PADDING_BOTTOM gives the last file's "expand below" button
      // room — Pierre treats it as a margin so it isn't in offsetHeight.
      const innerHeight = (inner?.offsetHeight ?? 0) + PIERRE_PADDING_BOTTOM;
      if (innerHeight !== lastOuterHeight) {
        lastOuterHeight = innerHeight;
        outer.style.height = `${innerHeight}px`;
      }
      outerTopDoc = window.scrollY + outer.getBoundingClientRect().top;
      codePaneMaxScroll = Math.max(0, innerHeight - codePane.clientHeight);
    });
  };
  const ro = inner ? new ResizeObserver(refreshLayout) : null;
  if (inner) ro?.observe(inner);
  window.addEventListener('resize', refreshLayout, { passive: true });
  refreshLayout();

  let scrollRaf = 0;
  const syncFromWindow = (): void => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const offset = Math.max(0, window.scrollY - outerTopDoc);
      codePane.scrollTop = Math.min(offset, codePaneMaxScroll);
    });
  };
  window.addEventListener('scroll', syncFromWindow, { passive: true });

  const scrollToFile = (path: string): void => {
    const target = view.getTopForItem(path);
    if (target == null) return;
    const top = window.scrollY + outer.getBoundingClientRect().top + target;
    window.scrollTo({ top, behavior: 'smooth' });
  };

  const refreshFile = (file: FileDiffMetadata): void => {
    version += 1;
    view.updateItem(itemFor(file));
  };

  const addDraft = (file: FileDiffMetadata, range: SelectedLineRange): void => {
    const line = range.start;
    const side: 'old' | 'new' = range.side === 'deletions' ? 'old' : 'new';
    const list = drafts.get(file.name) ?? [];
    // Don't stack drafts on the same line — just focus the existing one.
    if (!list.some((d) => d.line === line && d.side === side)) {
      list.push({ id: `d-${Date.now()}`, path: file.name, line, side, body: '' });
      drafts.set(file.name, list);
      saveDrafts(surfaceKey, drafts);
      refreshFile(file);
    }
  };
  const commitDraft = (meta: CommentThread, body: string): void => {
    const file = byPath.get(meta.path);
    if (!file || !meta.draft) return;
    const trimmed = body.trim();
    if (!trimmed) { removeDraft(meta); return; }
    const list = drafts.get(meta.path) ?? [];
    const draft = list.find((d) => d.id === meta.draft?.id);
    if (!draft) return;
    draft.body = trimmed;
    draft.posted = true;
    saveDrafts(surfaceKey, drafts);
    refreshFile(file);
  };
  const removeDraft = (meta: CommentThread): void => {
    const file = byPath.get(meta.path);
    if (!file || !meta.draft) return;
    const list = (drafts.get(meta.path) ?? []).filter((d) => d.id !== meta.draft?.id);
    if (list.length > 0) drafts.set(meta.path, list);
    else drafts.delete(meta.path);
    saveDrafts(surfaceKey, drafts);
    refreshFile(file);
  };

  const viewedCheckbox = (path: string): HTMLElement => {
    const label = document.createElement('label');
    label.style.cssText =
      'display:inline-flex;align-items:center;gap:4px;font:500 11px/1.3 system-ui;' +
      'color:var(--fgColor-muted,#59636e);cursor:pointer;user-select:none';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = viewed.has(path);
    check.style.cssText = 'margin:0;cursor:pointer';
    check.addEventListener('change', () => {
      if (check.checked) viewed.add(path);
      else viewed.delete(path);
      saveSet(`viewed:${surfaceKey}`, viewed);
      const file = byPath.get(path);
      if (file) refreshFile(file);
    });
    const text = document.createElement('span');
    text.textContent = 'Viewed';
    label.append(check, text);
    return label;
  };

  const tree = new FileTree({
    paths: [...byPath.keys()],
    initialExpansion: 'open',
    icons: TREE_ICONS,
    search: true,
    gitStatus: files.map((f) => ({ path: f.name, status: gitStatusOf(f) })),
    onSelectionChange: (selected) => {
      const path = selected[0]; // folder clicks don't pick a file → ignore
      if (!path) return;
      const fileDiff = byPath.get(path);
      if (!fileDiff) return;
      if (!expandedHuge.has(path) && huge.has(path)) {
        expandedHuge.add(path);
        refreshFile(fileDiff);
      }
      scrollToFile(path);
    },
  });
  tree.render({ containerWrapper: treePane });

  return {
    teardown() {
      window.removeEventListener('scroll', syncFromWindow);
      window.removeEventListener('resize', refreshLayout);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      if (layoutRaf) cancelAnimationFrame(layoutRaf);
      ro?.disconnect();
      view.cleanUp();
      tree.cleanUp();
      mount.replaceChildren();
    },
    setTheme(theme) {
      data.theme = theme;
      view.setOptions(buildOptions());
    },
    setDiffStyle(style) {
      if (style === diffStyle) return;
      diffStyle = style;
      view.setOptions(buildOptions());
    },
    addContents(contents) {
      // One atomic setItems handoff keeps Pierre's reconcile clean (per-frame
      // updateItem left residue between consecutive diff lines). Files large
      // enough that re-tokenizing them would freeze the main thread stay
      // context-less, but everything stays smooth.
      let dirty = false;
      for (let i = 0; i < parsed.length; i += 1) {
        const file = parsed[i];
        if (!file) continue;
        const text = contents[file.name];
        if (!text) continue;
        if (lineCount(text.new) > TOKENIZE_MAX_LINES) continue;
        const next = withContent(file, chunks[i], contents);
        if (next === files[i]) continue;
        files[i] = next;
        byPath.set(next.name, next);
        dirty = true;
      }
      if (!dirty) return;
      version += 1;
      view.setItems(files.map(itemFor));
      refreshLayout();
    },
  };
}

export function renderTree(
  mount: Element,
  data: { owner: string; repo: string; paths: string[]; activePath: string | null },
): RenderHandle {
  if (data.paths.length === 0) throw new Error('empty tree');
  // Wrap is a fixed-height flex column (sticky 100dvh, see ensureWrapper);
  // force mount to fill it so panel's `height:100%` resolves to something
  // real. Without this it auto-sizes to the FileTree's intrinsic content
  // (just the search bar) and the file list ends up clipped to ~0px.
  const m = mount as HTMLElement;
  m.style.flex = '1';
  m.style.minHeight = '0';
  const panel = box('height:100%;min-height:0;overflow:hidden');
  mount.replaceChildren(panel);

  const repoKey = `${data.owner}/${data.repo}`;
  const branch = currentBranch();
  const here = data.activePath;
  const isFilePath = here != null && data.paths.includes(here);
  const allDirs = directoriesOf(data.paths);
  const toHere = here == null ? [] : isFilePath ? ancestorDirs(here) : [...ancestorDirs(here), here];
  const expanded = [...new Set([...loadTreeOpen(repoKey), ...toHere])];

  const tree = new FileTree({
    paths: data.paths,
    initialExpansion: 'closed',
    initialExpandedPaths: expanded,
    initialSelectedPaths: isFilePath ? [here] : [],
    icons: TREE_ICONS,
    search: true,
    onSelectionChange: (selected) => {
      const picked = selected[0];
      if (picked && picked !== here && data.paths.includes(picked)) {
        saveTreeOpen(repoKey, tree, allDirs);
        location.assign(`/${data.owner}/${data.repo}/blob/${branch}/${picked}`);
      }
    },
  });
  tree.render({ containerWrapper: panel });
  if (here) requestAnimationFrame(() => tree.scrollToPath(here));

  return {
    teardown() {
      tree.cleanUp();
      mount.replaceChildren();
    },
    setTheme() {
      // FileTree follows GitHub's CSS variables; nothing to repaint.
    },
  };
}

function codeViewOptions(
  theme: ThemeMode,
  fileCount: number,
  diffStyle: DiffStyle,
): CodeViewOptions<CommentThread> {
  return {
    theme: PIERRE_THEME,
    themeType: theme,
    diffStyle,
    diffIndicators: 'bars',
    lineDiffType: 'word-alt',
    hunkSeparators: 'line-info',
    stickyHeaders: true,
    enableLineSelection: true,
    overflow: 'scroll',
    expansionLineCount: 20,
    tokenizeMaxLength: fileCount > HUGE_PR_FILE_THRESHOLD ? 200 : TOKENIZE_MAX_LINES,
    layout: { paddingTop: PIERRE_PADDING_TOP, paddingBottom: PIERRE_PADDING_BOTTOM, gap: 8 },
  };
}

const isHugeDiff = (f: FileDiffMetadata): boolean =>
  f.additionLines.length + f.deletionLines.length > HUGE_DIFF_LINES;

function groupAnnotations(
  files: FileDiffMetadata[],
  comments: CommentThread[],
): Map<string, DiffLineAnnotation<CommentThread>[]> {
  const known = new Set(files.map((f) => f.name));
  const byFile = new Map<string, DiffLineAnnotation<CommentThread>[]>();
  for (const comment of comments) {
    if (!known.has(comment.path)) continue;
    const list = byFile.get(comment.path) ?? [];
    list.push({
      side: comment.side === 'old' ? 'deletions' : 'additions',
      lineNumber: comment.line,
      metadata: comment,
    });
    byFile.set(comment.path, list);
  }
  return byFile;
}

function gitStatusOf(f: FileDiffMetadata): 'added' | 'deleted' | 'modified' | 'renamed' {
  if (f.type === 'new') return 'added';
  if (f.type === 'deleted') return 'deleted';
  if (f.type === 'rename-pure' || f.type === 'rename-changed') return 'renamed';
  return 'modified';
}

/**
 * Re-parse a file's patch with its full before/after text folded in, so Pierre
 * keeps GitHub's exact diff yet can expand the unchanged context the patch
 * omits. Falls back to the patch-only diff; forces plain text for languages we
 * bundle no grammar for (a missing Shiki grammar otherwise throws).
 */
function withContent(
  f: FileDiffMetadata,
  chunk: string | undefined,
  contents: FileTexts,
): FileDiffMetadata {
  let meta = f;
  const text = contents[f.name];
  if (text && chunk) {
    const enriched = processFile(chunk, {
      oldFile: { name: f.prevName ?? f.name, contents: text.old },
      newFile: { name: f.name, contents: text.new },
    });
    if (enriched) meta = enriched;
  }
  return KNOWN_LANGS.has(getFiletypeFromFileName(meta.name)) ? meta : setLanguageOverride(meta, 'text');
}

const lineCount = (text: string): number => {
  let n = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
};

function commentCard(thread: CommentThread): HTMLElement {
  const card = box(
    'margin:6px 8px;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;' +
      'background:var(--bgColor-default,#fff);overflow:hidden;font:13px/1.5 sans-serif',
  );
  const n = thread.comments.length;
  const head = box(
    'padding:4px 10px;font-weight:600;font-size:11px;color:var(--fgColor-muted,#59636e);' +
      'background:var(--bgColor-muted,#f6f8fa)',
  );
  head.textContent = `${n} review comment${n > 1 ? 's' : ''}${thread.resolved ? ' · resolved' : ''}`;
  card.append(head);
  for (const comment of thread.comments) {
    const item = box('padding:6px 10px;border-top:1px solid var(--borderColor-default,#d1d9e0)');
    const author = box('font-weight:600;margin-bottom:2px');
    author.textContent = comment.author;
    const body = box('overflow-wrap:anywhere');
    body.innerHTML = comment.bodyHtml;
    item.append(author, body);
    card.append(item);
  }
  return card;
}

function draftCard(
  thread: CommentThread,
  onSave: (body: string) => void,
  onCancel: () => void,
): HTMLElement {
  const card = box(
    'margin:6px 8px;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;' +
      'background:var(--bgColor-default,#fff);overflow:hidden;font:13px/1.5 sans-serif',
  );
  const head = box(
    'padding:4px 10px;font-weight:600;font-size:11px;color:var(--fgColor-muted,#59636e);' +
      'background:var(--bgColor-muted,#f6f8fa);display:flex;justify-content:space-between',
  );
  head.append(
    Object.assign(document.createElement('span'), { textContent: 'New comment' }),
    Object.assign(document.createElement('span'), {
      textContent: `${thread.side === 'old' ? 'L' : 'R'}${thread.line}`,
    }),
  );
  const ta = document.createElement('textarea');
  ta.value = thread.draft?.body ?? '';
  ta.placeholder = 'Leave a comment';
  ta.style.cssText =
    'width:100%;min-height:64px;padding:8px 10px;border:0;border-bottom:1px solid ' +
    'var(--borderColor-default,#d1d9e0);background:transparent;color:inherit;font:inherit;resize:vertical';
  const actions = box('display:flex;justify-content:flex-end;gap:6px;padding:6px 8px');
  const mkBtn = (text: string, accent: boolean): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.style.cssText =
      `padding:4px 10px;font:inherit;border-radius:6px;cursor:pointer;` +
      (accent
        ? 'background:var(--bgColor-accent-emphasis,#0969da);color:#fff;border:1px solid transparent'
        : 'background:transparent;color:inherit;border:1px solid var(--borderColor-default,#d1d9e0)');
    return b;
  };
  const cancelBtn = mkBtn('Cancel', false);
  const saveBtn = mkBtn('Comment', true);
  cancelBtn.addEventListener('click', onCancel);
  saveBtn.addEventListener('click', () => onSave(ta.value));
  actions.append(cancelBtn, saveBtn);
  card.append(head, ta, actions);
  requestAnimationFrame(() => ta.focus());
  return card;
}

// A posted draft is shown like any other review thread; an unposted draft
// is shown as a composer (see draftCard).
function draftThread(d: LocalDraft): CommentThread {
  const base = { path: d.path, line: d.line, side: d.side, resolved: false };
  if (d.posted) {
    return {
      ...base,
      comments: [{ author: viewerLogin(), bodyHtml: escapeHtml(d.body) }],
    };
  }
  return { ...base, comments: [], draft: { id: d.id, body: d.body } };
}

function viewerLogin(): string {
  const meta = document.querySelector('meta[name="user-login"]');
  return meta?.getAttribute('content') ?? 'you';
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML.replace(/\n/g, '<br>');
}

interface LocalDraft {
  id: string; path: string; line: number; side: 'old' | 'new'; body: string;
  posted?: boolean;
}

const STORAGE_PREFIX = 'gh-pierre:';

function loadSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
const saveSet = (key: string, set: Set<string>): void => {
  try { localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify([...set])); } catch { /**/ }
};

function loadDrafts(surfaceKey: string): Map<string, LocalDraft[]> {
  const out = new Map<string, LocalDraft[]>();
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}drafts:${surfaceKey}`);
    const parsed = raw ? (JSON.parse(raw) as LocalDraft[]) : [];
    if (!Array.isArray(parsed)) return out;
    for (const d of parsed) {
      const list = out.get(d.path) ?? [];
      list.push(d);
      out.set(d.path, list);
    }
  } catch { /**/ }
  return out;
}
const saveDrafts = (surfaceKey: string, drafts: Map<string, LocalDraft[]>): void => {
  const flat: LocalDraft[] = [];
  for (const list of drafts.values()) flat.push(...list);
  try {
    localStorage.setItem(`${STORAGE_PREFIX}drafts:${surfaceKey}`, JSON.stringify(flat));
  } catch { /**/ }
};

// Code-browser tree state is kept in sessionStorage so folder expansion
// survives the full-page reload GitHub does on file navigation.
function loadTreeOpen(repoKey: string): string[] {
  try {
    const raw = sessionStorage.getItem(`${STORAGE_PREFIX}tree:${repoKey}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function saveTreeOpen(repoKey: string, tree: FileTree, dirs: string[]): void {
  const open = dirs.filter((dir) => {
    const item = tree.getItem(dir);
    return item != null && 'isExpanded' in item && item.isExpanded();
  });
  try {
    sessionStorage.setItem(`${STORAGE_PREFIX}tree:${repoKey}`, JSON.stringify(open));
  } catch { /**/ }
}

function ancestorDirs(path: string): string[] {
  const parts = path.split('/');
  parts.pop();
  const dirs: string[] = [];
  let prefix = '';
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    dirs.push(prefix);
  }
  return dirs;
}

const directoriesOf = (paths: string[]): string[] => [...new Set(paths.flatMap(ancestorDirs))];

function currentBranch(): string {
  const m = /^\/[^/]+\/[^/]+\/(?:blob|tree)\/([^/]+)/.exec(location.pathname);
  return m?.[1] ?? 'HEAD';
}

function box(css: string): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = css;
  return el;
}
