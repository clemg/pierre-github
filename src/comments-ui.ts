/**
 * Pierre-styled comment UI rendered into the diff's annotation slot. The
 * annotation slot in @pierre/diffs is just a DOM hook (`renderAnnotation`);
 * Pierre's own diffs.com app builds its comment UI on top of it. We do the
 * same here but post each mutation to GitHub's internal `/page_data/*`
 * endpoints (auth'd by the session cookie), so changes appear on github.com.
 */
import type { SelectedLineRange } from '@pierre/diffs';
import type { Comment, CommentThread, CommitOids, Reaction, ReactionContent } from './protocol';
import { box } from './views';

const REACTION_EMOJI: Record<ReactionContent, string> = {
  '+1': '👍', '-1': '👎', laugh: '😄', hooray: '🎉',
  confused: '😕', heart: '❤️', rocket: '🚀', eyes: '👀',
};

// Maps our lowercase content names to the SCREAMING_SNAKE strings the page
// endpoints expect in their JSON bodies.
const REACTION_API: Record<ReactionContent, string> = {
  '+1': 'THUMBS_UP', '-1': 'THUMBS_DOWN', laugh: 'LAUGH', hooray: 'HOORAY',
  confused: 'CONFUSED', heart: 'HEART', rocket: 'ROCKET', eyes: 'EYES',
};

interface PrRef { owner: string; repo: string; number: string }
export interface CommentStoreConfig {
  threads: CommentThread[];
  pr: PrRef;
  commits: CommitOids | null;
  viewerLogin: string;
  refresh(path: string): void;
}
export interface CommentStore {
  openDraft(path: string, range: SelectedLineRange): void;
  // Open an empty reply composer on an existing thread.
  openReply(thread: CommentThread): void;
  cancelDraft(thread: CommentThread): void;
  submit(thread: CommentThread, body: string): Promise<void>;
  edit(thread: CommentThread, comment: Comment, body: string): Promise<void>;
  remove(thread: CommentThread, comment: Comment): Promise<void>;
  react(thread: CommentThread, comment: Comment, content: ReactionContent): Promise<void>;
}

