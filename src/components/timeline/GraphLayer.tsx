import type { PositionedCommit } from "@/lib/ipc";
import { isStashCommit } from "@/lib/utils";

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

  const edges: { fromX: number; fromY: number; toX: number; toY: number; color: string; isDashed: boolean }[] = [];

  for (const item of commits) {
    if (item.row + wipOffset >= endRow) break; // commits are row-ordered; nothing past here can enter the viewport
    let dashed: boolean | null = null;
    for (const e of item.edges) {
      if (e.from_row + wipOffset >= endRow || e.to_row + wipOffset < startRow) continue;

      if (dashed === null) dashed = isStashCommit(item.commit.oid, item.commit.summary, stashOids);
      const fX = cx(e.from_lane);
      const fY = cy(e.from_row, startRow, wipOffset);
      const tX = cx(e.to_lane);
      const tY = cy(e.to_row, startRow, wipOffset);

      edges.push({ fromX: fX, fromY: fY, toX: tX, toY: tY, color: laneColor(e.color_idx), isDashed: dashed });
    }
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
