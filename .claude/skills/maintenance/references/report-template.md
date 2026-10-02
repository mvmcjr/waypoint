# Report template

Write to `docs/maintenance/YYYY-MM-DD.md`. The user reads this to decide whether to merge, so lead with what needs their attention.

```markdown
# Maintenance report — YYYY-MM-DD

Branch: `chore/deps-YYYY-MM-DD` (not pushed)

## Summary
2–4 sentences: what changed, what's blocked, anything the user must decide.

## Needs your decision
Bullets. Blocked majors, unfixable advisories, edition/MSRV changes, e2e failures of unclear cause. Omit section if empty.

## Security
| Advisory | Package | Severity | Status |
|---|---|---|---|
| RUSTSEC-… / GHSA-… | name@ver | high | fixed in X / no fix upstream / not reachable from our code (why) |

## Upgrades
| Package | Ecosystem | From | To | Type | Commit |
|---|---|---|---|---|---|

## Release-note highlights
Per major bump or group:
### <package> <from> → <to>
- Breaking changes that affected us and what changed in our code
- Notable new features worth adopting later
- Links to release notes / migration guide

## Blocked
Per blocked bump:
### <package> <from> → <to>
- Failing error (short excerpt)
- What was tried
- Migration notes from research
- Preserved attempt: branch `<worktree branch>` at `<worktree path>`

## Warnings
Before: N, after: M.
- Fixed: list
- Remaining: list with reason

## GitHub Actions
| Action | From | To |
|---|---|---|

## Verification
| Check | Result |
|---|---|
| pnpm build | pass |
| pnpm test run | 123 passed |
| pnpm e2e:typecheck | pass |
| cargo clippy -D warnings | pass |
| cargo test | 45 passed |
| pnpm e2e | 30 passed / 1 failed (see Needs your decision) |
```
