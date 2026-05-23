/**
 * Orchestrator-side fetches: PR `.diff`, tree-list, and raw blobs for context
 * expansion. Anything that 302s cross-origin routes through the background
 * worker so the session cookie carries to the redirect target (private repos).
 */
import { browser } from '#imports';
import { type Surface, diffUrl } from './surfaces';
import { embeddedRoute } from './comments';
import type { FileTexts } from './protocol';

// Files bigger than this skip context-fetching — rarely expanded, expensive.
const RAW_LINE_CAP = 6000;
// PRs with more files than this skip context-fetching: thousands of `raw`
// requests would hammer the server.
const MAX_CONTEXT_FILES = 100;

// 2-minute timeout: huge PRs serve multi-MB diffs and need the headroom, but
// a stuck request shouldn't hang the caller forever.
async function fetchViaWorker(url: string): Promise<string> {
  const reply = browser.runtime.sendMessage({ kind: 'fetch-diff', url });
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error('fetch timed out')), 120000),
  );
  const res = (await Promise.race([reply, timeout])) as
    | { ok: true; text: string } | { ok: false; error: string } | undefined;
  if (!res?.ok) throw new Error(res?.error ?? 'fetch failed');
  return res.text;
}

export async function fetchDiff(s: Surface): Promise<string> {
  const url = diffUrl(s);
  // A PR's `.diff` 302s to the patch-diff host; commit/compare serve it inline.
  if (s.kind === 'pr') return fetchViaWorker(url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  return r.text();
}

// Blob ids come from the embedded data; binary, too-big and pure add/delete
// files are skipped — we just can't expand them.
export async function fetchFileContents(s: Surface): Promise<FileTexts> {
  const contents = embeddedRoute()?.diffContents;
  if (!Array.isArray(contents) || contents.length > MAX_CONTEXT_FILES) return {};
  const raw = (oid: string, path: string) =>
    fetchViaWorker(`${location.origin}/${s.owner}/${s.repo}/raw/${oid}/${path}`);

  const jobs: Promise<[string, { old: string; new: string }]>[] = [];
  for (const d of contents) {
    const oldOid = d.oldCommitOid;
    const newOid = d.newCommitOid;
    const oldPath = d.oldTreeEntry?.path;
    const newPath = d.newTreeEntry?.path;
    if (d.isBinary || d.isTooBig || !oldOid || !newOid || !oldPath || !newPath) continue;
    if ((d.newTreeEntry?.lineCount ?? 0) > RAW_LINE_CAP) continue;
    jobs.push(
      Promise.all([raw(oldOid, oldPath), raw(newOid, newPath)]).then(
        ([oldText, newText]) => [d.path, { old: oldText, new: newText }],
      ),
    );
  }
  const out: FileTexts = {};
  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === 'fulfilled') out[r.value[0]] = r.value[1];
  }
  return out;
}

export async function fetchTreePaths(s: Surface): Promise<string[]> {
  const sha = readCommitSha();
  if (!sha) throw new Error('could not resolve the commit SHA from the page');
  const r = await fetch(`/${s.owner}/${s.repo}/tree-list/${sha}`, {
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching tree-list`);
  const data = (await r.json()) as { paths?: unknown };
  return Array.isArray(data.paths) ? (data.paths.filter((p) => typeof p === 'string') as string[]) : [];
}

// The file or directory path currently open in the code browser.
export function activePath(): string | null {
  const m = /^\/[^/]+\/[^/]+\/(?:blob|tree)\/[^/]+\/(.+)$/.exec(location.pathname);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

// `tree-list` needs the SHA, not a branch name. GitHub embeds it as
// `currentOid` somewhere in a react-app payload — search recursively.
function readCommitSha(): string | null {
  const isSha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
  const find = (node: unknown): string | null => {
    if (!node || typeof node !== 'object') return null;
    const record = node as Record<string, unknown>;
    if (isSha(record.currentOid)) return record.currentOid;
    for (const value of Object.values(record)) {
      const hit = find(value);
      if (hit) return hit;
    }
    return null;
  };
  for (const el of document.querySelectorAll('script[data-target="react-app.embeddedData"]')) {
    try {
      const hit = find(JSON.parse(el.textContent ?? '{}'));
      if (hit) return hit;
    } catch { /**/ }
  }
  return null;
}
