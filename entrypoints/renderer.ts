/**
 * Renderer — main-world script injected by the orchestrator. Owns no lifecycle:
 * just turns each message into a Pierre view. Pierre's custom elements only
 * work here (isolated worlds have no customElements).
 */
import { defineUnlistedScript } from '#imports';
import { onRendererMessage, sendToOrchestrator } from '../src/protocol';
import { renderDiff, renderTree, type RenderHandle } from '../src/views';

export default defineUnlistedScript(() => {
  let active: RenderHandle | null = null;

  onRendererMessage((msg) => {
    if (msg.kind === 'theme') {
      active?.setTheme(msg.theme);
      return;
    }
    if (msg.kind === 'hide') {
      active?.teardown();
      active = null;
      return;
    }
    if (msg.kind === 'contents') {
      active?.addContents?.(msg.contents);
      return;
    }
    if (msg.kind === 'diff-style') {
      active?.setDiffStyle?.(msg.style);
      return;
    }

    const mount = document.querySelector('.gh-pierre-mount');
    if (!mount) {
      sendToOrchestrator({ kind: 'rendered', ok: false, error: 'mount element missing' });
      return;
    }
    try {
      active?.teardown();
      active =
        msg.kind === 'diff'
          ? renderDiff(mount, {
              surface: msg.surface,
              diff: msg.diff,
              theme: msg.theme,
              comments: msg.comments,
              contents: msg.contents,
              commits: msg.commits,
            })
          : renderTree(mount, {
              owner: msg.surface.owner,
              repo: msg.surface.repo,
              paths: msg.paths,
              activePath: msg.activePath,
            });
      sendToOrchestrator({ kind: 'rendered', ok: true });
    } catch (err) {
      active = null;
      sendToOrchestrator({ kind: 'rendered', ok: false, error: String(err) });
    }
  });
});
