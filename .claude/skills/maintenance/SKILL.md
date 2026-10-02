---
name: maintenance
description: Dependency maintenance run for Waypoint. Upgrades frontend (pnpm) and Rust (cargo) dependencies — including major versions, after reading their release notes and migrating our code — fixes npm/cargo security advisories, fixes rustc/clippy/tsc/vite warnings, and bumps SHA-pinned GitHub Actions. Fans out parallel Sonnet agents for release-note research and per-bump migrations in isolated worktrees, then integrates green results onto a chore/deps-YYYY-MM-DD branch with one commit per upgrade, plus a written report. Use this whenever the user asks to update, upgrade, or bump dependencies/packages/crates, check for outdated packages, run npm/pnpm/cargo audit, fix vulnerabilities or CVEs in deps, clean up build warnings, or "do maintenance" on this repo — even if they only mention one ecosystem or one package.
---

# Waypoint maintenance

You are the orchestrator. You run in the main session because only the main session can dispatch subagents; the heavy, parallelizable work goes to two Sonnet helpers:

- `deps-researcher` — read-only. Given one package or lockstep group and a version range, reads every release note / changelog / migration guide in range and maps breaking changes onto our code. Returns a brief.
- `deps-migrator` — runs in its own git worktree. Given one bump and its brief, applies the bump, migrates code, runs the partial gate, and commits in the worktree. Returns green (SHA) or blocked.

You own everything that touches the shared lockfiles on the maintenance branch (security fixes, in-range updates, integration) because those can't be parallelized without constant conflicts.

Read these before starting; they're short and the helpers read them too:
- `references/gate.md` — the verification gate, partial gates for worktrees, toolchain notes
- `references/lockstep-groups.md` — packages that must move together, and special cases
- `references/report-template.md` — report format

Work autonomously: when something is ambiguous, make the conservative choice and record it under "Needs your decision" in the report. The user reviews the branch afterwards, so a clear record beats an interruption.

## Ground rules

These exist because the user merges this branch themselves and needs to trust every commit on it.

- Nothing leaves the machine: no push, no PR, no touching `master` or remotes. The branch gets a code review before merge.
- Commit only on a green gate. That keeps the branch mergeable at every commit and makes each upgrade individually revertable.
- No hook skipping (`--no-verify`), no silencing warnings/tests to get green (see "What fixing means" in `gate.md`).
- `src/components/ui/` is shadcn-generated — never hand-edit it (see `lockstep-groups.md` for when regenerating is acceptable).
- No refactors beyond what an upgrade or warning fix requires; unrelated changes make the review harder and blur what each commit is for.
- Only destroy what you created: never `git clean` or discard paths you didn't change. The one allowed `git reset --hard` is dropping a commit you just made on the maintenance branch (Phase 4).

## Phase 0 — Preflight

1. `git status --porcelain` must be empty and the branch must be `master`. If not, stop and tell the user why — their uncommitted work is not yours to stash.
2. Make sure `cargo-audit` and `cargo-outdated` exist (`cargo install --locked <name>` if missing). `cargo-edit` provides `cargo upgrade`; check `cargo upgrade --help` for the installed version's flags.
3. `pnpm install --frozen-lockfile`.
4. `git switch -c chore/deps-$(date +%F)` (append `-2`, `-3` if taken).
5. Run the full gate once and keep the output in the scratchpad (not the repo). Extract the warning list — that's the "before" for the report, and it tells you which failures are pre-existing.

## Phase 1 — Survey (parallel commands)

Run these together; they're independent:

```bash
pnpm audit --json
pnpm outdated --format json
cd src-tauri && cargo audit --json
cd src-tauri && cargo outdated --root-deps-only
cd src-tauri && cargo upgrade --incompatible --dry-run
```

Build three lists:
- **Advisories** — id, package, severity, fixed version, direct or transitive (and which direct dep pulls it in).
- **In-range** — anything `pnpm update` / `cargo update` will move.
- **Majors** — grouped per `lockstep-groups.md`, including the "treat as major" cases there.

