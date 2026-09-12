---
target: go-to-commit toolbar search
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:E:\\waypoint\\src\\components\\timeline\\GoToCommit.tsx"
target_fingerprint: "sha256:f33943a20b01e4612d2cccd00a4025fa9bf5e558185639e9b7dbdbe76edee679"
target_path: "E:\\waypoint\\src\\components\\timeline\\GoToCommit.tsx"
timestamp: 2026-09-12T19-09-12Z
slug: src-components-timeline-gotocommit-tsx
---
Method: dual-agent (A: design review sub-agent · B: detector + browser sub-agent), plus parent code review.

# Critique: Go to commit (GoToCommit.tsx + timeline preview)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Previewed row often behind the dropdown; result count only visible after scrolling. |
| 2 | Match System / Real World | 3 | Good copy; Ctrl+F usually means find-in-place, this opens a picker. |
| 3 | User Control and Freedom | 3 | Esc restores scroll, second Esc clears; switching to the editor drops the preview. |
| 4 | Consistency and Standards | 2 | Hints scroll with the list; hint pieces duplicated; grey chip instead of badge colours; peek background = selected background. |
| 5 | Error Prevention | 2 | Mouse over the list can change which result Enter goes to; mid-word matches. |
| 6 | Recognition Rather Than Recall | 3 | Only the summary is highlighted. |
| 7 | Flexibility and Efficiency | 2 | No Home/End/PgUp/PgDn, 50-result cap, no qualifiers, no revision syntax. |
| 8 | Aesthetic and Minimalist Design | 3 | Repeated author and date squeeze the summary. |
| 9 | Error Recovery | 2 | No-match text gives no guidance; wrongly shows while commits load. |
| 10 | Help and Documentation | 2 | Hints hidden at the bottom of the scroll area. |
| **Total** | | **24/40** | **Acceptable** |

## Design Specificity Verdict

Behaviour is specific to a Git client (preview → go → Esc to restore; neutral peek; lane dots). The container is a generic popover over the refs column and lanes. Detector: 0 blocking; real findings are low-contrast key hints (3.2:1 and 3.4:1) and 9–10px hint text. The rest are false positives (10px mono hashes, teal on HEAD, popover covering a badge).

## Priority Issues

- [P1] Dropdown covers the graph and refs, hiding the preview target (newest ~12 commits can never be centred). Fix: right-align the popover, cap ~8 rows, reserve space when scrolling, mark the preview on the graph dot. /impeccable layout
- [P1] Preview breaks with a diff panel open, when the mouse rests over the list, when switching to the editor, and the query carries over between repo tabs. Fix: react only to real mouse movement, ignore window-level focus loss, show the timeline while previewing from a diff, reset on repo change. /impeccable harden
- [P2] Plain substring matching; 1–3-letter words matched against hash starts; only the summary highlighted; repeated author/relative date; grey chip. Fix: rank word-start matches first, hash prefix only for 4+ chars, highlight the matched field, hide a uniform author, absolute dates, existing badge styles. /impeccable distill → clarify
- [P2] Count, hints and no-match text inside the scrolling list; nothing announced to screen readers; no label; second Esc sends focus to the page body; hint contrast. Fix: fixed footer, announced count, labels, Ctrl+F declared as shortcut, restore focus, 4.5:1 hints. /impeccable audit → polish
- [P3] Timeline jumps on every keystroke; peek looks like a selection; two searches per keystroke. Fix: ~150ms wait, 4% + inset outline, search once. /impeccable quieter

## Persona Red Flags

- Alex: no paging keys, 50 cap, no qualifiers/revision syntax, hover steals Enter, "all commits by Alice" lost.
- Sam: placeholder-only name, silent counts, run-on results, focus lost on second Esc.
- Bug hunter (20k commits): summary-only search, hidden total, relative dates, two searches per keystroke.

## Minor Observations

Teal lane-0 dots read as position; 12px vs 13px text; "back" vs "close"; list reference while closed; no peek on HEAD/selected; no-match leaves the timeline at the last candidate; stash results show raw "WIP on…" summary.

## Questions to Consider

- Make the timeline the result list (dim non-matches, scrollbar ticks, Enter / Shift+Enter)?
- Why cover the graph rather than the repeated metadata?
- Accept Git revision syntax via revparse?
