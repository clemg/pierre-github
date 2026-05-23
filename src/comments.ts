/**
 * GitHub's PR renderer embeds review threads + per-file blob metadata in a
 * `react-app.embeddedData` <script>. We lift it out for display and to fetch
 * the raw blobs.
 */
import type { CommentThread } from './protocol';

export interface Route {
  markers?: { threads?: Record<string, Thread> };
  diffSummaries?: { path: string; markersMap?: Record<string, Marker> }[];
  diffContents?: DiffContent[];
}
export interface DiffContent {
  path: string;
  isBinary?: boolean;
  isTooBig?: boolean;
  oldCommitOid?: string;
  newCommitOid?: string;
  oldTreeEntry?: { path: string; lineCount?: number } | null;
  newTreeEntry?: { path: string; lineCount?: number } | null;
}
interface Marker {
  threads?: { id: string | number }[];
}
interface Thread {
  isResolved?: boolean;
  commentsData?: { comments?: { author?: { login?: string }; bodyHTML?: string }[] };
}

export function embeddedRoute(): Route | null {
  for (const el of document.querySelectorAll('script[data-target="react-app.embeddedData"]')) {
    try {
      const data = JSON.parse(el.textContent ?? '{}') as {
        payload?: { pullRequestsChangesRoute?: Route };
      };
      if (data.payload?.pullRequestsChangesRoute) return data.payload.pullRequestsChangesRoute;
    } catch { /**/ }
  }
  return null;
}

export function extractComments(): CommentThread[] {
  const route = embeddedRoute();
  if (!route) return [];
  const threads = route.markers?.threads ?? {};
  const out: CommentThread[] = [];
  for (const summary of route.diffSummaries ?? []) {
    for (const [key, marker] of Object.entries(summary.markersMap ?? {})) {
      const at = markerPosition(key);
      if (!at) continue;
      for (const ref of marker.threads ?? []) {
        const thread = threads[String(ref.id)];
        const comments = (thread?.commentsData?.comments ?? [])
          .filter((c) => c.bodyHTML)
          .map((c) => ({ author: c.author?.login ?? 'someone', bodyHtml: c.bodyHTML ?? '' }));
        if (comments.length) {
          out.push({ path: summary.path, ...at, resolved: !!thread?.isResolved, comments });
        }
      }
    }
  }
  return out;
}

// markersMap keys: `FILE`, `R<line>` (new side) or `L<line>` (old side).
function markerPosition(key: string): { line: number; side: 'old' | 'new' } | null {
  if (key === 'FILE') return { line: 1, side: 'new' };
  const m = /^([RL])(\d+)$/.exec(key);
  return m ? { line: Number(m[2]), side: m[1] === 'L' ? 'old' : 'new' } : null;
}