Also list every `uses: owner/action@<sha> # vX.Y.Z` in `.github/workflows/*.yml`.

## Phase 2 — Kick off research, then do security + in-range yourself

Research is the slowest part (lots of web reads) and doesn't touch the tree, so start it first and let it run while you handle the lockfile-bound work.

**Dispatch researchers now**, in a single message so they run concurrently: one `deps-researcher` per major (or lockstep group), plus one for the GitHub Actions list. Pass `model: "sonnet"`. If there are more than ~8, send them in waves of ~8. Each prompt should contain:
- package(s), ecosystem, current version(s), target version(s)
- for the Actions researcher: the list of `owner/action@sha # version` lines, and ask for latest release, resolved commit SHA (`gh api repos/<owner>/<action>/commits/<tag> --jq .sha`), and breaking input/output changes

**Meanwhile, security fixes:**
- Direct dependency → bump to the first fixed version. If that's a major, it's now urgent: do it after its research brief arrives, ahead of other majors.
- Transitive → prefer bumping the direct parent. Only if no parent release fixes it, use `pnpm.overrides` in `package.json` or `cargo update -p <crate> --precise <ver>`; say why in the commit body.
- No upstream fix → record id, severity, path, and whether our code reaches the vulnerable API (grep).
- Re-run the audits, full gate, commit `fix(deps): resolve security advisories` (body: each advisory id → fixed version).

**Then in-range updates**, as two separate commits, npm first: `pnpm update` → frontend gate → `chore(deps): update npm dependencies within semver ranges`. Then `cd src-tauri && cargo update` → cargo gate → `chore(deps): update Rust dependencies within semver ranges`. If something breaks, bisect (update halves) to find the culprit, pin it back, and record it. Note that `pnpm update` also raises the `^` floors in `package.json`; that's expected.

Commit the npm side as soon as it's green, so npm migrators can start from it. Don't hold it for the Rust side: the cargo baseline and gate take far longer than the frontend's. Npm in-range updates usually clear most npm advisories, so run `pnpm update` first and re-audit before writing any overrides. The security commit may then shrink to just the leftovers, or vanish.

If the Rust baseline is still compiling when the cargo briefs arrive, don't wait for it to run `cargo update`. Dispatch cargo migrators from the current HEAD, run `cargo update` once the baseline finishes, and let integration regenerate `Cargo.lock` (Phase 4, step 2). In practice this lockfile conflict is cheap to resolve, while waiting costs real time.

## Phase 3 — Migrations (parallel worktrees)

