import type { PositionedCommit } from "@/lib/ipc";

export const LANE_WIDTH = 20;
export const ROW_HEIGHT = 32;
export const REFS_COL_WIDTH = 180;
const DOT_R = 5;
// Corner radius for lane-change curves (GitKraken "elbow" style).
const CURVE_R = 6;

const LANE_COLORS = [
  "#7c83fd",
  "#fd7c7c",
  "#7cfd9e",
  "#fdd07c",
  "#7ce9fd",
  "#e07cfd",
  "#fd9f7c",
  "#c3fd7c",
];

export function laneColor(idx: number) {
  return LANE_COLORS[idx % LANE_COLORS.length];
}

function cx(lane: number) {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}
function cy(row: number, startRow: number) {
  return (row - startRow) * ROW_HEIGHT + ROW_HEIGHT / 2;
}

interface Props {
  commits: PositionedCommit[];
  startRow: number;
  visibleRows: number;
  width: number;
  onSelectOid: (oid: string) => void;
  selectedOid: string | null;
  headOid: string | null;
  /** When true, draw a short line from the top of the SVG to the HEAD dot
   *  so it visually connects to the WIP row rendered above. */
  hasWip?: boolean;
}

export function GraphLayer({ commits, startRow, visibleRows, width, onSelectOid, selectedOid, headOid, hasWip }: Props) {
  const endRow = startRow + visibleRows;
  const svgHeight = visibleRows * ROW_HEIGHT;

  // Collect all edges from every commit whose row-range intersects the viewport.
  // This ensures edges that start above or end below the viewport are still drawn
  // as they pass through visible rows.
  const edges: { fromX: number; fromY: number; toX: number; toY: number; color: string }[] = [];

  for (const item of commits) {
    for (const e of item.edges) {
      // Skip edges entirely outside the viewport.
      if (e.from_row >= endRow || e.to_row < startRow) continue;

      const fX = cx(e.from_lane);
      const fY = cy(e.from_row, startRow);
      const tX = cx(e.to_lane);
      const tY = cy(e.to_row, startRow);

      edges.push({ fromX: fX, fromY: fY, toX: tX, toY: tY, color: laneColor(e.color_idx) });
    }
  }

  const visible = commits.slice(startRow, Math.min(endRow, commits.length));

  return (
    <svg
      width={width}
      height={svgHeight}
      style={{ display: "block", flexShrink: 0, overflow: "hidden" }}
      aria-hidden
    >
      {/* Edges */}
      {edges.map((e, i) => {
        if (e.fromX === e.toX) {
          // Straight vertical line — same lane.
          return (
            <line
              key={i}
              x1={e.fromX}
              y1={e.fromY}
              x2={e.toX}
              y2={e.toY}
              stroke={e.color}
              strokeWidth={2}
            />
          );
        }

        // Lane change: make a tight rounded corner just after leaving the
        // from-commit, then go straight down to the parent on the to-lane.
        // Elbow is at the top so every branch arrives at its parent going
        // straight down — matching GitKraken's visual convention.
        const r = Math.min(CURVE_R, (e.toY - e.fromY) / 2);
        const d = `M ${e.fromX} ${e.fromY} Q ${e.fromX} ${e.fromY + 2 * r} ${e.toX} ${e.fromY + 2 * r} L ${e.toX} ${e.toY}`;
        return (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={e.color}
            strokeWidth={2}
          />
        );
      })}

      {/* Extension line from top of SVG to HEAD dot when a WIP row sits above */}
      {hasWip && startRow === 0 && (() => {
        const h = commits.find((c) => c.commit.oid === headOid);
        if (!h) return null;
        const x = cx(h.lane);
        return <line key="wip-ext" x1={x} y1={0} x2={x} y2={ROW_HEIGHT / 2} stroke={laneColor(h.color_idx)} strokeWidth={2} />;
      })()}

      {/* Commit dots — drawn on top of edges */}
      {visible.map((item) => {
        const x = cx(item.lane);
        const y = cy(item.row, startRow);
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
              <circle cx={x} cy={y} r={DOT_R + 4} fill="none" stroke="#4ade80" strokeWidth={1.5} opacity={0.5} />
            )}
            <circle
              cx={x}
              cy={y}
              r={isSelected ? DOT_R + 2 : DOT_R}
              fill={isSelected || isHead ? "#fff" : color}
              stroke={isHead ? "#4ade80" : color}
              strokeWidth={isHead ? 2.5 : 2}
            />
          </g>
        );
      })}
    </svg>
  );
}
