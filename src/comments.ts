/**
 * Comment-thread extraction. GitHub inlines its PR data in a
 * `react-app.embeddedData` <script>; we pull the threads and their per-comment
 * metadata (id, body, reactions, viewer permissions) straight from there for
 * the first paint. Writes go through GitHub's internal `/page_data/*` endpoints
 * (see `views.ts`) and update local state.
 */
import type { Comment, CommentThread, CommitOids, Reaction, ReactionContent } from './protocol';

export interface Route {
  markers?: { threads?: Record<string, EmbedThread> };
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
interface Marker { threads?: { id: string | number }[] }
interface EmbedThread { isResolved?: boolean; commentsData?: { comments?: EmbedComment[] } }
interface EmbedComment {
  id?: number;
  databaseId?: number;
  author?: { login?: string; avatarUrl?: string };
  body?: string;
  bodyHTML?: string;
  createdAt?: string;
  viewerCanUpdate?: boolean;
  viewerCanDelete?: boolean;
  // Shape from `react-app.embeddedData`: each group is one reaction kind,
  // with the content + viewer flag nested under `reaction`, and the count
  // alongside as `totalCount`. `reactors` lists who reacted.
  reactionGroups?: {
    reaction?: { content?: string; viewerHasReacted?: boolean };
    reactors?: { login?: string }[];
    totalCount?: number;
  }[];
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

// The PR's base + head commit SHAs. Both are required to build the
// `positioning` block on `create_review_comment`. The first diff entry in the
// embedded payload reliably carries each as `oldCommitOid` / `newCommitOid`.
export function embeddedCommits(): CommitOids | null {
  let base: string | null = null;
  let head: string | null = null;
  for (const d of embeddedRoute()?.diffContents ?? []) {
    if (!base && d.oldCommitOid) base = d.oldCommitOid;
    if (!head && d.newCommitOid) head = d.newCommitOid;
    if (base && head) break;
  }
  return base && head ? { base, head } : null;
}

export function extractThreads(viewerLogin: string): CommentThread[] {
  const route = embeddedRoute();
  if (!route) return [];
  const threads = route.markers?.threads ?? {};
  const out: CommentThread[] = [];
  for (const summary of route.diffSummaries ?? []) {
    for (const [key, marker] of Object.entries(summary.markersMap ?? {})) {
      const at = markerPosition(key);
      if (!at) continue;
      for (const ref of marker.threads ?? []) {
        const t = threads[String(ref.id)];
        const raw = (t?.commentsData?.comments ?? []).filter((c) => c.bodyHTML != null);
        if (raw.length === 0) continue;
        const comments = raw.map((c) => embedToComment(c, viewerLogin));
        const root = comments[0]!;
        out.push({
          key: `T:${root.id}`,
          path: summary.path,
          line: at.line,
          side: at.side,
          resolved: !!t?.isResolved,
          rootCommentId: root.id,
          comments,
        });
      }
    }
  }
  return out;
}

function embedToComment(c: EmbedComment, viewer: string): Comment {
  const id = c.databaseId ?? c.id ?? 0;
  const author = c.author?.login ?? 'someone';
  return {
    id,
    author,
    avatarUrl: c.author?.avatarUrl ?? `https://github.com/${author}.png?size=64`,
    createdAt: c.createdAt ?? '',
    body: c.body ?? '',
    bodyHtml: c.bodyHTML ?? '',
    // Embedded data sometimes drops viewer flags; default by author match.
    viewerCanUpdate: c.viewerCanUpdate ?? (author === viewer),
    viewerCanDelete: c.viewerCanDelete ?? (author === viewer),
    reactions: embedReactions(c.reactionGroups),
  };
}

function embedReactions(groups: EmbedComment['reactionGroups']): Reaction[] {
  if (!groups) return [];
  const out: Reaction[] = [];
  for (const g of groups) {
    const content = normalize(g.reaction?.content);
    const count = g.totalCount ?? 0;
    if (!content || count === 0) continue;
    out.push({ content, count, viewerReacted: !!g.reaction?.viewerHasReacted });
  }
  return out;
}

// `R<line>` is the new side, `L<line>` is the old side. `FILE` is a file-level
// note we skip — no line to anchor to.
function markerPosition(key: string): { line: number; side: 'old' | 'new' } | null {
  const m = /^([RL])(\d+)$/.exec(key);
  return m ? { line: Number(m[2]), side: m[1] === 'L' ? 'old' : 'new' } : null;
}

function normalize(v: unknown): ReactionContent | null {
  if (typeof v !== 'string') return null;
  const k = v.toLowerCase().replace('thumbs_up', '+1').replace('thumbs_down', '-1');
  return (['+1','-1','laugh','hooray','confused','heart','rocket','eyes'] as ReactionContent[])
    .includes(k as ReactionContent) ? (k as ReactionContent) : null;
}

// `<meta name="user-login">` is GitHub's own viewer hint; falls back to empty
// so unauthenticated views still build threads (read-only).
export function readViewerLogin(): string {
  return document.querySelector('meta[name="user-login"]')?.getAttribute('content') ?? '';
}