As briefs come back, triage each one:
- **Trivial** (brief says no affected call sites, no config changes): batch several into one migrator. Its commit can still be split per package, but one worktree saves setup time.
- **Non-trivial**: one migrator per package/group.
- **Brief recommends skipping** (e.g. upstream says the new major isn't production-ready, or it needs a Rust edition/MSRV change): don't migrate; record under "Needs your decision".

Dispatch `deps-migrator` agents with `isolation: "worktree"` and `model: "sonnet"`. Concurrency:
- npm-only migrators: up to ~4 at once — the frontend gate is fast.
- cargo-touching migrators (including Tauri groups): at most 2 at once. They share one Rust target dir (see `gate.md`), so more would just queue on cargo's lock while burning disk and CPU.
- Security-driven majors and lockstep groups that other bumps depend on (React, Vite, Tauri) go in the first wave.

Each migrator prompt contains:
- the package(s) and exact versions
- the full research brief
- the absolute path of the main checkout (for `CARGO_TARGET_DIR`)
- which partial gate applies
- the **base SHA** (`git rev-parse HEAD` of the maintenance branch)
- the list of pre-existing gate failures, so the migrator can ignore them (see `gate.md`)
- any environment variables the build needed, such as native-tool overrides (see `gate.md`)

The base SHA is not optional. Worktrees are created from a stale commit, not from your HEAD; in practice every worktree started from an old `master` commit. The migrator resets to the base SHA before doing anything.

## Phase 4 — Integration (sequential, on the maintenance branch)

Integrate each green result one at a time, in the order they arrive, because each one changes the lockfile the next one lands on:

1. `git cherry-pick <sha>` from the migrator's worktree branch (worktrees share the object store, so the commit is reachable).
2. If it conflicts only in manifests/lockfiles (`package.json`, `pnpm-lock.yaml`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`) — the usual case when two bumps touched neighbouring lines — take our side for those files (`git checkout --ours -- <files>`), re-apply the version change with the package manager (`pnpm add [-D] <pkg>@<ver>` / `cargo upgrade --incompatible -p <crate>` + `cargo update -p <crate>`), keep the commit's code changes, then `git cherry-pick --continue`.
3. Conflict in source files → resolve if the intent of both sides is clear; otherwise `git cherry-pick --abort` and mark the bump blocked ("integration conflict with <other bump>").
4. `pnpm install --frozen-lockfile` if the lockfile moved, then the full gate. Green → keep the commit (`git commit --amend --no-edit` if you had to regenerate files). Red → `git reset --hard HEAD~1` (that only drops the commit you just made), `pnpm install --frozen-lockfile`, mark blocked with the error. Interactions between bumps show up here, which is exactly why integration runs the full gate.

Blocked results from migrators: don't cherry-pick. Keep their worktree and branch so the user can pick up the attempt; record both in the report.

After the last integration, remove worktrees and branches belonging to **green** migrators only (`git worktree remove <path>`, `git branch -D <branch>`).

## Phase 5 — Warnings and Actions

Two lanes, each with disjoint files:
- **Rust lane**: rustc + clippy warnings and deprecations under `src-tauri/`.
- **TS lane**: tsc, vite, and vitest warnings/deprecations under `src/`, `e2e/`, config files. Vite chunk-size warnings: only fix if an obvious split point exists; otherwise report.

A lane can start as soon as its ecosystem's migrations are integrated. Don't wait for the other ecosystem: the TS lane can run while cargo migrators are still compiling. Don't start the Rust lane before the cargo majors land, though. Majors like git2 rewrite the same files the lints point at.

Use a worktree migrator (Sonnet) for a lane when it has real work, or when it can overlap with other running work. If a lane is a handful of mechanical fixes (e.g. a few clippy lints) and nothing else is running, do it yourself on the branch. A worktree agent would spend longer on setup and a cold build than on the fixes. Either way, give the lane the baseline warning list and current gate output. Integrate as in Phase 4. Commit message: `chore: fix build warnings` (body lists each fix).

GitHub Actions: apply the Actions brief yourself — replace each SHA, update the `# vX.Y.Z` comment, adjust inputs if a major changed them. Keep SHA pins; never switch to a tag ref. Workflows can't run locally, so read the YAML diff carefully. Commit `ci: bump pinned GitHub Actions`.

## Phase 6 — Wrap up

1. `pnpm notices` to regenerate `THIRD_PARTY_NOTICES.md` (once, now, rather than per bump to avoid conflicts). Commit `chore: regenerate third-party notices` if it changed.
2. `pnpm e2e` once (Windows; slow). If its preflight complains about drivers, run `pnpm e2e:setup` and retry. On failure, decide whether a bump caused it: check out `master` into a temporary worktree and run the failing spec there. Bump-caused and clear → fix, gate, commit. Otherwise record it under "Needs your decision". Don't revert green commits on an e2e failure alone.
3. Write `docs/maintenance/YYYY-MM-DD.md` per `references/report-template.md`; commit `docs: maintenance report YYYY-MM-DD`. Take every commit SHA in it from `git log --oneline master..HEAD`, never from memory. Cherry-picks and lockfile regeneration give commits new SHAs, so the migrators' reported SHAs are not the ones on the branch.
4. Tell the user: branch name, `git log --oneline master..HEAD`, the report's Summary and "Needs your decision", blocked worktree branches, and that the branch is unpushed and should get `/code-review high` before merging.
