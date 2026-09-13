import { useRef, useState, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PositionedCommit } from "@/lib/ipc";
import { useRepoStatus, useRefs, useStashes } from "@/lib/queries";
import { clamp, isStashCommit, stashLabel } from "@/lib/utils";
import { GraphLayer, LANE_WIDTH, ROW_HEIGHT, REFS_COL_WIDTH } from "./GraphLayer";
import { CommitRow } from "./CommitRow";
import { WipRow } from "./WipRow";
import { CommitContextMenu, type CommitAction } from "./CommitContextMenu";
import { StashContextMenu } from "./StashContextMenu";
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
  multiSelectedOids: string[];
  headOid: string | null;
  headBranch: string | null;
  onSelectOid: (oid: string, mods: { ctrl: boolean; shift: boolean }) => void;
  onCommitAction: (action: CommitAction) => void;
  onRefAction?: (action: RefAction) => void;
  onWipClick: () => void;
  wipSelected: boolean;
  /** Oids currently matching a "go to commit" find; null when no query is active (no dimming). */
  matchOids?: Set<string> | null;
  /** Query tokens to highlight inside matching rows. */
  highlightTokens?: string[];
}

const NO_HIGHLIGHTS: string[] = [];

export const Timeline = forwardRef<TimelineHandle, Props>(function Timeline(
  { repoId, commits, selectedOid, multiSelectedOids, headOid, headBranch, onSelectOid, onCommitAction, onRefAction, onWipClick, wipSelected, matchOids, highlightTokens }: Props,
  ref
) {
  const multiSelectedSet = useMemo(() => new Set(multiSelectedOids), [multiSelectedOids]);
  // Tracks which row's context menu is open, so the row stays highlighted while it's up
  // (right-clicking doesn't otherwise change selection, so nothing else marks the target).
  const [contextTargetOid, setContextTargetOid] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  // Height of the scroll viewport — mirrors the native scrollbar's track height,
  // so match ticks line up with where the browser draws the thumb.
  const [trackHeight, setTrackHeight] = useState(0);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return; // not implemented in jsdom
    const el = parentRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setTrackHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { data: status } = useRepoStatus(repoId);
  const { data: stashes = [] } = useStashes(repoId);
  const { data: refs = [] } = useRefs(repoId);
  const pushedTagNames = useMemo(
    () => new Set(refs.filter((r) => r.kind === "tag" && r.is_pushed).map((r) => r.shorthand)),
    [refs],
  );
  // Local branch shorthand -> the other worktree's path it's checked out in.
  // Only local branches can carry worktree_path (see RefInfo).
  const worktreeByBranch = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of refs) {
      if (r.kind === "local_branch" && r.worktree_path) map.set(r.shorthand, r.worktree_path);
    }
    return map;
  }, [refs]);
  const stashOids = useMemo(() => new Set(stashes.map((s) => s.oid)), [stashes]);
  const stashByOid = useMemo(() => new Map(stashes.map((s) => [s.oid, s])), [stashes]);

  const mergeInProgress = !!status?.merge_in_progress;
  const hasWip = !!status && ((status.staged_count + status.unstaged_count) > 0 || mergeInProgress);
  // WIP row is virtual index 0 when visible; commits are offset by this amount.
  const wipOffset = hasWip ? 1 : 0;

  const [refsWidth, setRefsWidth] = useState(() =>
    readStored(LS_REFS_WIDTH, REFS_COL_WIDTH, REFS_WIDTH_MIN, REFS_WIDTH_MAX),
  );
  const [graphExtra, setGraphExtra] = useState(() =>
    readStored(LS_GRAPH_EXTRA, 0, GRAPH_EXTRA_MIN, GRAPH_EXTRA_MAX),
  );

  // Stable callbacks — ref pattern so CommitRow.memo never sees a changed function reference.
  const onSelectOidRef = useRef(onSelectOid);
  onSelectOidRef.current = onSelectOid;
  const stableSelectOid = useCallback(
    (oid: string, mods: { ctrl: boolean; shift: boolean }) => onSelectOidRef.current(oid, mods),
    [],
  );
  // GraphLayer selects a single node (no modifier semantics).
  const stableSelectNode = useCallback((oid: string) => onSelectOidRef.current(oid, { ctrl: false, shift: false }), []);

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
    count: commits.length + wipOffset,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  useImperativeHandle(ref, () => ({
    scrollToOid(oid: string) {
      const idx = commits.findIndex((c) => c.commit.oid === oid);
      if (idx !== -1) rowVirtualizer.scrollToIndex(idx + wipOffset, { align: "center" });
    },
  }), [commits, rowVirtualizer, wipOffset]);

  const maxLanes = useMemo(() => commits.reduce((m, c) => {
    let n = Math.max(m, c.lane + 1);
    for (const e of c.edges) n = Math.max(n, e.from_lane + 1, e.to_lane + 1);
    return n;
  }, 1), [commits]);
  const headCommit = useMemo(
    () => commits.find((c) => c.commit.oid === headOid) ?? null,
    [commits, headOid],
  );

  // Match-position ticks for the scrollbar-track overlay. Deduped by rounded
  // pixel position so a large match set doesn't render one node per match;
  // a tick wins "selected" styling if any commit collapsed into it is selected.
  const matchTicks = useMemo(() => {
    if (!matchOids || matchOids.size === 0 || trackHeight === 0) return [];
    const totalRows = commits.length + wipOffset;
    if (totalRows === 0) return [];
    const byPixel = new Map<number, boolean>();
    commits.forEach((c, i) => {
      if (!matchOids.has(c.commit.oid)) return;
      const top = Math.round(((i + wipOffset) / totalRows) * trackHeight);
      byPixel.set(top, (byPixel.get(top) ?? false) || c.commit.oid === selectedOid);
    });
    return Array.from(byPixel, ([top, isSelected]) => ({ top, isSelected }));
  }, [commits, matchOids, wipOffset, trackHeight, selectedOid]);

  // A repo with no commits yet still has a WIP row to show — bailing out here would
  // hide the only way to stage and create the first commit.
  if (commits.length === 0 && wipOffset === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No commits found.
      </div>
    );
  }

  const naturalGraphWidth = maxLanes * LANE_WIDTH + LANE_WIDTH;
  const graphColWidth = naturalGraphWidth + graphExtra;

  const virtualItems = rowVirtualizer.getVirtualItems();
  const startRow = virtualItems.length > 0 ? virtualItems[0].index : 0;
  const visibleRows = virtualItems.length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      <div ref={parentRef} className="flex-1 overflow-auto relative" style={{ contain: "strict" }}>
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
          {/* SVG graph layer — offset by the refs column so it sits between refs and message */}
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
              onSelectOid={stableSelectNode}
              selectedOid={selectedOid}
              headOid={headOid}
              headCommit={headCommit}
              wipOffset={wipOffset}
              mergeInProgress={mergeInProgress}
              stashOids={stashOids}
            />
          </div>

          {/* Commit rows (+ WIP row at virtual index 0 when dirty) */}
          <div
            style={{
              position: "absolute",
              top: startRow * ROW_HEIGHT,
              left: 0,
              right: 0,
            }}
          >
            {virtualItems.map((virtualItem) => {
              if (wipOffset > 0 && virtualItem.index === 0) {
                return (
                  <WipRow
                    key="wip"
                    refsWidth={refsWidth}
                    graphWidth={graphColWidth}
                    stagedCount={status!.staged_count}
                    unstagedCount={status!.unstaged_count}
                    mergeInProgress={mergeInProgress}
                    isSelected={wipSelected}
                    onClick={onWipClick}
                  />
                );
              }
              const item = commits[virtualItem.index - wipOffset];
              const isStash = isStashCommit(item.commit.oid, item.commit.summary, stashOids);
              const stashEntry = stashByOid.get(item.commit.oid);

              const row = (
                <CommitRow
                  item={item}
                  refsWidth={refsWidth}
                  graphWidth={graphColWidth}
                  isSelected={item.commit.oid === selectedOid || multiSelectedSet.has(item.commit.oid)}
                  isContextTarget={contextTargetOid === item.commit.oid}
                  isHead={item.commit.oid === headOid}
                  headBranch={headBranch}
                  pushedTagNames={pushedTagNames}
                  isStash={isStash}
                  stashName={stashEntry ? stashLabel(stashEntry.message) : undefined}
                  isDimmed={matchOids != null && !matchOids.has(item.commit.oid)}
                  highlightTokens={matchOids?.has(item.commit.oid) ? highlightTokens : NO_HIGHLIGHTS}
                  worktreeByBranch={worktreeByBranch}
                  onRefAction={stableRefAction}
                  onCommitAction={stableCommitAction}
                  onSelect={stableSelectOid}
                />
              );

              const oid = item.commit.oid;
              const handleMenuOpenChange = (open: boolean) =>
                setContextTargetOid((prev) => (open ? oid : prev === oid ? null : prev));

              // Stash rows aren't real commits — give them Pop/Apply/Drop instead
              // of the checkout/merge/rebase commit menu.
              if (isStash && repoId && stashEntry) {
                return (
                  <StashContextMenu
                    key={oid}
                    repoId={repoId}
                    oid={stashEntry.oid}
                    index={stashEntry.index}
                    currentName={stashLabel(stashEntry.message)}
                    onOpenChange={handleMenuOpenChange}
                  >
                    {row}
                  </StashContextMenu>
                );
              }

              return (
                <CommitContextMenu
                  key={oid}
                  item={item}
                  onAction={stableCommitAction}
                  onRefAction={stableRefAction}
                  worktreeByBranch={worktreeByBranch}
                  selectedOids={multiSelectedOids}
                  onOpenChange={handleMenuOpenChange}
                >
                  {row}
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
      <ColumnSplitter
        left={refsWidth + graphColWidth}
        onMouseDown={beginDrag(setGraphExtra, graphExtra, GRAPH_EXTRA_MIN, GRAPH_EXTRA_MAX, LS_GRAPH_EXTRA)}
      />

      {/* Match-position strip — overlays the scrollbar track, doesn't scroll with content */}
      {matchOids != null && matchOids.size > 0 && (
        <div data-testid="match-tick-strip" className="absolute right-0 top-0 bottom-0 w-[14px] pointer-events-none">
          {matchTicks.map((t) => (
            <div
              key={t.top}
              data-testid="match-tick"
              className={[
                "absolute left-[3px] right-[3px] h-[2px]",
                t.isSelected ? "bg-foreground" : "bg-foreground/45",
              ].join(" ")}
              style={{ top: t.top }}
            />
          ))}
        </div>
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
