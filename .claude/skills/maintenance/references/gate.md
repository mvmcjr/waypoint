# Verification gate

The gate is how every step proves it didn't break anything. A commit only happens on a green gate, so the branch is always in a state the user could merge partially.

## Full gate (orchestrator, before every commit on the maintenance branch)

Run from the repo root:

```bash
pnpm build                                     # tsc + vite build
pnpm test run                                  # vitest, single run
pnpm e2e:typecheck                             # e2e TypeScript
cd src-tauri && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo test
```

## Partial gate (migrators in a worktree)

A migrator only needs the half of the gate its change can affect; the orchestrator runs the full gate when integrating anyway. This saves a full Rust compile for every npm-only bump.

- npm-only change → `pnpm build`, `pnpm test run`, `pnpm e2e:typecheck`
- cargo-only change → `cargo clippy --all-targets -- -D warnings`, `cargo test` (in `src-tauri/`)
- both (Tauri lockstep, or a change touching both trees) → full gate

## Toolchain

The local default toolchain is nightly; CI (`.github/workflows/release.yml`) builds with stable. If `rustup toolchain list` shows a stable toolchain, run cargo as `cargo +stable …`. Lints that only fire on nightly aren't what ships, so note them in the report rather than chasing them.

## Windows / Git Bash: native build tools

The Bash tool runs Git Bash, whose `/usr/bin` (Cygwin perl, etc.) comes before native Windows tools on `PATH`. C build scripts in `-sys` crates that shell out to these tools can fail in confusing ways. Example: vendored OpenSSL's `Configure` dies with "Can't locate Locale/Maketext/Simple.pm" because it picked up Cygwin perl. If a `-sys` build script fails under Bash, check `which -a <tool>` first and point the crate at the native tool. For OpenSSL that's `OPENSSL_SRC_PERL=C:/Strawberry/perl/bin/perl.exe`. Since git2 0.21 Waypoint doesn't build OpenSSL at all, but the same trap applies to any vendored C library. Pass any such env vars on to migrators in their prompts.

## Sharing Rust build artifacts across worktrees

A fresh worktree has an empty `target/`, and Waypoint vendors libgit2, so a cold build takes many minutes. Worktree migrators should set `CARGO_TARGET_DIR` to the main checkout's `src-tauri/target` (absolute path). Cargo hashes artifacts by dependency version, so different bumps coexist in one target dir, and its file lock serializes concurrent builds safely — the cost is waiting, not corruption.

## Baseline failures

If a gate step already fails on `master` (recorded in preflight), it doesn't block commits — but the step must not get worse, and the warnings phase should try to fix it. Give migrators the exact list of pre-existing failures (file:line + lint name), and tell them not to fix those themselves. Otherwise their partial gate can't distinguish "pre-existing" from "new", and their fixes would collide with the warnings lane.

## Sanity-check test counts

Compare test counts against the baseline (vitest: files and tests; cargo: `test result` lines). A sudden jump means something extra is being collected, not that tests were added. Agent worktrees under `.claude/worktrees/` are full checkouts, so vitest excludes `.claude/**` for this reason. If counts jump again, check what's being collected before debugging the "failures".

## What "fixing" means

Fix causes, not symptoms. Adding `#[allow(...)]`, `// @ts-ignore`, `// @ts-expect-error`, `as any`, skipping tests, or loosening lint config makes the gate meaningless, so those are off the table. If a warning truly can't be fixed from our side (e.g. it originates inside a dependency's macro expansion), leave it and explain it in the report.
