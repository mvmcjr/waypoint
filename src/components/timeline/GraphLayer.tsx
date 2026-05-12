import type { PositionedCommit } from "@/lib/ipc";

// One lane column is this many pixels wide.
export const LANE_WIDTH = 16;
// Height of each commit row in pixels — must match CommitRow.
export const ROW_HEIGHT = 32;
// Radius of the dot drawn for each commit.
const DOT_R = 5;

// 8 distinct lane colors cycling.
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

function laneColor(idx: number) {
  return LANE_COLORS[idx % LANE_COLORS.length];
}

interface Props {
  commits: PositionedCommit[];
  // Virtualized offset: first visible row index.
  startRow: number;
  // Number of visible rows.
  visibleRows: number;
  // Width of the SVG (determined by max lane count).
  width: number;
  onSelectOid: (oid: string) => void;
  selectedOid: string | null;
}

export function GraphLayer({ commits, startRow, visibleRows, width, onSelectOid, selectedOid }: Props) {
  const endRow = startRow + visibleRows;
  const visible = commits.slice(startRow, endRow);

  const svgHeight = visibleRows * ROW_HEIGHT;

  return (
    <svg
      width={width}
      height={svgHeight}
      style={{ display: "block", flexShrink: 0 }}
      aria-hidden
    >
      {/* Pass-through lines for lanes that continue across visible rows */}
      {visible.map((item) => {
        const y = (item.row - startRow) * ROW_HEIGHT + ROW_HEIGHT / 2;
        return item.active_lanes.map((occupant, laneIdx) => {
          if (!occupant) return null;
          const x = laneIdx * LANE_WIDTH + LANE_WIDTH / 2;
          const color = laneColor(laneIdx);
          return (
            <line
              key={`cont-${item.row}-${laneIdx}`}
              x1={x}
              y1={y - ROW_HEIGHT / 2}
              x2={x}
              y2={y + ROW_HEIGHT / 2}
              stroke={color}
              strokeWidth={2}
              opacity={0.6}
            />
          );
        });
      })}

      {/* Edges — curves between commit dot and parent dot */}
      {visible.flatMap((item) =>
        item.edges.map((edge, ei) => {
          const fromY = (item.row - startRow) * ROW_HEIGHT + ROW_HEIGHT / 2;
          const toY = (edge.to_row - startRow) * ROW_HEIGHT + ROW_HEIGHT / 2;
          const fromX = edge.from_lane * LANE_WIDTH + LANE_WIDTH / 2;
          const toX = edge.to_lane * LANE_WIDTH + LANE_WIDTH / 2;
          const color = laneColor(item.color_idx);

          if (fromX === toX) {
            // Straight vertical line
            return (
              <line
                key={`edge-${item.row}-${ei}`}
                x1={fromX}
                y1={fromY}
                x2={toX}
                y2={toY}
                stroke={color}
                strokeWidth={2}
              />
            );
          }

          // Cubic bezier for merges/branches
          const cp1x = fromX;
          const cp1y = fromY + ROW_HEIGHT;
          const cp2x = toX;
          const cp2y = toY - ROW_HEIGHT;
          return (
            <path
              key={`edge-${item.row}-${ei}`}
              d={`M ${fromX} ${fromY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${toX} ${toY}`}
              fill="none"
              stroke={color}
              strokeWidth={2}
            />
          );
        })
      )}

      {/* Commit dots */}
      {visible.map((item) => {
        const x = item.lane * LANE_WIDTH + LANE_WIDTH / 2;
        const y = (item.row - startRow) * ROW_HEIGHT + ROW_HEIGHT / 2;
        const color = laneColor(item.color_idx);
        const isSelected = item.commit.oid === selectedOid;

        return (
          <circle
            key={`dot-${item.row}`}
            cx={x}
            cy={y}
            r={isSelected ? DOT_R + 2 : DOT_R}
            fill={isSelected ? "#fff" : color}
            stroke={color}
            strokeWidth={2}
            style={{ cursor: "pointer" }}
            onClick={() => onSelectOid(item.commit.oid)}
          />
        );
      })}
    </svg>
  );
}
