import { defineConfig } from 'wxt';
import { shikiCurate } from './scripts/shiki-curate';

// Cross-browser MV3 extension. No `action` entry => no toolbar icon (discreet).
// `imports: false` => no auto-import magic; every import is explicit.
export default defineConfig({
  // Manifest V3 on every browser, including Firefox (121+).
  manifestVersion: 3,
  outDir: 'dist',
  imports: false,
  // The extension collects no data, so there is nothing to declare to Firefox.
  suppressWarnings: { firefoxDataCollection: true },
  vite: () => ({
    // Trim Shiki's ~350 bundled grammars down to the ones GitHub diffs use.
    plugins: [shikiCurate()],
  }),
  manifest: {
    name: 'Pierre for GitHub',
    description: "Replace GitHub's diffs and file trees with Pierre's components.",
    // Only `storage` is needed: the toggle state. Diff/tree data is fetched
    // same-origin from github.com by the content script, which needs no permission.
    permissions: ['storage'],
    // The background worker fetches a PR's `.diff` and changed files' text from
    // github.com (with credentials, for private repos); those 302 to the
    // patch-diff / raw user-content hosts.
    host_permissions: [
      '*://github.com/*',
      '*://patch-diff.githubusercontent.com/*',
      '*://raw.githubusercontent.com/*',
    ],
    // The orchestrator injects renderer.js into the page's main world.
    web_accessible_resources: [{ resources: ['renderer.js'], matches: ['*://github.com/*'] }],
    browser_specific_settings: {
      gecko: {
        id: 'github-pierre@pierre.computer',
        strict_min_version: '121.0',
      },
    },
  },
});
