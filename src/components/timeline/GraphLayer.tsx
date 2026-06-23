import { useMemo } from "react";
import type { PositionedCommit } from "@/lib/ipc";
import { isStashCommit } from "@/lib/utils";

// Edges whose span (parent_row - child_row) exceeds this are treated as "long" and
// indexed up front, so the per-frame scan only has to look a bounded distance above
// the viewport instead of from row 0. Keeps scroll O(window) regardless of repo size.
const LONG_EDGE_SPAN = 256;

export const LANE_WIDTH = 18;
export const ROW_HEIGHT = 34;
export const REFS_COL_WIDTH = 160;
const DOT_R = 4.5;
const CURVE_R = 5;

const LANE_COLORS = [
  "#2dd4bf",  // teal
  "#818cf8",  // indigo
  "#fb7185",  // rose
  "#fbbf24",  // amber
  "#a78bfa",  // violet
  "#38bdf8",  // sky
  "#34d399",  // emerald
  "#fb923c",  // orange
];

export function laneColor(idx: number) {
  return LANE_COLORS[idx % LANE_COLORS.length];
}

function cx(lane: number) {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}
function cy(row: number, startRow: number, wipOffset: number = 0) {
  return (row + wipOffset - startRow) * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/**
 * Edge between a child commit (from) and one of its parents (to), drawn as a
 * smooth-cornered L. The corner sits at one end of the run:
 *
 *  - **Fork** (`fromX > toX`, i.e. child is on a side lane to the right of its
 *    parent's lane): vertical run lives in the *child's* lane, then bends near
 *    the parent. The dot anchors the visible top of the line.
 *  - **Merge** (`fromX < toX`, child sits on a lower-index "trunk" lane than
 *    its non-first parent): mirror image — bend near the merge commit, vertical
 *    run in the parent's lane down to its dot.
 *  - **Same lane**: straight vertical line.
 *
 * `r` is clamped so the corner never overruns the segment in either axis.
 */
function edgePath(fromX: number, fromY: number, toX: number, toY: number): string {
  if (fromX === toX) {
    return `M ${fromX} ${fromY} L ${toX} ${toY}`;
  }
  const sgn = toX > fromX ? 1 : -1;
  const r = Math.max(0, Math.min(CURVE_R, (toY - fromY) / 2, Math.abs(toX - fromX) / 2));
  const cornerAtBottom = fromX > toX; // fork: child right of parent → bend near parent

  if (cornerAtBottom) {
    // vertical along child's lane, bend then horizontal at toY-r, land on parent dot
    return [
      `M ${fromX} ${fromY}`,
      `V ${toY - 2 * r}`,
      `Q ${fromX} ${toY - r} ${fromX + sgn * r} ${toY - r}`,
      `H ${toX - sgn * r}`,
      `Q ${toX} ${toY - r} ${toX} ${toY}`,
    ].join(" ");
  }
  // merge: bend right below the merge commit, vertical along parent's lane
  return [
    `M ${fromX} ${fromY}`,
    `Q ${fromX} ${fromY + r} ${fromX + sgn * r} ${fromY + r}`,
    `H ${toX - sgn * r}`,
    `Q ${toX} ${fromY + r} ${toX} ${fromY + 2 * r}`,
    `V ${toY}`,
  ].join(" ");
}

const EMPTY_STASH_OIDS: Set<string> = new Set();

interface Props {
  commits: PositionedCommit[];
  startRow: number;
  visibleRows: number;
  width: number;
  onSelectOid: (oid: string) => void;
  selectedOid: string | null;
  headOid: string | null;
  /** Pre-computed HEAD commit — avoids O(n) find on every scroll re-render. */
  headCommit?: PositionedCommit | null;
  wipOffset?: number;
  mergeInProgress?: boolean;
  stashOids?: Set<string>;
}

export function GraphLayer({ commits, startRow, visibleRows, width, onSelectOid, selectedOid, headOid, headCommit, wipOffset = 0, mergeInProgress, stashOids = EMPTY_STASH_OIDS }: Props) {
  const endRow = startRow + visibleRows;
  const svgHeight = visibleRows * ROW_HEIGHT;

  // commits[i].row === i (assign_lanes uses the array index as the row; GraphLayer
  // only renders the full, unfiltered list), so we can index by row directly.
  //
  // Long edges (parent far below its child) can cross into the viewport from commits
  // far above it. Iterating from row 0 every frame to catch them is O(endRow) and is
  // what froze deep scrolls once the 2000-commit cap was removed. Instead we index the
  // (rare) long edges once and, per frame, only scan a bounded window above startRow
  // for the common short edges.
  const longEdges = useMemo(() => {
    const out: { from_lane: number; from_row: number; to_lane: number; to_row: number; color_idx: number; isDashed: boolean }[] = [];
    for (const item of commits) {
      let dashed: boolean | null = null;
      for (const e of item.edges) {
        if (e.to_row - e.from_row <= LONG_EDGE_SPAN) continue;
        if (dashed === null) dashed = isStashCommit(item.commit.oid, item.commit.summary, stashOids);
        out.push({ from_lane: e.from_lane, from_row: e.from_row, to_lane: e.to_lane, to_row: e.to_row, color_idx: e.color_idx, isDashed: dashed });
      }
    }
    return out;
  }, [commits, stashOids]);

  const edges: { fromX: number; fromY: number; toX: number; toY: number; color: string; isDashed: boolean }[] = [];

  const pushEdge = (e: { from_lane: number; from_row: number; to_lane: number; to_row: number; color_idx: number }, isDashed: boolean) => {
    edges.push({
      fromX: cx(e.from_lane),
      fromY: cy(e.from_row, startRow, wipOffset),
      toX: cx(e.to_lane),
      toY: cy(e.to_row, startRow, wipOffset),
      color: laneColor(e.color_idx),
      isDashed,
    });
  };

  // Short edges: only commits within LONG_EDGE_SPAN above the viewport can own an edge
  // that reaches into it; everything below endRow is out of view.
  const scanStart = Math.max(0, startRow - wipOffset - LONG_EDGE_SPAN);
  const scanEnd = Math.min(commits.length, Math.max(0, endRow - wipOffset));
  for (let i = scanStart; i < scanEnd; i++) {
    const item = commits[i];
    let dashed: boolean | null = null;
    for (const e of item.edges) {
      if (e.to_row - e.from_row > LONG_EDGE_SPAN) continue; // handled via longEdges
      if (e.from_row + wipOffset >= endRow || e.to_row + wipOffset < startRow) continue;
      if (dashed === null) dashed = isStashCommit(item.commit.oid, item.commit.summary, stashOids);
      pushEdge(e, dashed);
    }
  }

  // Long edges: rare, so a full filtered pass is cheap.
  for (const e of longEdges) {
    if (e.from_row + wipOffset >= endRow || e.to_row + wipOffset < startRow) continue;
    pushEdge(e, e.isDashed);
  }

  const commitStart = Math.max(0, startRow - wipOffset);
  const commitEnd = Math.max(0, endRow - wipOffset);
  const visible = commits.slice(commitStart, Math.min(commitEnd, commits.length));

  return (
    <svg
      width={width}
      height={svgHeight}
      style={{ display: "block", flexShrink: 0, overflow: "hidden" }}
      aria-hidden
    >
      {/* Edges */}
      {edges.map((e, i) => (
        <path
          key={i}
          d={edgePath(e.fromX, e.fromY, e.toX, e.toY)}
          fill="none"
          stroke={e.color}
          strokeWidth={1.5}
          opacity={0.75}
          strokeDasharray={e.isDashed ? "4 3" : undefined}
        />
      ))}

      {/* WIP dot + connection line to HEAD (rendered here so x aligns with commit dots) */}
      {wipOffset > 0 && (() => {
        const h = headCommit ?? commits.find((c) => c.commit.oid === headOid);
        if (!h) return null;
        const x = cx(h.lane);
        const color = laneColor(h.color_idx);
        const headY = cy(h.row, startRow, wipOffset);
        // WIP is virtual row 0; reuse cy() so this stays consistent with commit dot math.
        const wipY = cy(-1, startRow, wipOffset);
        const lineY1 = Math.max(0, wipY);
        const headInView = headY >= 0 && headY <= svgHeight + ROW_HEIGHT;
        const wipInView = wipY >= 0 && wipY <= svgHeight;
        if (!headInView && !wipInView) return null;
        return (
          <>
            {headInView && (
              <line key="wip-line" x1={x} y1={lineY1} x2={x} y2={headY}
                stroke={color} strokeWidth={1.5} opacity={0.6} />
            )}
            {wipInView && (
              <circle key="wip-dot" cx={x} cy={wipY} r={4.5}
                fill="none"
                stroke={mergeInProgress ? "#fb923c" : color}
                strokeWidth={1.5} strokeDasharray="3 2" opacity={0.85} />
            )}
          </>
        );
      })()}

      {/* Commit dots — drawn on top of edges */}
      {visible.map((item) => {
        const x = cx(item.lane);
        const y = cy(item.row, startRow, wipOffset);
        const color = laneColor(item.color_idx);
        const isSelected = item.commit.oid === selectedOid;
        const isHead = item.commit.oid === headOid;

        return (
          <g
            key={item.row}
            style={{ cursor: "pointer" }}
            onClick={() => onSelectOid(item.commit.oid)}
          >
            {isHead && (
              <>
                <circle cx={x} cy={y} r={DOT_R + 5.5} fill="none" stroke="#2dd4bf" strokeWidth={1} opacity={0.12} />
                <circle cx={x} cy={y} r={DOT_R + 3} fill="none" stroke="#2dd4bf" strokeWidth={1.5} opacity={0.3} />
              </>
            )}
            <circle
              cx={x}
              cy={y}
              r={isSelected ? DOT_R + 1.5 : DOT_R}
              fill={isSelected || isHead ? "#e2e8f5" : color}
              stroke={isHead ? "#2dd4bf" : color}
              strokeWidth={isHead ? 2 : 1.5}
            />
          </g>
        );
      })}
    </svg>
  );
}
