# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Desktop app for macOS, Windows, and Linux, delivered as a Tauri 2 webview. The interface is its own design language, not per-OS native chrome, so `web` applies. OS-level integrations still exist: native file/folder pickers, the Windows Explorer "Open in Waypoint" context menu, and a `waypoint` CLI shim (`waypoint .`).

## Users

Professional developers who use Waypoint as their daily Git client on real team repositories. It sits open all day next to their editor and terminal, and it replaces whatever desktop Git client they used before. Their jobs: read history and branch topology at a glance, stage and commit carefully (down to hunks and lines), move work between branches (merge, rebase, cherry-pick, squash, revert), resolve conflicts, and sync with remotes, all without breaking their flow.

## Product Purpose

Waypoint is a Git GUI built around a visual commit timeline. It makes the repository's shape legible (lanes, merges, refs, stashes, the dirty working tree) and makes the operations that change that shape direct and safe to perform. Success means a working developer reaches for Waypoint instead of a paid or account-bound client for every Git task in their day, and trusts it with real repos.

## Positioning

- **No account, fully local.** No sign-in, no cloud service, no telemetry, no paywall. The app talks only to the local repository and the remotes the user already has configured.
- **Plugins for team workflow.** Teams add their own commands (for example "create the next release branch") to the command palette, commit and branch context menus, and toolbar through small JavaScript plugins loaded from a local folder or a GitHub repo.
- **Fast, light, cross-platform.** Tauri with a Rust and libgit2 backend: a small binary, no commit cap on large histories, and the same app on macOS, Windows, and Linux.

## Operating Context

- Runs alongside an editor and a terminal; the file watcher picks up edits made outside the app, so status stays current.
- Multiple repositories open at once as tabs; recent repos are listed on the welcome screen.
- Launched from a folder picker, a recent-repo list, the terminal (`waypoint .`), or Windows Explorer's context menu.
- Remote operations (fetch, pull, push, tag push, remote branch rename) shell out to the system `git` binary, so the user's existing credential helpers and SSH agent behave exactly as they do in the terminal.
- Ctrl/Cmd+Shift+P toggles the command palette while the window has focus.

## Capabilities and Constraints

**Shipped capabilities:** visual commit graph with lane layout, virtualized to handle large histories; per-file, per-hunk, and per-line staging; commit and amend, plus editing the message of an unpushed commit; inline conflict resolver (ours/theirs per file, then finish); checkout, branch create/rename (local and remote), reset, rebase, squash, cherry-pick, revert (including merge commits); tags (create, delete, push, delete remote); stashes (named push, pop, apply, drop, rename), shown as special rows on the timeline; discard all (including untracked files); a pinned WIP row for the dirty working tree; support for new and commit-less repositories; command palette; settings; plugin install and management.

**Technical constraints:** Tauri 2 + React 19 + TypeScript frontend; Rust backend using `git2` for local operations and the system `git` binary for remote ones. Plugins run in a Web Worker sandbox for crash and hang isolation only. They are trusted code, not a security boundary. Base UI components are generated through the shadcn CLI, never hand-written.

**Terminology:** repo, tab, timeline, lane, ref, HEAD, WIP row, stash, plugin, command palette, surfaces (`commandPalette`, `commitContextMenu`, `branchContextMenu`, `toolbar`).

**License:** MIT (`LICENSE`). Third-party notices for everything the installers ship live in `THIRD_PARTY_NOTICES.md`.

## Brand Commitments

- Name: **Waypoint**.
- Existing tagline on the welcome screen: "A local Git GUI, no account required."
- App icon: `public/waypoint-icon.svg` (with platform icon exports in `src-tauri/icons/`).

## Evidence on Hand

- `README.md`: feature list, download matrix, release process.
- `docs/plugins.md`: plugin manifest schema, `api` reference, how-tos. `example-plugin/`: a ready-to-copy plugin.
- `docs/timeline.md`: technical reference for the timeline and lane allocator.
- `DESIGN.md`: the incumbent visual system ("The Night Chart") as currently documented.
- `.github/workflows/release.yml`: tagged releases build installers for macOS (universal `.dmg`), Linux (`.AppImage`, `.deb`), and Windows (`.msi`, NSIS `.exe`) as draft GitHub Releases with a changelog.

**Absent, so never fabricate:** user counts, testimonials, reviews, press, performance benchmarks, product screenshots, and any claim about code signing being active (signing is optional and skipped when secrets are absent).

## Product Principles

1. **Local and account-free, always.** Never add sign-in, cloud dependencies, telemetry, or anything that needs the network beyond the user's own git remotes.
2. **Free forever.** Public and open source with no monetization. No paid tiers, upsells, gated features, or "pro" framing.
3. **A daily driver for professionals.** Optimize for someone who knows Git and uses the app all day on real repos: density, speed, and accuracy over hand-holding.
4. **Extensible over bespoke.** Team-specific workflow belongs in plugins; the core stays general-purpose Git.
5. **Lean and cross-platform.** Stay fast on large histories and behave the same on macOS, Windows, and Linux.
