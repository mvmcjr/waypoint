import { Pencil, GitMerge } from "lucide-react";
import { ROW_HEIGHT, LANE_WIDTH, REFS_COL_WIDTH, laneColor } from "./GraphLayer";

interface Props {
  lane: number;
  colorIdx: number;
  graphWidth: number;
  stagedCount: number;
  unstagedCount: number;
  mergeInProgress: boolean;
  isSelected: boolean;
  onClick: () => void;
}

export function WipRow({ lane, colorIdx, graphWidth, stagedCount, unstagedCount, mergeInProgress, isSelected, onClick }: Props) {
  const total = stagedCount + unstagedCount;
  const dotX = lane * LANE_WIDTH + LANE_WIDTH / 2;
  const color = laneColor(colorIdx);

  return (
    <div
      style={{ height: ROW_HEIGHT }}
      onClick={onClick}
      className={[
        "flex items-center shrink-0 border-l-2 select-none cursor-pointer transition-colors duration-75",
        isSelected
          ? "bg-teal-500/10 border-l-teal-400"
          : "border-l-transparent hover:bg-white/[0.04]",
      ].join(" ")}
    >
      {/* Refs column — empty for WIP */}
      <div style={{ width: REFS_COL_WIDTH, flexShrink: 0 }} />

      {/* Graph: dashed dot + connector line */}
      <div style={{ width: graphWidth, flexShrink: 0 }}>
        <svg width={graphWidth} height={ROW_HEIGHT} style={{ display: "block" }}>
          <line
            x1={dotX} y1={ROW_HEIGHT / 2}
            x2={dotX} y2={ROW_HEIGHT}
            stroke={color} strokeWidth={1.5} opacity={0.6}
          />
          <circle
            cx={dotX} cy={ROW_HEIGHT / 2}
            r={4.5}
            fill="none"
            stroke={mergeInProgress ? "#fb923c" : color}
            strokeWidth={1.5}
            strokeDasharray="3 2"
            opacity={0.85}
          />
        </svg>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 flex items-center gap-2.5 pl-2 pr-3">
        {mergeInProgress ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-orange-300/90">
            <GitMerge size={11} />
            Merge in Progress
          </span>
        ) : (
          <>
            <span className="font-mono text-[11px] text-muted-foreground/45 tracking-tight">// WIP</span>
            <span className="inline-flex items-center gap-1 text-[10px] tabular-nums text-amber-300/80 bg-amber-400/10 border border-amber-400/20 rounded px-1.5 py-0.5">
              <Pencil size={9} />
              {total} {total === 1 ? "change" : "changes"}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
