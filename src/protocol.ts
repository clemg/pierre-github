/**
 * Message bridge between the orchestrator (isolated world) and the renderer
 * (main world). They share the DOM but not the JS heap, so they talk over
 * window.postMessage (structured-cloned across the boundary).
 */
import type { Surface } from './surfaces';

export type ThemeMode = 'light' | 'dark';
export type DiffStyle = 'unified' | 'split';

const DIFF_STYLE_KEY = 'gh-pierre:diffStyle';
export function readDiffStyle(): DiffStyle {
  try { return localStorage.getItem(DIFF_STYLE_KEY) === 'split' ? 'split' : 'unified'; }
  catch { return 'unified'; }
}
export function writeDiffStyle(style: DiffStyle): void {
  try { localStorage.setItem(DIFF_STYLE_KEY, style); } catch { /**/ }
}

// The 8 reactions GitHub supports on a review comment.
export type ReactionContent =
  | '+1' | '-1' | 'laugh' | 'hooray' | 'confused' | 'heart' | 'rocket' | 'eyes';
export interface Reaction {
  content: ReactionContent;
  count: number;
  viewerReacted: boolean;
}
export interface Comment {
  id: number;            // REST id used in every write endpoint
  author: string;
  avatarUrl: string;
  createdAt: string;
  body: string;          // raw markdown — seeds the edit composer and the
                         //   body_version (sha256) sent with PUT update
  bodyHtml: string;      // pre-rendered HTML
  viewerCanUpdate: boolean;
  viewerCanDelete: boolean;
  reactions: Reaction[];
}
export interface CommentThread {
  key: string;           // `T:<rootId>` for real threads, `D:<draftId>` for unposted
  path: string;
  line: number;
  side: 'old' | 'new';
  resolved: boolean;
  // The id passed as `inReplyTo` to add a reply. Null for unposted drafts.
  rootCommentId: number | null;
  comments: Comment[];
  // Set => renderer shows a composer at the bottom (or alone, for brand-new
  // threads with no comments yet).
  draft?: { body: string };
}

export type FileTexts = Record<string, { old: string; new: string }>;

// Head + base commit SHAs from the PR diff payload. The renderer needs both
// to build the `positioning` block on `create_review_comment`.
export interface CommitOids { base: string; head: string }

export type ToRenderer =
  | { kind: 'diff'; surface: Surface; diff: string; theme: ThemeMode; comments: CommentThread[]; contents: FileTexts; commits: CommitOids | null }
  | { kind: 'tree'; surface: Surface; paths: string[]; activePath: string | null; theme: ThemeMode }
  | { kind: 'contents'; contents: FileTexts }
  | { kind: 'theme'; theme: ThemeMode }
  | { kind: 'diff-style'; style: DiffStyle }
  | { kind: 'hide' };

export type FromRenderer = { kind: 'rendered'; ok: boolean; error?: string };

const CHANNEL = 'gh-pierre-v1';
function send(dir: 'down' | 'up', msg: unknown): void {
  window.postMessage({ __ch: CHANNEL, dir, msg }, location.origin);
}
function listen<T>(dir: 'down' | 'up', handler: (msg: T) => void): void {
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { __ch?: string; dir?: string; msg?: T } | null;
    if (e.source === window && d?.__ch === CHANNEL && d.dir === dir) handler(d.msg as T);
  });
}
export const sendToRenderer = (msg: ToRenderer): void => send('down', msg);
export const sendToOrchestrator = (msg: FromRenderer): void => send('up', msg);
export const onRendererMessage = (h: (msg: ToRenderer) => void): void => listen('down', h);
export const onOrchestratorMessage = (h: (msg: FromRenderer) => void): void => listen('up', h);
