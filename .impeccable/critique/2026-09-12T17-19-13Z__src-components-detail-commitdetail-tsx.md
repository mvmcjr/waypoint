---
target: commit side panel viewer
total_score: 20
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:E:\\waypoint\\src\\components\\detail\\CommitDetail.tsx"
target_fingerprint: "sha256:1c460b9152e11781b2987195d37e58f04a1a596e38627be2dbd195bbf3d45876"
target_path: "E:\\waypoint\\src\\components\\detail\\CommitDetail.tsx"
timestamp: 2026-09-12T17-19-13Z
slug: src-components-detail-commitdetail-tsx
---
Method: dual-agent (A: design review sub-agent · B: detector sub-agent)

# Critique: Commit side panel (CommitDetail.tsx + DiffViewer.tsx)

User hypothesis: remove inline diff contents from the sidebar; open the diff on click like the staging view. Verdict: agree, on the condition that click-to-open ships with navigation between files (open-file highlight, next/prev, remembered layout and scope).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | No file count. Nothing marks which file is open in FileDiffPanel. Merge commits are silently diffed against parent 1 (diff.rs:175). |
| 2 | Match System / Real World | 3 | Git conventions are right. "Binary or empty file" is ambiguous. |
| 3 | User Control and Freedom | 2 | Collapse is undone on every commit change (CommitDetail.tsx:31). Unified/split resets per file because of the remount (repo.tsx:681). No Esc. |
| 4 | Consistency and Standards | 2 | Cards vs rows. "List" vs "Path" (StagingPanel.tsx:247). Three status-letter maps. |
| 5 | Error Prevention | 3 | Read-only, but each row has two click targets that do different things. |
| 6 | Recognition Rather Than Recall | 2 | No open-file highlight. The path truncates the filename away. Parents can't be clicked. |
| 7 | Flexibility and Efficiency | 1 | No keyboard navigation, preferences aren't persisted, fixed 320px. |
| 8 | Aesthetic and Minimalist Design | 2 | Wrapped code floods the column. Body scrolls separately. Card inside card. |
| 9 | Error Recovery | 1 | Diff load failure renders nothing (CommitDetail.tsx:129). No retry. |
| 10 | Help and Documentation | 2 | Tooltips only, no shortcut hints. |
| **Total** | | **20/40** | **Acceptable (bottom of band)** |

## Design Specificity Verdict

Design review: the metadata block fits Night Chart. The file list is a generic diff widget: bordered cards inside a card, hardcoded Tailwind colors instead of tokens, and green diff fill as the heaviest element. The category convention, and Waypoint's own staging view, separate the file list from the diff reader.

Deterministic scan: 0 findings in src/components/detail (4 files) and StagingPanel.tsx, exit 0. Verified with --no-config and a positive-control probe (4 findings). The detector has no rule for the real problems here.

Visual overlays: none. Tauri-only surface, no IPC mock, tauri MCP disconnected.

## Priority Issues

- [P0] Every file's full diff renders inline, expanded, not virtualized (DiffViewer.tsx:87-94, :195). Fix: delete HunkView, the chevron, openFiles and Expand/Collapse all; compact rows open FileDiffPanel. Command: /impeccable distill, then /impeccable optimize.
- [P1] Click-to-open has no navigation between files: no selectedPath, layout and scope reset per file, no next/prev or n/N, no Esc. Fix: open-row highlight (7% white overlay plus 2px teal edge at 50%), ‹ › and n / N in the FileDiffPanel header, [ ] or Alt+↑/↓ and Esc, layout/scope in Zustand. Command: /impeccable harden.
- [P1] Commit and staging panels have drifted: cards vs rows, List vs Path, path-first vs filename-first, three status maps. Fix: shared FileRow (right slot: stage button or +N −M), shared STATUS_STYLE. Command: /impeccable polish.
- [P2] Opening a file is mouse-only: div onClick rows (DiffViewer.tsx:71, :112; StagingPanel.tsx:77), no aria-pressed, identical chevron labels. Fix: button rows or a roving listbox, aria-current. Command: /impeccable harden.
- [P2] Token drift: header not in Label style (CommitDetail.tsx:64), decorative amber folders, blue hunk headers, white/5/10/15 fills, --diff-add/--diff-del missing from index.css. Command: /impeccable polish.

## Persona Red Flags

- Alex (power user): no keyboard navigation through files; split view resets per file; collapsed panel re-expands per commit; parents can't be clicked; no +/− size cue.
- Sam (keyboard/a11y): can't open a diff from the keyboard; tree directories can't be reached; toggle state not announced.
- Reviewer of a 40-file commit: 40 expanded cards; no count, no +/− total, no position, no "viewed" marker; filenames truncated; merge diffed against first parent with no label.

## Minor Observations

- pre-wrap re-wraps bodies already wrapped at 72 columns; body scrolls separately (max-h-40).
- Hash lengths 12/8/7 are inconsistent.
- PPpp date shows seconds and no relative time; email has no tooltip; no root-commit hint.
- Binary and empty can't be told apart (is_binary not sent).
- FileDiffPanel header uses a literal "|" and hides the summary below lg.
- +/− counts can be derived from the loaded hunks; longer term, a stats-only IPC call with per-file hunk fetch.

## Questions to Consider

- Should the timeline stay partly visible (pinned commit breadcrumb) while a diff is open?
- Is reading the whole commit top to bottom wanted? If so, an optional virtualized stacked view in the wide panel with "viewed" checks.
- What should a merge commit's file list mean: first parent, combined, or what the merge brought in?