export function createCommentStore(cfg: CommentStoreConfig): CommentStore {
  const { threads, pr, viewerLogin } = cfg;
  const refresh = (path: string): void => cfg.refresh(path);
  const base = `/${pr.owner}/${pr.repo}/pull/${pr.number}/page_data`;

  // Resolve the metadata copy passed by the renderer back to the live entry in
  // `threads`. Annotations are passed to Pierre as fresh shallow copies (so
  // its reference-equality check re-runs renderAnnotation), so the `thread`
  // closures captured inside card buttons no longer point at the live entry.
  const find = (key: string): CommentThread | undefined =>
    threads.find((t) => t.key === key);

  const replaceThread = (key: string, next: CommentThread | null, path: string): void => {
    const i = threads.findIndex((t) => t.key === key);
    if (i >= 0) { if (next) threads[i] = next; else threads.splice(i, 1); }
    else if (next) threads.push(next);
    refresh(path);
  };

  return {
    openDraft(path, range) {
      const line = range.start;
      const side: 'old' | 'new' = range.side === 'deletions' ? 'old' : 'new';
      // One draft per (path,line,side) — stacking just confuses.
      if (threads.some((t) => t.path === path && t.line === line && t.side === side && t.rootCommentId == null)) return;
      threads.push({
        key: `D:${Date.now()}`, path, line, side, resolved: false,
        rootCommentId: null, comments: [], draft: { body: '' },
      });
      refresh(path);
    },
    openReply(thread) {
      const live = find(thread.key); if (!live) return;
      live.draft = { body: '' };
      refresh(live.path);
    },
    cancelDraft(thread) {
      const live = find(thread.key); if (!live) return;
      if (live.rootCommentId == null) replaceThread(live.key, null, live.path);
      else { live.draft = undefined; refresh(live.path); }
    },
    async submit(thread, body) {
      const text = body.trim();
      if (!text) return;
      const live = find(thread.key); if (!live) return;
      const path = live.path;
      let payload: unknown;
      if (live.rootCommentId == null) {
        if (!cfg.commits) { alert('Cannot post: missing commit SHAs from this page.'); return; }
        const side = live.side === 'old' ? 'left' : 'right';
        payload = {
          text, path, line: live.line, side, submitBatch: true, subjectType: 'line',
          comparisonStartOid: cfg.commits.base, comparisonEndOid: cfg.commits.head,
          positioning: {
            type: 'line', baseCommitOid: cfg.commits.base, headCommitOid: cfg.commits.head,
            path, line: live.line, commitOid: cfg.commits.head,
          },
        };
      } else {
        payload = { text, submitBatch: true, inReplyTo: live.rootCommentId, path };
      }
      const r = await gh('POST', `${base}/create_review_comment`, payload);
      const created = toComment(r, viewerLogin);
      if (!created) { alert('Comment failed to post.'); return; }
      if (live.rootCommentId == null) {
        replaceThread(live.key, {
          ...live, key: `T:${created.id}`, rootCommentId: created.id,
          comments: [created], draft: undefined,
        }, path);
      } else {
        live.comments = [...live.comments, created];
        live.draft = undefined;
        refresh(path);
      }
    },
    async edit(thread, comment, body) {
      const text = body.trim();
      if (!text) return;
      const live = find(thread.key); if (!live) return;
      // `body_version` guards against concurrent edits: GitHub computes it as
      // sha256(original_body). We have the original in `comment.body`.
      const version = await sha256(comment.body);
      const r = await gh('PUT', `${base}/update_review_comment?body_version=${version}`, {
        body: text, commentId: String(comment.id),
      });
      const updated = toComment(r, viewerLogin);
      if (!updated) { alert('Edit failed.'); return; }
      live.comments = live.comments.map((c) =>
        c.id === comment.id ? { ...c, body: updated.body, bodyHtml: updated.bodyHtml } : c,
      );
      refresh(live.path);
    },
    async remove(thread, comment) {
      const live = find(thread.key); if (!live) return;
      const r = await gh('DELETE', `${base}/review_comments/${comment.id}`, undefined);
      if (!r.ok) { alert('Delete failed.'); return; }
      const remaining = live.comments.filter((c) => c.id !== comment.id);
      if (remaining.length === 0) replaceThread(live.key, null, live.path);
      else { live.comments = remaining; refresh(live.path); }
    },
    async react(thread, comment, content) {
      const live = find(thread.key); if (!live) return;
      const liveComment = live.comments.find((c) => c.id === comment.id);
      if (!liveComment) return;
      const existing = liveComment.reactions.find((x) => x.content === content);
      const turningOff = !!existing?.viewerReacted;
      const r = await gh(
        'POST',
        `${base}/${turningOff ? 'remove_comment_reaction' : 'add_comment_reaction'}`,
        { reaction: REACTION_API[content], commentId: comment.id },
      );
      if (!r.ok) return;
      if (turningOff && existing) {
        existing.count = Math.max(0, existing.count - 1);
        existing.viewerReacted = false;
        if (existing.count === 0) liveComment.reactions = liveComment.reactions.filter((x) => x !== existing);
      } else if (existing) {
        existing.count += 1;
        existing.viewerReacted = true;
      } else {
        liveComment.reactions = [...liveComment.reactions, { content, count: 1, viewerReacted: true }];
      }
      refresh(live.path);
    },
  };
}

