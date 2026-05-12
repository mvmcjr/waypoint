import { Pencil } from "lucide-react";
import { ROW_HEIGHT, LANE_WIDTH, REFS_COL_WIDTH, laneColor } from "./GraphLayer";

interface Props {
  lane: number;
  colorIdx: number;
  graphWidth: number;
  stagedCount: number;
  unstagedCount: number;
  isSelected: boolean;
  onClick: () => void;
}

export function WipRow({ lane, colorIdx, graphWidth, stagedCount, unstagedCount, isSelected, onClick }: Props) {
  const total = stagedCount + unstagedCount;
  const dotX = lane * LANE_WIDTH + LANE_WIDTH / 2;
  const color = laneColor(colorIdx);

  return (
    <div
      style={{ height: ROW_HEIGHT }}
      onClick={onClick}
      className={[
        "flex items-center shrink-0 border-l-2 select-none cursor-pointer",
        isSelected ? "bg-white/10 border-l-primary" : "border-l-transparent hover:bg-white/5",
      ].join(" ")}
    >
      {/* Refs column — empty for WIP */}
      <div style={{ width: REFS_COL_WIDTH, flexShrink: 0 }} />

      {/* Graph: dashed dot + connector line to the commit below */}
      <div style={{ width: graphWidth, flexShrink: 0 }}>
        <svg width={graphWidth} height={ROW_HEIGHT} style={{ display: "block" }}>
          {/* Line from dot to bottom edge (connects to first real commit) */}
          <line
            x1={dotX} y1={ROW_HEIGHT / 2}
            x2={dotX} y2={ROW_HEIGHT}
            stroke={color} strokeWidth={2}
          />
          {/* Dashed circle representing uncommitted work */}
          <circle
            cx={dotX} cy={ROW_HEIGHT / 2}
            r={5}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeDasharray="3 2"
          />
        </svg>
      </div>

      {/* Message */}
      <div className="flex-1 min-w-0 flex items-center gap-2 pl-2 pr-3">
        <span className="font-mono text-xs text-muted-foreground">// WIP</span>
        <span className="inline-flex items-center gap-0.5 text-[10px] text-yellow-300 bg-yellow-400/10 border border-yellow-400/30 rounded px-1 py-0.5">
          <Pencil size={9} />
          {total}
        </span>
      </div>
    </div>
  );
}
