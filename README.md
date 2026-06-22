# Waypoint

A Git GUI desktop application with a visual commit timeline. Built with Tauri 2, React 19, and TypeScript — no account required, runs entirely locally.

## Features

- Visual commit graph with branching, merging, and lane-based layout
- Staging panel with per-file and per-hunk control
- Inline conflict resolver (ours/theirs per file)
- Branch, tag, and stash management
- Cherry-pick, rebase, squash, and reset operations
- Context menus on commits for common Git actions
- Multi-repo tabs
- Recent repos on the welcome screen
- **Extensible via plugins** — add custom commands to the palette, context menus, and toolbar
- Dark theme

## Plugins

Waypoint is extensible. Plugins are small JavaScript packages (local folders or
GitHub repos) that add custom commands to the command palette, commit/branch
context menus, and the toolbar — e.g. a one-click "create the next release
branch" for your team's workflow.

See **[docs/plugins.md](docs/plugins.md)** for the manifest schema, the full
`api` reference, and how-tos. A ready-to-copy starting point lives in
**[`example-plugin/`](example-plugin)**.

## Download

Pre-built binaries are published automatically on every version tag via GitHub Actions:

| Platform | Format |
|---|---|
| macOS (Apple Silicon + Intel) | `.dmg` (universal binary) |
| Linux | `.AppImage` (portable) or `.deb` (Debian/Ubuntu) |
| Windows | `.msi` (recommended) or `.exe` (NSIS) |

Find the latest release on the [Releases](../../releases) page.

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Zustand, TanStack React Query
- **Desktop**: Tauri 2 (Rust backend via libgit2/git2 crate)
- **Build**: Vite, pnpm

## Development

**Prerequisites**: Rust toolchain, Node.js 22+, pnpm 10+

```bash
# Install dependencies
pnpm install

# Run in development (Tauri + Vite hot-reload)
tauri dev

# Type-check
tsc

# Production build
tauri build
```

## Releasing

Push a version tag to trigger the release workflow:

```bash
git tag v1.2.3
git push origin v1.2.3
```

GitHub Actions builds for macOS (universal), Linux, and Windows, then creates a draft GitHub Release with all installers attached. Tags containing a hyphen (e.g. `v1.0.0-beta.1`) are marked as pre-releases automatically.

macOS builds support optional code signing and notarization via Apple secrets. Windows builds support optional signing via a PFX certificate. Both are skipped gracefully when the secrets are absent.
