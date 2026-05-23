/**
 * Shiki grammars bundled for GitHub diffs. The build curates Shiki's ~350
 * grammars down to this set (scripts/shiki-curate.ts); files in any other
 * language render as plain text — a missing grammar would otherwise throw.
 * Keys are Shiki language ids; values are alias keys for the same grammar.
 */
export const LANGUAGES: Record<string, readonly string[]> = {
  typescript: ['ts'], tsx: [], javascript: ['js'], jsx: [], json: ['jsonl'],
  jsonc: [], json5: [], yaml: ['yml'], toml: [], html: [], css: [], scss: [],
  sass: [], less: [], markdown: ['md'], mdx: [], python: ['py'], go: [],
  rust: ['rs'], zig: [], odin: [], java: [], kotlin: ['kt', 'kts'], scala: [],
  c: [], cpp: ['c++'], csharp: ['c#', 'cs'], 'objective-c': ['objc'], swift: [],
  ruby: ['rb'], php: [], perl: [], lua: [], r: [], dart: [], elixir: [],
  erlang: [], haskell: ['hs'], clojure: ['clj'], nix: [],
  shellscript: ['sh', 'bash', 'zsh', 'shell'], powershell: ['ps', 'ps1'],
  bat: ['batch'], docker: ['dockerfile'], make: ['makefile'], cmake: [],
  xml: [], sql: [], graphql: ['gql'], proto: ['protobuf'],
  hcl: ['terraform', 'tf'], vue: [], svelte: [], astro: [],
  ini: ['properties'], diff: [], prisma: [],
};

export const KNOWN_LANGS: ReadonlySet<string> = new Set(
  Object.entries(LANGUAGES).flatMap(([id, aliases]) => [id, ...aliases]),
);
