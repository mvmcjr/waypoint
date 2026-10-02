# Lockstep groups

Some packages only work when bumped together. Each group goes to a single researcher and a single migrator, and lands as one commit. Bumping half a group produces confusing peer-dependency or version-mismatch failures that look like migration problems but aren't.

| Group | Members | Why |
|---|---|---|
| React | `react`, `react-dom`, `@types/react`, `@types/react-dom` | runtime and types must match majors |
| Tauri core | `@tauri-apps/api`, `tauri` crate, `tauri-build` crate, `@tauri-apps/cli` | JS API talks to the Rust runtime over IPC |
| Tauri plugins | each `@tauri-apps/plugin-X` with its `tauri-plugin-X` crate (opener, dialog, store) | Tauri CLI refuses to build when the npm and Rust sides of a plugin differ in major.minor |
| Vite/Vitest | `vite`, `@vitejs/plugin-react`, `vitest` | tight peer ranges |
| Tailwind | `tailwindcss`, `@tailwindcss/vite` | plugin pinned to core version |
| Testing Library | `@testing-library/*`, `jsdom`, `@types/jsdom` | DOM env + matchers move together |
| WebdriverIO | `webdriverio`, `expect-webdriverio`, `@types/mocha`, `mocha` | e2e stack; verify with `pnpm e2e:typecheck` |
| git2 | `git2` (+ its `libgit2-sys`), `openssl` | vendored libgit2/OpenSSL features must keep linking |
| notify | `notify-debouncer-mini` (+ `notify` if present directly) | debouncer re-exports notify types |

Tauri core and Tauri plugin groups may be combined into one migrator when both have a pending bump — they share `src-tauri/` and `package.json` heavily and usually release together.

## Not quite majors, but treat them as majors

- `0.x → 0.y`: Cargo and semver treat the minor as breaking.
- `typescript` minor bumps: it's pinned with `~` because TS ships breaking type-check changes in minors.
- Rust `edition` or MSRV changes required by a crate: note them in the report as a decision for the user; don't change `edition` in `Cargo.toml` unilaterally.

## Packages with special handling

- `shadcn`: it's the generator CLI for `src/components/ui/`. Bumping it does not mean regenerating components. Only regenerate (`pnpm dlx shadcn@latest add <component> --overwrite`) if some other bump forces a change in those files, and treat it as blocked if regeneration would discard local customizations.
- `lucide-react`: majors rename/remove icons. Researcher should grep every imported icon name against the new version's exports.
