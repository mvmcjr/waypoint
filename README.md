# Waypoint

A Git GUI desktop application with a visual commit timeline. Built with Tauri 2, React 19, and TypeScript. No account, no telemetry, no paywall: it talks only to your local repositories and the remotes you already have configured.

## Features

**History**
- Visual commit graph with lane-based layout; the full history loads, with no commit cap
- Go to commit: search by message, author, email, hash, or branch/tag and step through matches in place
- "Check if in branch…" on any commit
- Stashes shown as rows on the timeline, plus a pinned WIP row for uncommitted changes

**Staging and committing**
- Stage or unstage by folder, file, hunk, or single line
- Commit, amend (with a warning when the commit is already pushed), and edit the message of any commit
- Discard changes per file, per folder, or everything

**Branches and history editing**
- Create, rename, delete, and check out branches (including detached and remote branches)
- Merge, rebase, cherry-pick, revert, soft/mixed/hard reset, and squash a selected range with a preview
- Conflict resolver: per hunk, take ours, theirs, both, or pick individual lines, in a stacked or side-by-side view

**Remotes**
- Fetch, pull, and push from the toolbar, with a force-push offer when a push is rejected
- Push and delete remote tags; rename a branch locally and on the remote
- Remote operations run through your system `git`, so credential helpers and SSH agents work as they do in your terminal

**Tags and stashes**
- Annotated and lightweight tags
- Named stashes; pop, apply, drop, and rename

**Everything else**
- Diff viewer: unified or split, hunks or full file, keyboard navigation between files
- Multiple repos as tabs, recent repos on the welcome screen, and a folder scan to find repos
- Offers `git init` when you open a folder that isn't a repository
- Refreshes live when files change outside the app
- Command palette (Ctrl/Cmd+Shift+P)
- `waypoint .` terminal command (enable in Settings → Integrations) and, on Windows, an "Open in Waypoint" Explorer context menu
- **Plugins**: add your own commands to the palette, context menus, and toolbar
- Dark theme

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl/Cmd+Shift+P | Command palette |
| Ctrl/Cmd+F | Go to commit |
| Enter / Shift+Enter, F3 / Ctrl+G | Next / previous match |
| Ctrl/Cmd+Enter | Commit |
| `[` / `]` or Alt+↑ / Alt+↓ | Previous / next file in a diff |
| Esc | Close the diff |

## Plugins

Plugins are small JavaScript packages (local folders or GitHub repos) that add custom commands to the command palette, commit/branch context menus, and the toolbar. For example, a one-click "create the next release branch" for your team's workflow.

See **[docs/plugins.md](docs/plugins.md)** for the manifest schema, the full `api` reference, and how-tos. A ready-to-copy starting point lives in **[`example-plugin/`](example-plugin)**.

## Download

Pre-built installers are attached to each [release](../../releases):

| Platform | Format |
|---|---|
| macOS (Apple Silicon + Intel) | `.dmg` (universal binary) |
| Linux (x64, glibc 2.35+) | `.AppImage` (portable), `.deb` (Debian/Ubuntu), or `.rpm` (Fedora/openSUSE) |
| Windows (x64) | `.msi` (recommended; includes the Explorer context menu) or `.exe` (NSIS) |

Builds are currently **not code-signed**:
- **macOS** reports the app as damaged. After copying it to Applications, run `xattr -dr com.apple.quarantine /Applications/Waypoint.app`.
- **Windows** SmartScreen may warn on first launch. Choose "More info" → "Run anyway".

`git` must be on your `PATH` for fetch, pull, and push.

## Known limitations

- No clone yet: clone in a terminal, then open the folder.
- Commits are created through libgit2, so commit signing (GPG/SSH) and git hooks are not applied.
- Stashes don't include untracked files.
- Waypoint fetches from your remotes in the background: when a repo opens, every 5 minutes, and when the window regains focus.
- Dark theme only.

## Development

**Prerequisites (all platforms):** Rust stable ([rustup](https://rustup.rs)), Node.js 22.13+, pnpm 10, and `git`.

- **Windows:** Visual Studio C++ Build Tools ("Desktop development with C++"), the MSVC Rust toolchain, and a native Perl such as [Strawberry Perl](https://strawberryperl.com) (OpenSSL is built from source; Git Bash's Perl won't work).
- **macOS:** Xcode Command Line Tools (`xcode-select --install`).
- **Linux (Debian/Ubuntu):** `sudo apt install build-essential file perl libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf pkg-config`

```bash
pnpm install          # install dependencies
pnpm tauri dev        # run the app with hot reload
pnpm test run         # frontend tests (Vitest)
cd src-tauri && cargo test   # backend tests
pnpm tauri build      # production build + installers
```

For a universal macOS build: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`, then `pnpm tauri build --target universal-apple-darwin`.

After changing dependencies, regenerate the bundled license notices with `pnpm notices`.

### Tech stack

- **Frontend:** React 19, TypeScript, Tailwind CSS v4, Zustand, TanStack Query, [shadcn/ui](https://ui.shadcn.com) components
- **Desktop:** Tauri 2, with a Rust backend using libgit2 (`git2` crate) for local operations
- **Build:** Vite, pnpm

## Releasing

Push a version tag to trigger the release workflow:

```bash
git tag v1.2.3
git push origin v1.2.3
```

GitHub Actions builds macOS (universal), Linux, and Windows installers and attaches them to a draft GitHub Release with a generated changelog. Tags with a hyphen (e.g. `v1.3.0-beta.1`) are marked as pre-releases.

macOS signing and notarization turn on when the `APPLE_*` secrets are set and are skipped otherwise. Windows code signing is not set up.

## License

[MIT](LICENSE). Waypoint bundles third-party software under its own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