// Same-origin call to one of GitHub's internal `/page_data/*` endpoints. The
// session cookie authorises the request; `X-Fetch-Nonce` is GitHub's CSRF
// protection (read fresh every call — the page can rotate it).
async function gh(method: string, path: string, body: unknown): Promise<{ ok: boolean; data: unknown }> {
  const nonce = document.querySelector('meta[name="fetch-nonce"]')?.getAttribute('content') ?? '';
  try {
    const r = await fetch(path, {
      method, credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'GitHub-Verified-Fetch': 'true',
        'X-Fetch-Nonce': nonce,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: r.ok, data };
  } catch {
    return { ok: false, data: null };
  }
}

// `create_review_comment` and `update_review_comment` return the new/updated
// comment under a top-level `comment` slot, alongside the full thread (which
// also lists the original comments). We MUST prefer the top-level field,
// otherwise the optimistic render shows the original body for new replies.
function toComment(r: { ok: boolean; data: unknown }, viewerLogin: string): Comment | null {
  if (!r.ok || !r.data || typeof r.data !== 'object') return null;
  const root = r.data as { comment?: RawComment };
  const raw = root.comment ?? findCommentLike(r.data);
  if (!raw) return null;
  const id = Number(raw.databaseId ?? raw.id);
  const author = raw.author?.login ?? raw.user?.login;
  if (!Number.isFinite(id) || !author) return null;
  return {
    id,
    author,
    avatarUrl: raw.author?.avatarUrl ?? raw.user?.avatar_url ?? `https://github.com/${author}.png?size=64`,
    createdAt: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
    body: raw.body ?? '',
    bodyHtml: raw.bodyHTML ?? raw.body_html ?? escapeHtml(raw.body ?? ''),
    viewerCanUpdate: raw.viewerCanUpdate ?? (author === viewerLogin),
    viewerCanDelete: raw.viewerCanDelete ?? (author === viewerLogin),
    reactions: [],
  };
}
interface RawComment {
  id?: string | number; databaseId?: number;
  author?: { login?: string; avatarUrl?: string };
  user?: { login?: string; avatar_url?: string };
  body?: string; bodyHTML?: string; body_html?: string;
  createdAt?: string; created_at?: string;
  viewerCanUpdate?: boolean; viewerCanDelete?: boolean;
}
// Fallback walk: used only when the response shape changes and `comment`
// isn't at the top level. Picks the first object that looks like a comment.
function findCommentLike(node: unknown): RawComment | null {
  if (!node || typeof node !== 'object') return null;
  const rec = node as Record<string, unknown>;
  if ((typeof rec.databaseId === 'number' || typeof rec.id !== 'undefined') &&
      (typeof rec.body === 'string' || typeof rec.bodyHTML === 'string') &&
      (rec.author || rec.user)) {
    return rec as RawComment;
  }
  for (const v of Object.values(rec)) {
    const hit = findCommentLike(v);
    if (hit) return hit;
  }
  return null;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ───────────── Card rendering ─────────────

export function renderThreadCard(thread: CommentThread, store: CommentStore): HTMLElement {
  const card = box(
    'margin:8px 12px;max-width:680px;' +
      'background:color-mix(in srgb, var(--bgColor-default,#fff) 96%, transparent);' +
      'border:1px solid var(--borderColor-muted,rgba(127,127,127,0.18));border-radius:14px;' +
      'padding:14px 16px;display:flex;flex-direction:column;gap:14px;' +
      'box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.04);' +
      'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      'color:var(--fgColor-default,#1f2328)',
  );
  thread.comments.forEach((comment, i) =>
    card.append(commentRow(thread, comment, store, i > 0)),
  );
  card.append(draftRow(thread, store));
  return card;
}

function commentRow(
  thread: CommentThread, comment: Comment, store: CommentStore, isReply: boolean,
): HTMLElement {
  // Replies are indented under the thread root, like diffs.com / Linear.
  const row = box(
    `display:flex;gap:10px;align-items:flex-start;${isReply ? 'margin-left:34px' : ''}`,
  );
  row.append(avatar(comment.avatarUrl, comment.author, isReply ? 22 : 28));

  const main = box('flex:1;min-width:0;display:flex;flex-direction:column;gap:6px');

  const head = box('display:flex;align-items:center;gap:8px');
  const author = document.createElement('strong');
  author.textContent = comment.author;
  author.style.cssText = 'font-size:13px;font-weight:600';
  const time = document.createElement('span');
  time.textContent = relativeTime(comment.createdAt);
  time.style.cssText = 'font-size:12px;color:var(--fgColor-muted,#59636e)';
  head.append(author, time);

  // Hover tools: edit + delete, only the owner sees them. Hidden until the
  // pointer is over the comment row to keep the card calm at rest.
  const tools = box('display:flex;gap:2px;margin-left:auto;opacity:0;transition:opacity .12s');
  const showTools = (): void => { tools.style.opacity = '1'; };
  const hideTools = (): void => { tools.style.opacity = '0'; };
  row.addEventListener('mouseenter', showTools);
  row.addEventListener('mouseleave', hideTools);
  row.addEventListener('focusin', showTools);
  row.addEventListener('focusout', hideTools);

  let editing = false;
  const body = box('white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.5');
  body.innerHTML = comment.bodyHtml;

  if (comment.viewerCanUpdate) {
    tools.append(iconBtn('Edit', '✎', () => {
      if (editing) return;
      editing = true;
      const composer = inlineComposer(comment.body, 'Save', async (text) => {
        await store.edit(thread, comment, text);
      }, () => { editing = false; body.style.display = ''; composer.remove(); });
      body.style.display = 'none';
      body.after(composer);
    }));
  }
  if (comment.viewerCanDelete) {
    tools.append(iconBtn('Delete', '✕', () => {
      if (confirm('Delete this comment?')) void store.remove(thread, comment);
    }));
  }
  head.append(tools);

  const reactions = reactionsRow(thread, comment, store);
  main.append(head, body, reactions);
  row.append(main);
  return row;
}

// Footer of the card: composer for a new thread / open reply, otherwise a
// link-style "↳ Add reply…" prompt.
function draftRow(thread: CommentThread, store: CommentStore): HTMLElement {
  const isNew = thread.rootCommentId == null;
  if (isNew || thread.draft != null) {
    return inlineComposer(
      thread.draft?.body ?? '',
      isNew ? 'Comment' : 'Reply',
      async (text) => { await store.submit(thread, text); },
      () => store.cancelDraft(thread),
    );
  }
  const wrap = box('display:flex;gap:14px;align-items:center;margin-left:34px');
  const link = document.createElement('button');
  link.type = 'button';
  link.textContent = '↳ Add reply…';
  link.style.cssText =
    'background:transparent;border:0;padding:0;cursor:pointer;font:inherit;' +
    'color:var(--fgColor-accent,#0969da);font-weight:500';
  link.addEventListener('click', () => store.openReply(thread));
  wrap.append(link);
  return wrap;
}

function inlineComposer(
  initial: string, submitLabel: string,
  onSubmit: (text: string) => Promise<void>,
  onCancel?: () => void,
): HTMLElement {
  const wrap = box('display:flex;flex-direction:column;gap:6px');
  const ta = document.createElement('textarea');
  ta.value = initial;
  ta.placeholder = 'Add a comment…';
  ta.rows = 2;
  ta.style.cssText =
    'width:100%;box-sizing:border-box;padding:8px 10px;font:inherit;' +
    'border:1px solid rgba(0,0,0,0.15);border-radius:8px;background:var(--bgColor-default,#fff);' +
    'color:inherit;resize:vertical;outline:none';
  ta.addEventListener('focus', () => { ta.style.borderColor = '#0969da'; });
  ta.addEventListener('blur', () => { ta.style.borderColor = 'rgba(0,0,0,0.15)'; });
  const actions = box('display:flex;justify-content:flex-end;gap:6px');
  if (onCancel) actions.append(textBtn('Cancel', onCancel));
  const submit = primaryBtn(submitLabel);
  let busy = false;
  const run = async (): Promise<void> => {
    if (busy || !ta.value.trim()) return;
    busy = true; submit.disabled = true; submit.textContent = '…';
    try { await onSubmit(ta.value); }
    finally { busy = false; submit.disabled = false; submit.textContent = submitLabel; }
  };
  submit.addEventListener('click', () => void run());
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void run(); }
    if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel(); }
  });
  actions.append(submit);
  wrap.append(ta, actions);
  requestAnimationFrame(() => ta.focus());
  return wrap;
}

