/**
 * The four GitHub surfaces we override — how to recognise them from the URL,
 * which GitHub DOM elements they own, and the data they need.
 */

export type SurfaceKind = 'pr' | 'commit' | 'compare' | 'code';

// `ref` is the PR number, commit SHA, compare range, or `<ref>/<path>` for
// the code browser.
export interface Surface {
  kind: SurfaceKind;
  owner: string;
  repo: string;
  ref: string;
}

const ROUTES: ReadonlyArray<{ kind: SurfaceKind; re: RegExp }> = [
  { kind: 'pr', re: /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:files|changes)\/?$/ },
  { kind: 'commit', re: /^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})\/?$/ },
  { kind: 'compare', re: /^\/([^/]+)\/([^/]+)\/compare\/(.+)$/ },
  { kind: 'code', re: /^\/([^/]+)\/([^/]+)\/(?:blob|tree)\/(.+)$/ },
];

export function detectSurface(pathname: string): Surface | null {
  for (const { kind, re } of ROUTES) {
    const m = re.exec(pathname);
    if (m?.[1] && m[2] && m[3]) return { kind, owner: m[1], repo: m[2], ref: m[3] };
  }
  return null;
}

export const isDiffSurface = (s: Surface): boolean => s.kind !== 'code';

// Code-browser id omits the path so navigating file-to-file keeps one live
// FileTree (its expanded folders + scroll position survive).
export function surfaceId(s: Surface): string {
  return s.kind === 'code'
    ? `code:${s.owner}/${s.repo}`
    : `${s.kind}:${s.owner}/${s.repo}:${s.ref}`;
}

// Always on github.com so the session cookie authorises private repos.
export function diffUrl(s: Surface): string {
  const seg = s.kind === 'pr' ? 'pull' : s.kind;
  return `${location.origin}/${s.owner}/${s.repo}/${seg}/${s.ref}.diff`;
}

// GitHub's diff/tree elements per surface. The orchestrator hides exactly
// these and slots Pierre in at their common ancestor. Candidates per slot
// cover GitHub's old and new renderers; first match wins.
export const SURFACE_TARGETS: Record<
  SurfaceKind,
  { diff: readonly string[]; tree: readonly string[] }
> = {
  pr: {
    diff: ['[data-testid="diff-content"]', '#diff-content-parent', '#files'],
    tree: ['#pr-file-tree', '#diff_file_tree', 'file-tree'],
  },
  commit: { diff: ['#diff-content-parent', '#files'], tree: ['#diff_file_tree'] },
  compare: { diff: ['#files'], tree: [] },
  code: { diff: [], tree: ['#repos-file-tree'] },
};

export function firstMatch(selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}
