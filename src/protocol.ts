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
  try {
    return localStorage.getItem(DIFF_STYLE_KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}
export function writeDiffStyle(style: DiffStyle): void {
  try { localStorage.setItem(DIFF_STYLE_KEY, style); } catch { /**/ }
}

// An existing GitHub review thread (or a local draft / posted-local comment).
export interface CommentThread {
  path: string;
  line: number;
  side: 'old' | 'new';
  resolved: boolean;
  comments: { author: string; bodyHtml: string }[];
  // When set, the renderer shows a composer in place of the comment card.
  draft?: { id: string; body: string };
}

// Full before/after text of changed files, keyed by path — lets Pierre expand
// unchanged context the patch alone omits.
export type FileTexts = Record<string, { old: string; new: string }>;

export type ToRenderer =
  | { kind: 'diff'; surface: Surface; diff: string; theme: ThemeMode; comments: CommentThread[]; contents: FileTexts }
  | { kind: 'tree'; surface: Surface; paths: string[]; activePath: string | null; theme: ThemeMode }
  // Sent after a partial diff render once the changed files' text has loaded.
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
