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

**Screenshots**

<table>
  <tr>
    <td width="50%">
      <b>Tree-of-diffs PR view</b><br/>
      It replaces Github's flat file list, with per-file "Viewed" and collapsible context
    </td>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/11ca4c4a-1e04-4b75-9cff-e312e4301458" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <b>Unified / split toggle</b><br/>
      Flip between layouts without leaving the page, including default Github. Inline comments and line selection work the same as native GitHub. It also includes the file search and navigation
    </td>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/30a94a0f-6be7-4984-b984-49db7f78c231" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <b>Comments and reactions</b><br/>
      Same as Github defaults
    </td>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/bffb613b-4241-4586-a08e-e6415d32c699" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <b>Tree in code browser</b>
      Also replaces the default Github tree and has instant navigation!
    </td>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/36ad0a82-9230-4c52-8108-1a8f97711ac5" />
    </td>
  </tr>
</table>

**Video demo**

https://github.com/user-attachments/assets/5b2acdd3-94e4-4406-acf8-36993558766a
