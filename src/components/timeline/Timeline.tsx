import { useRef, useState, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PositionedCommit } from "@/lib/ipc";
import { useRepoStatus, useRefs, useStashes } from "@/lib/queries";
import { clamp, isStashCommit } from "@/lib/utils";
import { GraphLayer, LANE_WIDTH, ROW_HEIGHT, REFS_COL_WIDTH } from "./GraphLayer";
import { CommitRow } from "./CommitRow";
import { WipRow } from "./WipRow";
import { CommitContextMenu, type CommitAction } from "./CommitContextMenu";
import type { RefAction } from "./RefBadge";

const REFS_WIDTH_MIN = 60;
const REFS_WIDTH_MAX = 400;
const GRAPH_EXTRA_MIN = 0;
const GRAPH_EXTRA_MAX = 320;
const LS_REFS_WIDTH = "waypoint.timeline.refsWidth";
const LS_GRAPH_EXTRA = "waypoint.timeline.graphExtra";

function readStored(key: string, fallback: number, lo: number, hi: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
  } catch {
    return fallback;
  }
}

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
  onRefAction?: (action: RefAction) => void;
  onWipClick: () => void;
  wipSelected: boolean;
  searchActive?: boolean;
}

export const Timeline = forwardRef<TimelineHandle, Props>(function Timeline(
  { repoId, commits, selectedOid, headOid, headBranch, onSelectOid, onCommitAction, onRefAction, onWipClick, wipSelected, searchActive }: Props,
  ref
) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { data: status } = useRepoStatus(repoId);
  const { data: stashes = [] } = useStashes(repoId);
  const { data: refs = [] } = useRefs(repoId);
  const pushedTagNames = useMemo(
    () => new Set(refs.filter((r) => r.kind === "tag" && r.is_pushed).map((r) => r.shorthand)),
    [refs],
  );
  const stashOids = useMemo(() => new Set(stashes.map((s) => s.oid)), [stashes]);

  const [refsWidth, setRefsWidth] = useState(() =>
    readStored(LS_REFS_WIDTH, REFS_COL_WIDTH, REFS_WIDTH_MIN, REFS_WIDTH_MAX),
  );
  const [graphExtra, setGraphExtra] = useState(() =>
    readStored(LS_GRAPH_EXTRA, 0, GRAPH_EXTRA_MIN, GRAPH_EXTRA_MAX),
  );

  // Stable callbacks — ref pattern so CommitRow.memo never sees a changed function reference.
  const onSelectOidRef = useRef(onSelectOid);
  onSelectOidRef.current = onSelectOid;
  const stableSelectOid = useCallback((oid: string) => onSelectOidRef.current(oid), []);

  const onCommitActionRef = useRef(onCommitAction);
  onCommitActionRef.current = onCommitAction;
  const stableCommitAction = useCallback((action: CommitAction) => onCommitActionRef.current(action), []);

  const onRefActionRef = useRef(onRefAction);
  onRefActionRef.current = onRefAction;
  const stableRefAction = useCallback((action: RefAction) => onRefActionRef.current?.(action), []);

  // Tracks the active drag's cleanup so it can be called on unmount.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { dragCleanupRef.current?.(); }, []);

  const beginDrag = useCallback(
    (setter: (n: number) => void, startVal: number, lo: number, hi: number, lsKey: string) =>
      (e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        let lastVal = startVal;
        function onMove(ev: MouseEvent) {
          lastVal = clamp(startVal + (ev.clientX - startX), lo, hi);
          setter(lastVal);
        }
        function cleanup() {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          dragCleanupRef.current = null;
        }
        function onUp() {
          cleanup();
          try { localStorage.setItem(lsKey, String(lastVal)); } catch { /* ignore */ }
        }
        dragCleanupRef.current = cleanup;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      },
    [],
  );

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

  const maxLanes = useMemo(() => commits.reduce((m, c) => {
    let n = Math.max(m, c.lane + 1);
    for (const e of c.edges) n = Math.max(n, e.from_lane + 1, e.to_lane + 1);
    return n;
  }, 1), [commits]);
  const headItem = useMemo(() => commits.find((c) => c.commit.oid === headOid), [commits, headOid]);

  if (commits.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        {searchActive ? "No matching commits." : "No commits found."}
      </div>
    );
  }

  const naturalGraphWidth = searchActive ? 0 : maxLanes * LANE_WIDTH + LANE_WIDTH;
  const graphColWidth = searchActive ? 0 : naturalGraphWidth + graphExtra;

  const mergeInProgress = !!status?.merge_in_progress;
  const hasWip = !!status && ((status.staged_count + status.unstaged_count) > 0 || mergeInProgress);
  const headLane = headItem?.lane ?? 0;
  const headColorIdx = headItem?.color_idx ?? 0;

  const virtualItems = rowVirtualizer.getVirtualItems();
  const startRow = virtualItems.length > 0 ? virtualItems[0].index : 0;
  const visibleRows = virtualItems.length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* WIP row — pinned above the scroll area, shown only when dirty */}
      {hasWip && !searchActive && (
        <WipRow
          lane={headLane}
          colorIdx={headColorIdx}
          refsWidth={refsWidth}
          graphWidth={graphColWidth}
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
                left: refsWidth,
                width: naturalGraphWidth,
                pointerEvents: "none",
              }}
            >
              <GraphLayer
                commits={commits}
                startRow={startRow}
                visibleRows={visibleRows}
                width={naturalGraphWidth}
                onSelectOid={stableSelectOid}
                selectedOid={selectedOid}
                headOid={headOid}
                hasWip={hasWip}
                stashOids={stashOids}
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
              const isStash = isStashCommit(item.commit.oid, item.commit.summary, stashOids);
              return (
                <CommitContextMenu
                  key={item.commit.oid}
                  item={item}
                  onAction={stableCommitAction}
                >
                  <CommitRow
                    item={item}
                    refsWidth={refsWidth}
                    graphWidth={graphColWidth}
                    isSelected={item.commit.oid === selectedOid}
                    isHead={item.commit.oid === headOid}
                    headBranch={headBranch}
                    pushedTagNames={pushedTagNames}
                    isStash={isStash}
                    onRefAction={stableRefAction}
                    onCommitAction={stableCommitAction}
                    onSelect={stableSelectOid}
                  />
                </CommitContextMenu>
              );
            })}
          </div>
        </div>
      </div>

      {/* Column splitters — overlay, do not scroll with content */}
      <ColumnSplitter
        left={refsWidth}
        onMouseDown={beginDrag(setRefsWidth, refsWidth, REFS_WIDTH_MIN, REFS_WIDTH_MAX, LS_REFS_WIDTH)}
      />
      {!searchActive && (
        <ColumnSplitter
          left={refsWidth + graphColWidth}
          onMouseDown={beginDrag(setGraphExtra, graphExtra, GRAPH_EXTRA_MIN, GRAPH_EXTRA_MAX, LS_GRAPH_EXTRA)}
        />
      )}
    </div>
  );
});

const SPLITTER_WIDTH = 6;

function ColumnSplitter({ left, onMouseDown }: { left: number; onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onMouseDown}
      className="group absolute top-0 bottom-0 z-10"
      style={{ left: left - SPLITTER_WIDTH / 2, width: SPLITTER_WIDTH, cursor: "col-resize" }}
    >
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border/30 group-hover:bg-teal-400/60 group-active:bg-teal-400/80 transition-colors" />
    </div>
  );
}
