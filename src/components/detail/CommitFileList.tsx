import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FileDiff } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import { ancestorDirs, buildFileTree, collectDirPaths, type TreeNode } from "@/lib/fileTree";
import { fileLineStats, type LineStats } from "@/lib/fileStatus";
import { DirRow, FileRow, handleFileListKeyDown } from "@/components/files/FileRow";
import { SegmentedToggle } from "@/components/SegmentedToggle";

const ROW_HEIGHT = 24;
/** Below this many rows, render plainly; above it, only what's on screen. */
const VIRTUALIZE_ABOVE = 200;

const VIEW_OPTIONS = [
  { value: "path", label: "Path" },
  { value: "tree", label: "Tree" },
] as const;

type Row =
  | { kind: "file"; key: string; depth: number; file: FileDiff }
  | { kind: "dir"; key: string; depth: number; name: string; path: string; expanded: boolean };

function flattenTree(nodes: TreeNode<FileDiff>[], expanded: Set<string>, depth = 0, out: Row[] = []): Row[] {
  for (const n of nodes) {
    if (n.kind === "file") {
      out.push({ kind: "file", key: n.file.path, depth, file: n.file });
    } else {
      const isOpen = expanded.has(n.path);
      out.push({ kind: "dir", key: `dir:${n.path}`, depth, name: n.name, path: n.path, expanded: isOpen });
      if (isOpen) flattenTree(n.children, expanded, depth + 1, out);
    }
  }
  return out;
}

function LineCounts({ stats, binary }: { stats: LineStats; binary: boolean }) {
  if (binary) return <span className="font-mono text-[10px] text-muted-foreground/70">bin</span>;
  return (
    <span className="flex gap-1.5 font-mono text-[10px] tabular-nums">
      {stats.added > 0 && <span className="text-diff-add/80">+{stats.added}</span>}
      {stats.removed > 0 && <span className="text-diff-del/80">−{stats.removed}</span>}
    </span>
  );
}

function statsDetail(stats: LineStats, binary: boolean): string {
  if (binary) return "binary file";
  return `${stats.added} ${stats.added === 1 ? "line" : "lines"} added, ${stats.removed} removed`;
}

interface Props {
  files: FileDiff[];
  /** The panel's scroll container — the list scrolls together with the commit message above it. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  selectedPath: string | null;
  onFileClick?: (file: FileDiff) => void;
  /** Shown under the header for merge commits: which parent the list is diffed against. */
  note?: React.ReactNode;
}

export function CommitFileList({ files, scrollRef, selectedPath, onFileClick, note }: Props) {
  const view = useStore((s) => s.fileListView);
  const setViewPref = useStore((s) => s.setViewPref);

  const tree = useMemo(() => buildFileTree(files), [files]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set(collectDirPaths(tree)));
  // New commit → every folder starts open.
  useEffect(() => { setExpandedDirs(new Set(collectDirPaths(tree))); }, [tree]);

  // Keep the open file visible in tree view: prev/next in the diff panel can
  // land on a file inside a folder the user had closed.
  useEffect(() => {
    if (!selectedPath || view !== "tree") return;
    const ancestors = ancestorDirs(selectedPath);
    setExpandedDirs((prev) => (ancestors.every((d) => prev.has(d)) ? prev : new Set([...prev, ...ancestors])));
  }, [selectedPath, view]);

  const stats = useMemo(() => new Map(files.map((f) => [f.path, fileLineStats(f)])), [files]);
  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const s of stats.values()) { added += s.added; removed += s.removed; }
    return { added, removed };
  }, [stats]);

  const rows: Row[] = useMemo(
    () =>
      view === "tree"
        ? flattenTree(tree, expandedDirs)
        : files.map((file) => ({ kind: "file", key: file.path, depth: 0, file })),
    [view, tree, expandedDirs, files],
  );

  function toggleDir(path: string) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  // The list sits below the commit message inside one scroll container, so the
  // virtualizer needs the list's offset within it — re-measured whenever the
  // message block above changes height (the body loads lazily).
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const list = listRef.current;
    const scroller = scrollRef.current;
    if (!list || !scroller) return;
    // offsetTop is relative to the scroll container, which is `position: relative`.
    const measure = () => setScrollMargin(list.offsetTop);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    for (const child of Array.from(scroller.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [scrollRef]);

  const virtualize = rows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
    scrollMargin,
    // The sticky files header covers the top 32px of the scroll area.
    scrollPaddingStart: 32,
    enabled: virtualize,
  });

  // Follow prev/next from the diff panel: bring the open file's row into view.
  useEffect(() => {
    if (!selectedPath) return;
    const index = rows.findIndex((r) => r.kind === "file" && r.file.path === selectedPath);
    if (index === -1) return;
    if (virtualize) {
      virtualizer.scrollToIndex(index, { align: "auto" });
    } else {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-row-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
    // Only when the selection moves — not on every expand/collapse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath]);

  function renderRow(row: Row) {
    if (row.kind === "dir") {
      return (
        <DirRow name={row.name} expanded={row.expanded} depth={row.depth} onToggle={() => toggleDir(row.path)} />
      );
    }
    const s = stats.get(row.file.path) ?? { added: 0, removed: 0 };
    return (
      <FileRow
        path={row.file.path}
        status={row.file.status}
        oldPath={row.file.old_path}
        treeMode={view === "tree"}
        depth={row.depth}
        selected={row.file.path === selectedPath}
        onOpen={() => onFileClick?.(row.file)}
        trailing={<LineCounts stats={s} binary={row.file.binary} />}
        detail={statsDetail(s, row.file.binary)}
      />
    );
  }

  return (
    <section aria-label="Changed files">
      <div className="sticky top-0 z-10 flex h-8 items-center gap-2 border-y border-border bg-card px-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Files</h3>
        <span className="text-[10px] tabular-nums text-muted-foreground/70">{files.length}</span>
        {(totals.added > 0 || totals.removed > 0) && (
          <span className="flex gap-1.5 font-mono text-[10px] tabular-nums" aria-label={`${totals.added} lines added, ${totals.removed} removed`}>
            <span className="text-diff-add/80">+{totals.added}</span>
            <span className="text-diff-del/80">−{totals.removed}</span>
          </span>
        )}
        <div className="ml-auto">
          <SegmentedToggle
            label="File list view"
            value={view}
            options={VIEW_OPTIONS}
            onChange={(v) => setViewPref("fileListView", v)}
          />
        </div>
      </div>

      {note}

      <div onKeyDown={handleFileListKeyDown} className="py-1">
        <div ref={listRef} className="relative" style={virtualize ? { height: virtualizer.getTotalSize() } : undefined}>
          {virtualize
            ? virtualizer.getVirtualItems().map((item) => (
                <div
                  key={rows[item.index].key}
                  data-row-index={item.index}
                  className="absolute inset-x-0 top-0"
                  style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
                >
                  {renderRow(rows[item.index])}
                </div>
              ))
            : rows.map((row, i) => (
                // scroll-mt clears the sticky files header when scrolled into view.
                <div key={row.key} data-row-index={i} className="scroll-mt-9">
                  {renderRow(row)}
                </div>
              ))}
        </div>
      </div>
    </section>
  );
}
