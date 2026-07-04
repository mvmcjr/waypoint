# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Waypoint** is a Git GUI desktop application built with Tauri + React + TypeScript. It provides a visual timeline of commits with support for branching, merging, rebasing, cherry-picking, staging, stashing, and conflict resolution. The application requires no account and runs entirely locally.

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS (v4), Base UI components
- **Desktop Framework**: Tauri 2 (Rust backend, web frontend)
- **State Management**: Zustand (app state), TanStack React Query (async data)
- **UI Components**: Custom shadcn-based components, Lucide React icons
- **Build Tool**: Vite
- **Backend**: Rust with git2 library for Git operations
- **Styling**: Tailwind CSS with custom theme variables (OKLCh color space)

## Build & Development Commands

```bash
# Development
pnpm dev                    # Start Vite dev server (frontend only)
tauri dev                   # Run full dev app (starts Tauri + frontend)

# Production
pnpm build                  # Build frontend (TypeScript compilation + Vite)
tauri build                 # Build production desktop app (frontend + Rust backend)

# Preview
pnpm preview                # Preview production build

# Type checking
tsc                         # Type check (called as part of build)

# Frontend tests (Vitest + Testing Library, jsdom environment)
pnpm test                   # Watch mode
pnpm test run               # Single run (CI mode)
pnpm test run src/lib/store.test.ts   # Single file
pnpm test -- -t "test name"           # Single test by name

# Backend tests (Rust)
cd src-tauri && cargo test   # Run all Rust unit tests

# Fixture repos used by some tests (generates throwaway git repos under scripts/fixtures/repos/)
pnpm fixtures
```

**Note**: The `package.json` scripts are minimal—use the `tauri` CLI directly for development and building. Tauri orchestrates both Rust and frontend builds via `beforeDevCommand` and `beforeBuildCommand` hooks in `tauri.conf.json`. Test config lives in `vitest.config.ts` (separate from `vite.config.ts`), which sets `environment: "jsdom"`, `globals: true`, and excludes `scripts/fixtures/**` (those fixture repos ship their own unrelated `*.test.js` files).

## Architecture Overview

### Frontend (React/TypeScript)

**Key Directories**:
- `src/` - Main React application
  - `components/` - UI components organized by feature:
    - `timeline/` - Commit graph visualization with virtualized scrolling
    - `sidebar/` - Ref tree (branches, tags) and stash list
    - `staging/` - Working directory changes, staging panel, conflict resolver
    - `detail/` - Commit details and file diffs
    - `ui/` - Base UI components (buttons, dialogs, etc.) — generated via shadcn CLI, not hand-written (see below)
    - `actions/` - Action dialogs (checkout, reset, merge, rebase, cherry-pick, etc.)
    - `plugins/` - UI for the plugin system: input-collection dialog, sandboxed command runner provider, settings/install panel
    - `tabs/` - Tab bar for multiple open repos
    - `CommandPalette.tsx`, `SettingsDialog.tsx` - top-level command palette and app settings, mounted from `App.tsx`
  - `lib/` - Core utilities:
    - `store.ts` - Zustand store for app state (tabs, selected commit, search filter)
    - `ipc.ts` - IPC interface definitions and Tauri `invoke` wrappers for Rust commands
    - `queries.ts` - React Query hooks for server state (commits, refs, diffs, status)
  - `routes/` - Page-level components:
    - `welcome.tsx` - Initial screen with repo picker and recent repos
    - `repo.tsx` - Main repo view (orchestrates timeline, sidebar, staging, dialogs)

**State Management**:
- **App State** (Zustand in `store.ts`): Tabs (open repos), active tab, selected commit OID, search filter
- **Server State** (React Query in `queries.ts`): Commits with graph layout, refs, file diffs, repo status, stashes, merge status
- **Query Keys**: Using combined keys like `["commits", repoId]`, `["diff", repoId, oid]` for cache invalidation
- **Refetch Strategy**: Commits are cached (staleTime: Infinity), but working directory status polls every 2–3 seconds; file diffs are never stale

