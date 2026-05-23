/**
 * Background worker. Sole job: fetch URLs that 302 cross-origin (a PR's
 * `.diff` and raw blobs redirect to hosts a content script can't read).
 * Carries credentials so private repos work.
 */
import { defineBackground, browser } from '#imports';

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const msg = message as { kind?: string; url?: string } | null;
    if (msg?.kind !== 'fetch-diff' || typeof msg.url !== 'string') return false;

    fetch(msg.url, { credentials: 'include' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((text) => sendResponse({ ok: true, text }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true; // keep the message channel open for the async response
  });
});
