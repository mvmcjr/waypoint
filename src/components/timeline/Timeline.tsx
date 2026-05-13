import { useRef, forwardRef, useImperativeHandle } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PositionedCommit } from "@/lib/ipc";
import { useRepoStatus, useStashes } from "@/lib/queries";
import { GraphLayer, LANE_WIDTH, ROW_HEIGHT, REFS_COL_WIDTH } from "./GraphLayer";
import { CommitRow } from "./CommitRow";
import { WipRow } from "./WipRow";
import { CommitContextMenu, type CommitAction } from "./CommitContextMenu";

export interface TimelineHandle {
  scrollToOid: (oid: string) => void;
}

interface Props {
  repoId: string | null;
  commits: PositionedCommit[];
  selectedOid: string | null;
  headOid: string | null;
  headBranch: string | null;
  onSelectOid: (oid: string) => void;
  onCommitAction: (action: CommitAction) => void;
  onWipClick: () => void;
  wipSelected: boolean;
  searchActive?: boolean;
}

export const Timeline = forwardRef<TimelineHandle, Props>(function Timeline(
  { repoId, commits, selectedOid, headOid, headBranch, onSelectOid, onCommitAction, onWipClick, wipSelected, searchActive }: Props,
  ref
) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { data: status } = useRepoStatus(repoId);
  const { data: stashes = [] } = useStashes(repoId);
  const stashOids = new Set(stashes.map((s) => s.oid));

  const rowVirtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  useImperativeHandle(ref, () => ({
    scrollToOid(oid: string) {
      const idx = commits.findIndex((c) => c.commit.oid === oid);
      if (idx !== -1) rowVirtualizer.scrollToIndex(idx, { align: "center" });
    },
  }));

  if (commits.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        {searchActive ? "No matching commits." : "No commits found."}
      </div>
    );
  }

  const maxLanes = commits.reduce((m, c) => {
    let n = Math.max(m, c.lane + 1);
    for (const e of c.edges) n = Math.max(n, e.from_lane + 1, e.to_lane + 1);
    return n;
  }, 1);
  const graphWidth = searchActive ? 0 : maxLanes * LANE_WIDTH + LANE_WIDTH;

  const mergeInProgress = !!status?.merge_in_progress;
  const hasWip = !!status && ((status.staged_count + status.unstaged_count) > 0 || mergeInProgress);
  const headItem = commits.find((c) => c.commit.oid === headOid);
  const headLane = headItem?.lane ?? 0;
  const headColorIdx = headItem?.color_idx ?? 0;

  const virtualItems = rowVirtualizer.getVirtualItems();
  const startRow = virtualItems.length > 0 ? virtualItems[0].index : 0;
  const visibleRows = virtualItems.length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* WIP row — pinned above the scroll area, shown only when dirty */}
      {hasWip && !searchActive && (
        <WipRow
          lane={headLane}
          colorIdx={headColorIdx}
          graphWidth={graphWidth}
          stagedCount={status!.staged_count}
          unstagedCount={status!.unstaged_count}
          mergeInProgress={mergeInProgress}
          isSelected={wipSelected}
          onClick={onWipClick}
        />
      )}

      <div ref={parentRef} className="flex-1 overflow-auto relative" style={{ contain: "strict" }}>
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
          {/* SVG graph layer — offset by the refs column so it sits between refs and message */}
          {!searchActive && (
            <div
              style={{
                position: "absolute",
                top: startRow * ROW_HEIGHT,
                left: REFS_COL_WIDTH,
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
                headOid={headOid}
                hasWip={hasWip}
              />
            </div>
          )}

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
              const isStash =
                stashOids.has(item.commit.oid) ||
                /^(WIP on |index on |untracked files on )/.test(item.commit.summary);
              return (
                <CommitContextMenu
                  key={item.commit.oid}
                  item={item}
                  onAction={onCommitAction}
                >
                  <CommitRow
                    item={item}
                    graphWidth={graphWidth}
                    isSelected={item.commit.oid === selectedOid}
                    isHead={item.commit.oid === headOid}
                    headBranch={headBranch}
                    isStash={isStash}
                    onClick={() => onSelectOid(item.commit.oid)}
                  />
                </CommitContextMenu>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
});