**Data Flow**:
1. User opens a repo → `ipc.openRepo()` returns a `repoId`
2. Tab opens with `repoId` set as active
3. `RepoView` triggers `useCommits(repoId)` → fetches positioned commits from backend
4. Timeline renders virtualized commit rows with graph visualization
5. User clicks commit → sets `selectedOid` in store → side panel renders commit details
6. User stages files, commits, etc. → `useRefreshRepo()` invalidates query cache → data refetches

**UI Patterns**:
- Components use Tailwind utility classes exclusively (no separate CSS files for component styles)
- Icons from Lucide React
- Dialogs for destructive/confirmable actions (checkout, reset, merge, etc.)
- Context menus on commits for git operations
- Inline tree expansion for sidebar ref hierarchy

### Backend (Rust/Tauri)

**Architecture** (`src-tauri/src/`):
- `lib.rs` - Main entry point; configures Tauri builder with RepoState and command handlers
- `main.rs` - Thin wrapper; delegates to `lib.rs`
- `repo/` - Repository lifecycle (opening repos, maintaining global state of open repos)
  - `state.rs` - `RepoState` struct: `Arc<Mutex<HashMap<repoId, Repository>>>`; one git2::Repository per open repo
- `commands/` - Tauri command handlers (invoked via IPC from frontend); all registered explicitly in the `invoke_handler!` macro in `lib.rs`:
  - `repo.rs` - `open_repo()`, `list_refs()`
  - `history.rs` - `walk_commits()` (core feature: builds positioned commit graph with lanes)
  - `diff.rs` - `get_commit_diff()`, `get_workdir_diff()`
  - `actions.rs` - `get_head_info()`, `checkout_branch/commit()`, `create_branch_at()`, `reset_head()`, `rebase_onto()`, `squash_commits()`
  - `staging.rs` - `list_status()`, `stage_file/paths()`, `unstage_file/paths()`, `do_commit()`, `amend_commit()`, `discard_all()`
  - `merge.rs` - `merge_commit()`, `get_merge_status()`, `resolve_ours/theirs()`, `finish_merge()`, `abort_merge()`, `cherry_pick()`, `finish_cherry_pick()`, `revert_commit()`, `finish_revert()`
  - `stash.rs` - `stash_push()`, `list_stashes()`, `pop_stash()`, `apply_stash()`, `drop_stash()`, `rename_stash()`
  - `tags.rs` - `create_tag()`, `delete_tag()`
  - `remote.rs` - `list_remotes()`, `fetch_remote()`, `push_branch()`, `pull_branch()`, `push_tag()`, `delete_remote_tag()`, `rename_remote_branch()`. **Shells out to the system `git` binary** (via `tokio::process::Command`) instead of `git2`, so credential helpers (GCM, SSH agent, etc.) behave exactly as they do in a terminal — no re-implementing auth.
  - `fs.rs` - `scan_for_git_repos()` (filesystem scan used by the repo picker)
  - `plugins.rs` - `read_local_plugin()` (reads a plugin's manifest + entry module off disk; validation happens on the frontend)
  - `cli.rs` - `register_cli_shim/unregister_cli_shim/check_cli_shim()` (installs a `waypoint` shell shim so the app can be launched from a terminal, e.g. `waypoint .`)
  - top-level in `lib.rs` - `register_explorer_context_menu()` (Windows-only: adds/removes an "Open in Waypoint" entry in Explorer's right-click menu via the registry)
- `graph/` - Commit graph layout engine:
  - `lanes.rs` - `assign_lanes()` function: topological sort + lane assignment for rendering DAG as columns
  - `mod.rs` - `PositionedCommit` struct (commit data + visual position: lane, row, color_idx, edges)
- `error.rs` - Custom error types; converts to `Result<T>` for Tauri

**Key Patterns**:
- All commands receive `state: State<RepoState>` to access the open repos
- Commands use `git2` crate for all Git operations (libgit2 C bindings)
- Errors are mapped to custom `Error` enum and serialized back to frontend
- Commits are walked topologically + by time; entire graph is loaded (up to limit of 2000 commits)
- Graph layout assigns commits to visual "lanes" (columns) based on ancestry to avoid line crossings

**Data Structures**:
- `CommitNode`: oid, parent oids, summary, author, timestamp, refs
- `PositionedCommit`: CommitNode + lane (column), row, color index, edges (graph connections)
- `RefInfo`: name, shorthand, kind (local_branch/remote_branch/tag/other), target oid, is_head
- `FileDiff`: path, old_path (renames), status, hunks with lines (context/addition/deletion)
- `FileStatus`: path, staged status, unstaged status (for staging view)
- `StatusInfo`: staged/unstaged counts, merge_in_progress flag
- `MergeStatus`: in_progress, kind, conflicted_paths, merge_head oid, default message

### Plugin System

Waypoint supports third-party plugins: small JS packages (local folder or GitHub repo) described by a `waypoint.plugin.json` manifest plus an entry ES module exporting `commands` keyed by command id.

- `src/lib/plugins/types.ts` - manifest/command/surface types. Surfaces are where a command can appear: `commandPalette`, `commitContextMenu`, `branchContextMenu`, `toolbar`
- `src/lib/plugins/registry.ts` - hand-rolled manifest validation (no schema lib) + install/list state persisted via `@tauri-apps/plugin-store` (`plugins.json`)
- `src/lib/plugins/install.ts` - fetching/installing a plugin from a local path or GitHub repo (backed by `commands::plugins::read_local_plugin` on the Rust side)
- `src/lib/plugins/host.ts` + `sandbox.worker.ts` - **execution sandbox**: each plugin command runs in a fresh Web Worker (`runInWorker`), with `api.*` calls proxied back to the host over `postMessage` and handled by `src/lib/plugins/api.ts`. The worker is killed on a 30s timeout or completion. This isolates crashes/hangs, not security (see comment in `sandbox.worker.ts`) — plugins are trusted code, same as any other local script.
- `src/components/plugins/` - `PluginsSettings` (install/manage UI), `PluginRunnerProvider` (wires surfaces to the sandbox), `PluginInputDialog` (renders a manifest's declared `InputField`s before running a command)

### File Watching

- `src-tauri/src/repo/watcher_state.rs` holds a `notify_debouncer_mini` debouncer per open repo (`WatcherState`, managed alongside `RepoState`)
- Set up in `commands::repo` when a repo is opened; watches the working directory so the frontend's status polling reflects external changes (e.g. edits made outside the app) promptly

## Common Development Patterns

### Adding a New Git Operation

1. **Backend** (`src-tauri/src/commands/`):
   - Add a new command function in the appropriate module (e.g., `actions.rs` for branch ops)
   - Accept `repoId: String` and `state: State<RepoState>` as parameters
   - Use `git2::Repository` methods on `state.0.lock().unwrap().get(&repoId)` to perform the operation
   - Return `Result<T>` (will be serialized to frontend)
   - Register the command in `lib.rs` in the `invoke_handler!` macro

2. **Frontend**:
   - Add a new IPC wrapper in `lib/ipc.ts` in the `ipc` object (type-safe invoke)
   - If it needs data caching, add a React Query hook in `lib/queries.ts`
   - Call it from a component or dialog
   - If it mutates state, call `useRefreshRepo()` to invalidate caches and refetch

### Handling Merge Conflicts

- When a merge/cherry-pick/rebase results in conflicts:
  - Backend returns `MergeResult { kind: "conflicts", conflicted: [paths] }`
  - Frontend routes to `ConflictPanel` component
  - User clicks "Ours" or "Theirs" per file → calls `resolve_ours/theirs()`
  - Once all resolved, user clicks "Finish Merge" → calls `finish_merge()` with commit message
  - On success, `useRefreshRepo()` clears cache; timeline updates

### File Diff Display

- **Commit diffs**: Single call to `get_commit_diff(repoId, oid)` returns all changed files
- **Staging diffs**: Per-file calls to `get_workdir_diff(repoId, path, staged: bool)` for staged vs unstaged
- Diffs are hunks (context lines + additions/deletions); frontend renders line-by-line syntax highlighting (simple class-based)

### Timeline Graph Layout

- `walk_commits()` calls `assign_lanes()` which performs a topological sort and assigns each commit to a visual lane (column)
- Lanes minimize line crossings; edges point from parent commit to child
- Frontend renders commits as rows; the `GraphLayer` SVG overlays connection lines
- Virtualization: only visible rows are rendered (overscan = 20 rows)

## File Structure Quick Reference

```
waypoint/
├── package.json                 # Frontend dependencies, main scripts
├── tsconfig.json               # TypeScript config (ES2020 target, strict mode)
├── vite.config.ts             # Vite + React + Tailwind config, port 1420
├── src/                        # Frontend (React/TS)
│   ├── main.tsx               # React entry point
│   ├── App.tsx                # Root component (React Query provider, routes)
│   ├── index.css              # Tailwind imports, theme variables (OKLCh)
│   ├── lib/
│   │   ├── ipc.ts             # Type-safe Tauri invoke wrappers
│   │   ├── store.ts           # Zustand app state
│   │   ├── queries.ts         # React Query hooks
│   │   ├── plugins/           # Plugin manifest/registry/sandbox (see Plugin System)
│   │   └── utils.ts           # Utilities
│   ├── components/
│   │   ├── timeline/          # Commit graph timeline
│   │   ├── sidebar/           # Ref tree, stashes
│   │   ├── staging/           # Working dir changes, staging, conflicts
│   │   ├── detail/            # Commit detail, file diffs
│   │   ├── actions/           # Action dialogs
│   │   ├── plugins/           # Plugin settings/runner/input UI
│   │   ├── tabs/              # Tab bar for multiple repos
│   │   └── ui/                # Base UI components (shadcn-generated)
│   └── routes/
│       ├── welcome.tsx        # Repo picker
│       └── repo.tsx           # Main repo view
├── vitest.config.ts            # Vitest config (jsdom, globals, setup file)
├── src-tauri/                 # Backend (Rust)
│   ├── tauri.conf.json       # Tauri config (window size, beforeDevCommand, etc.)
│   ├── Cargo.toml            # Rust dependencies (git2, tauri, serde, etc.)
│   └── src/
│       ├── lib.rs            # Entry point, command registration
│       ├── main.rs           # Thin wrapper to lib.rs
│       ├── error.rs          # Custom error types
│       ├── repo/             # Repository + file-watcher state management
│       ├── commands/         # All Tauri commands (handlers, incl. remote/tags/fs/plugins/cli)
│       └── graph/            # Commit graph layout engine
└── dist/                      # Frontend build output (generated)
```

## Important Implementation Details

### Theme System

- Uses Tailwind v4 with custom theme variables in OKLCh color space
- `src/index.css` defines `:root` (light) and `.dark` (dark mode) variables
- All colors use oklch() function; sidebar has dedicated color set
- No Tailwind config file needed (inline `@theme` in CSS)

### UI Components

- Generate new base components with the shadcn CLI (`pnpm dlx shadcn@latest add <component>`) rather than hand-writing them, so they match the existing set in `src/components/ui/`

### Query Cache Invalidation

- `useRefreshRepo()` invalidates 7 query keys: commits, refs, head, status, staging, merge-status, stashes
- Called after any mutating command (commit, checkout, etc.)
- Ensures UI stays in sync without manual refetching

### Commit Selection & Filtering

- Selected commit OID stored in Zustand
- Search filter searches summary, author name/email, and OID prefix
- Filtered commits list recomputed via `useMemo` on filter change
- Timeline shows count: "X / Y commits" when search active

### WIP (Work in Progress) Row

- Pinned row above timeline when working directory is dirty
- Displays staged/unstaged counts and merge conflict indicator
- Clicking it opens staging panel; shows current state of working directory

### Recent Repos

- Welcome screen stores recent repo paths in Tauri plugin-store (`waypoint.json` file)
- Max 10 recent repos; updated each time a repo is opened
- Click to reopen without browsing again

## Notes for Future Development

- **Performance**: Timeline is virtualized; can handle 2000+ commits smoothly
- **Merge/Cherry-Pick UI**: Conflicts trigger automatic panel switch; user resolves per-file, then commits
- **Graph Coloring**: Each commit lane gets a color index for visual distinction on timeline
- **Stash Support**: Stashes appear as special commits in timeline (detected by commit summary prefix)
- **Native Dialogs**: File/folder pickers and confirmation dialogs use Tauri plugins (not browser dialogs)