function reactionsRow(thread: CommentThread, comment: Comment, store: CommentStore): HTMLElement {
  const row = box('display:flex;gap:6px;flex-wrap:wrap;align-items:center;min-height:22px');
  for (const r of comment.reactions) row.append(reactionChip(thread, comment, r, store));
  row.append(reactionPicker(thread, comment, store));
  return row;
}

function reactionChip(thread: CommentThread, comment: Comment, r: Reaction, store: CommentStore): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = `${REACTION_EMOJI[r.content]} ${r.count}`;
  b.title = r.viewerReacted ? 'Remove your reaction' : `React with ${r.content}`;
  b.style.cssText =
    'display:inline-flex;align-items:center;gap:4px;padding:1px 8px;font:12px/1.6 inherit;' +
    'border-radius:999px;cursor:pointer;' +
    (r.viewerReacted
      ? 'background:color-mix(in srgb, var(--fgColor-accent,#0969da) 12%, transparent);' +
        'border:1px solid color-mix(in srgb, var(--fgColor-accent,#0969da) 45%, transparent);' +
        'color:var(--fgColor-accent,#0969da)'
      : 'background:color-mix(in srgb, currentColor 6%, transparent);' +
        'border:1px solid color-mix(in srgb, currentColor 12%, transparent);color:inherit');
  b.addEventListener('click', () => void store.react(thread, comment, r.content));
  return b;
}

