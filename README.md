# Pierre for GitHub

A Chrome + Firefox MV3 extension that replaces GitHub's diff and file-tree UI with
[Pierre](https://pierre.computer)'s components ([`@pierre/diffs`](https://diffs.com),
[`@pierre/trees`](https://trees.software)) to get the diffshub.com feel onto github.com.

**How it works.** A document-start content script detects the surface (PR / commit /
compare / code browser), hides GitHub's diff and tree, and hands the data to a
main-world renderer that mounts Pierre in their place. The `.diff` is fetched through
a background worker so private repos work via the session cookie. A toggle bar at
the top flips between Pierre and GitHub.

**Features.** Tree-of-diffs PR view, code-browser file tree, expand-unchanged context,
unified/split toggle, Pierre/Github view, per-file "Viewed" to collapse, inline
comments, line selection, GitHub light/dark theme, large PR support

**Build.** Requires [Bun](https://bun.sh): `bun install && bun run build` → `dist/chrome-mv3`. Firefox: `bun run build:firefox`.

**Video demo**

https://github.com/user-attachments/assets/5b2acdd3-94e4-4406-acf8-36993558766a
