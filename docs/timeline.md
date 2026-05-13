# Timeline Panel

Technical reference for the commit timeline: the virtualized rows, the SVG
graph layer, the backend lane allocator that feeds it, and the user-resizable
columns.

## Components

| File | Role |
| --- | --- |
| `src/components/timeline/Timeline.tsx` | Outer container. Owns virtualization, the resize splitters, and propagates `refsWidth` / `graphColWidth` to children. |
| `src/components/timeline/GraphLayer.tsx` | SVG layer that draws edges and dots on top of the rows. Pure rendering — takes the already-positioned commits and emits paths. |
| `src/components/timeline/CommitRow.tsx` | One row: refs column, graph spacer, message, right-side metadata cluster. |
| `src/components/timeline/WipRow.tsx` | Pinned row above the scroll area when the working dir is dirty or a merge is in progress. |
| `src/components/timeline/RefBadge.tsx` | Branch / tag badges shown in the refs column. |
| `src/components/timeline/CommitContextMenu.tsx` | Right-click menu wrapping each row. |
| `src-tauri/src/graph/lanes.rs` | Backend lane allocator. Topologically walks the commit list and produces `PositionedCommit { lane, row, color_idx, edges }`. |

## Backend: lane allocation (`graph/lanes.rs`)

`assign_lanes` takes a topologically-sorted, newest-first commit list and
produces a `PositionedCommit` per commit. The core data structure is
`lanes: Vec<Option<String>>` — each slot either holds the OID of the commit
that currently "owns" that visual column, or is free.

Per commit, in order:

1. **Find this commit's lane.** If a child already pre-allocated a slot
   carrying this commit's OID, use that index. Otherwise take the first free
   slot or grow the vector. This is `commit_lane`.
2. **Clear routing duplicates.** Other lanes may also hold this commit's OID
   as routing entries (see step 5 of earlier commits). Wipe them — the commit
   collapses back to one canonical column.
3. **Assign a color.** `oid_color[oid]` — already set by an earlier child, or
   take the next color in the palette.
4. **Allocate lanes for each parent.** For each parent in order:
   - If the parent already has a lane, use it.
   - Else if first parent (`i == 0`), inherit `commit_lane`.
   - Else (merge parent), take the next free slot.

   Write the parent's OID into that slot. Push a `GraphEdge { from_lane: commit_lane, to_lane: target_lane, ... }`.
5. **Routing entry.** If the first parent ended up on a *different* lane than
   `commit_lane` (because it was pre-allocated by another child), the commit's
   own slot is now redundant. Replace it with the first parent's OID so the
   slot stays reserved until the parent is actually processed and collapses
   it back via step 2. Without this the trunk's column could be re-used by an
   unrelated branch in the rows between.

### Second pass: edge endpoint fix-up

The `to_lane` recorded in step 4 is "whichever slot the parent was
preallocated in *at the time*." Once step 2 collapses routing duplicates,
the parent's actual rendered lane is its first-occurrence slot, which may be
a lower index. A second pass rewrites both `to_row` and `to_lane` from
`oid_to_lane` (built from the final `result.iter().map(|p| (oid, p.lane))`)
so every edge ends exactly where the parent dot sits.

Without this fix, edges silently land on empty space and the visual reads as
"line coming out of nowhere."

### Color rule: MIN-claim wins for first parents

The first-parent color claim is `oid_color[parent] = min(existing, current)`,
not `or_insert`. Rationale: `color_idx` is handed out in walk order, so a
lower value means "claimed earlier in the walk" — typically the
HEAD's first-parent chain (color 0 is whoever the walk visited first,
usually a stash entry on HEAD or HEAD itself).

The previous `or_insert` semantics let a side-branch tip processed *before*
the trunk stamp the trunk's downstream lane with the side branch's color.
Concrete failure mode: a renovate branch tip whose timestamp beats the next
trunk commit's timestamp would be visited first, color its shared trunk
ancestor rose, and the trunk lane below the convergence point inherits rose.
The MIN rule lets the trunk overwrite that stamp when the walk eventually
reaches it.

The merge-parent branch (`i != 0`) still uses `or_insert_with` because merge
parents legitimately introduce a new chain that should keep its own color.

If the heuristic ever picks wrong (e.g. a feature branch sits on a lower
lane index than what should be the trunk), the principled fix is to expose
`parent_index: u32` on `GraphEdge` and key fork-vs-merge decisions off that
directly rather than off lane numbers.

## Frontend: edge geometry (`GraphLayer.tsx`)

