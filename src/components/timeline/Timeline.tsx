import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PositionedCommit } from "@/lib/ipc";
import { GraphLayer, LANE_WIDTH, ROW_HEIGHT } from "./GraphLayer";
import { CommitRow } from "./CommitRow";

interface Props {
  commits: PositionedCommit[];
  selectedOid: string | null;
  onSelectOid: (oid: string) => void;
}

export function Timeline({ commits, selectedOid, onSelectOid }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Determine max number of lanes so we know how wide the graph SVG should be.
  const maxLanes = commits.reduce((m, c) => Math.max(m, c.active_lanes.length, c.lane + 1), 1);
  const graphWidth = maxLanes * LANE_WIDTH + LANE_WIDTH;

  const virtualItems = rowVirtualizer.getVirtualItems();
  const startRow = virtualItems.length > 0 ? virtualItems[0].index : 0;
  const visibleRows = virtualItems.length;

  if (commits.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        No commits found.
      </div>
    );
  }

  return (
    <div ref={parentRef} className="flex-1 overflow-auto relative" style={{ contain: "strict" }}>
      {/* Total height spacer */}
      <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
        {/* SVG graph layer — absolutely positioned, covers full virtual height */}
        <div
          style={{
            position: "absolute",
            top: startRow * ROW_HEIGHT,
            left: 0,
            width: graphWidth,
            pointerEvents: "none",
          }}
        >
          <GraphLayer
            commits={commits}
            startRow={startRow}
            visibleRows={visibleRows}
            width={graphWidth}
            onSelectOid={onSelectOid}
            selectedOid={selectedOid}
          />
        </div>

        {/* Commit rows */}
        <div
          style={{
            position: "absolute",
            top: startRow * ROW_HEIGHT,
            left: 0,
            right: 0,
          }}
        >
          {virtualItems.map((virtualItem) => {
            const item = commits[virtualItem.index];
            return (
              <CommitRow
                key={item.commit.oid}
                item={item}
                graphWidth={graphWidth}
                isSelected={item.commit.oid === selectedOid}
                onClick={() => onSelectOid(item.commit.oid)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