// Tracks the picker currently open so any outside click closes it. A single
// capture-phase document listener handles every picker — without this each
// rendered card would leak its own document listener on refresh.
let openPicker: { wrap: HTMLElement; close: () => void } | null = null;
document.addEventListener('click', (e) => {
  const p = openPicker;
  if (p && !p.wrap.contains(e.target as Node)) p.close();
}, true);

function reactionPicker(thread: CommentThread, comment: Comment, store: CommentStore): HTMLElement {
  const wrap = box('position:relative;display:inline-flex');
  const pop = box(
    'display:none;position:absolute;left:0;top:calc(100% + 6px);z-index:5;' +
      'flex-direction:row;flex-wrap:nowrap;gap:2px;padding:4px 6px;' +
      'background:var(--bgColor-default,#fff);' +
      'border:1px solid color-mix(in srgb, currentColor 14%, transparent);border-radius:999px;' +
      'box-shadow:0 4px 14px rgba(0,0,0,0.12);white-space:nowrap',
  );
  const close = (): void => {
    pop.style.display = 'none';
    if (openPicker?.wrap === wrap) openPicker = null;
  };
  const open = (): void => {
    openPicker?.close();
    pop.style.display = 'flex';
    openPicker = { wrap, close };
  };
  const btn = iconBtn('Add reaction', '☺', () => {
    if (pop.style.display === 'flex') close(); else open();
  });
  for (const c of Object.keys(REACTION_EMOJI) as ReactionContent[]) {
    const e = document.createElement('button');
    e.type = 'button';
    e.textContent = REACTION_EMOJI[c];
    e.title = c;
    e.style.cssText =
      'border:0;background:transparent;cursor:pointer;font-size:16px;padding:4px 6px;' +
      'border-radius:999px;line-height:1';
    e.addEventListener('mouseover', () => { e.style.background = 'color-mix(in srgb, currentColor 10%, transparent)'; });
    e.addEventListener('mouseout', () => { e.style.background = 'transparent'; });
    e.addEventListener('click', () => { close(); void store.react(thread, comment, c); });
    pop.append(e);
  }
  wrap.append(btn, pop);
  return wrap;
}

function avatar(url: string, alt: string, size = 28): HTMLElement {
  const img = document.createElement('img');
  img.src = url;
  img.alt = alt;
  img.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;flex:none;object-fit:cover`;
  return img;
}

function iconBtn(label: string, glyph: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.textContent = glyph;
  b.style.cssText =
    'background:transparent;border:0;padding:3px 6px;cursor:pointer;border-radius:6px;' +
    'color:var(--fgColor-muted,#59636e);font-size:13px;line-height:1';
  b.addEventListener('mouseover', () => { b.style.background = 'color-mix(in srgb, currentColor 10%, transparent)'; });
  b.addEventListener('mouseout', () => { b.style.background = 'transparent'; });
  b.addEventListener('click', onClick);
  return b;
}

function textBtn(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.style.cssText =
    'padding:4px 10px;font:inherit;border-radius:6px;cursor:pointer;background:transparent;' +
    'border:1px solid rgba(0,0,0,0.15);color:inherit';
  b.addEventListener('click', onClick);
  return b;
}

function primaryBtn(text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.style.cssText =
    'padding:4px 12px;font:inherit;border-radius:999px;cursor:pointer;border:0;' +
    'background:#0969da;color:#fff;font-weight:500';
  return b;
}

function relativeTime(iso: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML.replace(/\n/g, '<br>');
}