`edgePath(fromX, fromY, toX, toY)` returns an SVG path string for one edge.
Three cases:

- **Same lane** (`fromX === toX`): straight vertical line.
- **Fork** (`fromX > toX`, i.e. child sits to the right of its parent's
  lane): vertical run lives in the *child's* lane all the way down, bends
  near the bottom into the parent's lane, terminates at the parent dot. The
  branch dot anchors the visible top of the line.
- **Merge** (`fromX < toX`): mirror image — bend just below the merge
  commit, vertical run lives in the *parent's* lane, terminates at the
  parent dot.

Both bent variants use two quadratic-bezier quarter-arc corners with a
shared radius `r`, clamped via
`min(CURVE_R, (toY - fromY) / 2, |toX - fromX| / 2)` so the corners never
overrun the available vertical or horizontal segment. `Math.max(0, …)`
guards the degenerate `toY === fromY` case.

The fork/merge dispatch is a heuristic on lane direction. It assumes the
trunk lives on a lower-index lane than its branches — true in the typical
case because the walk allocates main first, and branches grow rightward
into higher indices. The same caveat as the backend color rule applies: if
this guess is wrong in some repo, the cleanest fix is to expose
`parent_index` from the backend and use it here.

## Rows and the graph layer

Rendering inside the scroll container is split:

- The **graph layer** (`GraphLayer`) is an absolutely-positioned SVG offset
  by `refsWidth` and sized to `naturalGraphWidth`. It renders all edges,
  then all dots on top.
- The **commit rows** are virtualized via `@tanstack/react-virtual` and live
  in a separate absolutely-positioned layer. Each row reserves space for
  refs (`refsWidth`), the graph (`graphColWidth = naturalGraphWidth +
  graphExtra`), the message (`flex-1 min-w-0 truncate`), and a fixed-width
  metadata cluster.

The graph layer and the rows share an x-axis but stack independently — dots
and edges are pointer-events-disabled so all clicks fall through to the
underlying row.

`naturalGraphWidth = maxLanes * LANE_WIDTH + LANE_WIDTH` (one trailing lane
of padding). `maxLanes` is recomputed per render from
`max(c.lane + 1, all_edges.{from_lane, to_lane} + 1)` so reading the graph
width from `lane` alone isn't sufficient — long fork edges can poke past the
right-most commit dot.

## Column resize

Two splitters overlay the timeline (`Timeline.tsx`):

| Splitter | Controls | State key | Default | Clamp |
| --- | --- | --- | --- | --- |
| refs ↔ graph | `refsWidth` | `waypoint.timeline.refsWidth` | `REFS_COL_WIDTH` (160) | [60, 400] |
| graph ↔ message | `graphExtra` | `waypoint.timeline.graphExtra` | 0 | [0, 320] |

`graphExtra` is *padding added beyond the natural graph width*, not a fixed
width — it lets the user push the message column right without ever
clipping the graph. When search is active the graph collapses to zero width
and splitter 2 is hidden; splitter 1 stays.

Both splitters are `position: absolute; top: 0; bottom: 0` inside the
timeline's outer container so they don't scroll with content. The dragger
attaches `mousemove` / `mouseup` listeners to `window` (not the splitter
element) for the duration of the drag, and toggles `document.body` cursor +
`user-select` so the cursor sticks and text selection doesn't trigger
mid-drag.

State is persisted to `localStorage` on every change; reads are clamped on
load so out-of-range stored values can't break the layout.

## WIP row

Rendered above the scroll area when `status.staged_count +
status.unstaged_count > 0` or a merge is in progress. Hidden during
search. The dashed dot sits at HEAD's lane and color; a short connector
line runs from the dot down to the row boundary so the visual lane stays
unbroken into the first real commit. A matching extension line at the top
of `GraphLayer` runs from `y = 0` down to the HEAD dot's row to bridge the
WIP-row → first-commit gap.

## Common pitfalls

- **Don't read `to_lane` before the second pass.** The first-pass value is
  routing-time scratch. Anything outside `assign_lanes` must use the
  rewritten value (which is what gets serialized to the frontend).
- **`maxLanes` must include edges, not just dots.** A long fork edge can
  span lanes higher than any commit dot in the visible window.
- **Edge color follows the source commit at the time of edge creation.**
  Later MIN-rule updates to the *parent's* color do not retroactively
  recolor edges — that's intentional, the merge-in lines should keep their
  branch's color even after the parent dot flips to the trunk color.
- **Splitter overlays sit at `z-index: 10` inside the timeline container.**
  Anything new that needs to be clickable above the rows should sit at the
  same level or below.
