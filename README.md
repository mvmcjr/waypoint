# Waypoint

A Git GUI desktop application with a visual commit timeline. Built with Tauri 2, React 19, and TypeScript — no account required, runs entirely locally.

## Features

- Visual commit graph with branching, merging, and lane-based layout
- Staging panel with per-file and per-hunk control
- Inline conflict resolver (ours/theirs per file)
- Branch, tag, and stash management
- Cherry-pick, rebase, and reset operations
- Context menus on commits for common Git actions
- Multi-repo tabs
- Recent repos on the welcome screen
- Dark theme

## Download

Pre-built binaries are published automatically on every version tag via GitHub Actions:

| Platform | Format |
|---|---|
| macOS (Apple Silicon + Intel) | `.dmg` (universal binary) |
| Linux | `.AppImage` (portable) or `.deb` (Debian/Ubuntu) |
| Windows | `.msi` (recommended) or `.exe` (NSIS) |

Find the latest release on the [Releases](../../releases) page.

### macOS install note

Waypoint is a free open-source project and is **not signed with a paid Apple Developer ID**, so macOS marks it as coming from an "unidentified developer." The build is ad-hoc signed, which prevents the app from launching to a dock icon with no window, but Gatekeeper still blocks the first launch.

To open it the first time, either:

- **Right-click** `Waypoint.app` in Finder → **Open** → confirm in the dialog, or
- if the app still won't start, strip the quarantine flag in Terminal:

  ```bash
  xattr -dr com.apple.quarantine /Applications/Waypoint.app
  ```

After the first successful launch, macOS remembers the choice and opens it normally.

#### Updating an existing install

Updating in place over a still-running (or admin-owned) copy can leave the app wedged — it launches to a dock icon with no window. To update cleanly:

1. **Quit Waypoint fully** (Cmd-Q) before installing the new version.
2. Drag the new `Waypoint.app` over the old one in `/Applications`, replacing it.
3. If it still won't open, **delete `/Applications/Waypoint.app`, restart the Mac, then install fresh**. On a managed/non-admin Mac, install from the admin account.



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

macOS builds support optional Developer ID code signing and notarization via Apple secrets; when those secrets are absent the build is **ad-hoc signed** (`signingIdentity: "-"`) so it still launches correctly without a paid Apple account. Windows builds support optional signing via a PFX certificate, skipped gracefully when absent.
