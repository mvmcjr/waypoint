import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import type { FileDiff, Hunk, DiffLine } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import { fileLineStats, fileStatusStyle, splitPath } from "@/lib/fileStatus";
import { cn } from "@/lib/utils";
import { SegmentedToggle } from "@/components/SegmentedToggle";

const LAYOUT_OPTIONS = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Split" },
] as const;

const SCOPE_OPTIONS = [
  { value: "hunks", label: "Hunks" },
  { value: "full", label: "Full file" },
] as const;

/** Prev/next through the file list the diff was opened from. */
export interface FileNav {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

interface Props {
  file: FileDiff;
  /** What the diff belongs to — a commit summary, or "Staged changes". */
  commitSummary: string;
  /** Short hash shown beside the summary when the diff belongs to a commit. */
  commitOid?: string;
  onClose: () => void;
  nav?: FileNav;
  /**
   * When set, shows a per-hunk button (e.g. "Stage hunk" / "Unstage hunk").
   * `onClick`'s `fullFile` flag reflects whichever scope is currently active
   * (Hunks vs Full file) — the backend needs it to recompute the same-shaped
   * diff, since hunk numbering differs between the two.
   */
  hunkAction?: {
    label: string;
    pendingIndex: number | null;
    onClick: (hunkIndex: number, fullFile: boolean) => void;
  };
  /** When set, enables the "Full file" scope toggle, fetching the same file re-diffed with enough context to cover it in one hunk. */
  fetchFullFile?: () => Promise<FileDiff>;
  /** When set, shows a per-line button on addition/deletion rows (e.g. "Stage line" / "Unstage line"). See hunkAction on the `fullFile` flag. */
  lineAction?: {
    label: string;
    pending: { hunkIndex: number; lineIndex: number } | null;
    onClick: (hunkIndex: number, lineIndex: number, fullFile: boolean) => void;
  };
}

function parseHunkStart(header: string): { oldStart: number; newStart: number } {
  const m = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  return m
    ? { oldStart: parseInt(m[1], 10), newStart: parseInt(m[2], 10) }
    : { oldStart: 1, newStart: 1 };
}

// Internal, scope-resolved shapes: the public Props["hunkAction"/"lineAction"]
// onClick takes a `fullFile` flag, but child components below just render
// whatever's currently on screen — FileDiffPanel closes over the active
// scope once and hands these simpler callbacks down.
type ResolvedHunkAction = {
  label: string;
  pendingIndex: number | null;
  onClick: (hunkIndex: number) => void;
};
type ResolvedLineAction = {
  label: string;
  pending: { hunkIndex: number; lineIndex: number } | null;
  onClick: (hunkIndex: number, lineIndex: number) => void;
};

function HunkActionButton({
  hunkAction,
  index,
}: {
  hunkAction: ResolvedHunkAction;
  index: number;
}) {
  return (
    <button
      type="button"
      onClick={() => hunkAction.onClick(index)}
      disabled={hunkAction.pendingIndex !== null}
      className="text-[10px] normal-case font-sans text-foreground/80 hover:text-foreground bg-white/[0.04] hover:bg-white/[0.08] rounded px-1.5 py-0.5 active:translate-y-px disabled:opacity-40"
    >
      {hunkAction.pendingIndex === index ? "…" : hunkAction.label}
    </button>
  );
}

/**
 * A line-number gutter cell. When `lineAction` applies to this cell (i.e. it's
 * a non-empty addition/deletion line, not context), hovering swaps the number
 * for a chevron — click stages/unstages just that line, GitHub-Desktop-gutter
 * style — instead of a separate end-of-row button.
 */
function LineNumberCell({
  value,
  lineIndex,
  cellKind,
  hunkIndex,
  lineAction,
}: {
  value: string;
  lineIndex: number | undefined;
  cellKind: "context" | "addition" | "deletion" | "empty";
  hunkIndex: number;
  lineAction?: ResolvedLineAction;
}) {
  const clickable = !!lineAction && lineIndex !== undefined && cellKind !== "context";

  if (!clickable) {
    return (
      <span className="w-10 shrink-0 text-right pr-2 select-none text-muted-foreground/50 border-r border-border">
        {value}
      </span>
    );
  }

  const isPending = lineAction.pending?.hunkIndex === hunkIndex && lineAction.pending?.lineIndex === lineIndex;

  return (
    <button
      type="button"
      onClick={() => lineAction.onClick(hunkIndex, lineIndex)}
      disabled={lineAction.pending !== null}
      title={lineAction.label}
      aria-label={`${lineAction.label} ${value}`}
      className="group relative w-10 shrink-0 text-right pr-2 border-r border-border text-muted-foreground/50 hover:bg-white/[0.08] focus-visible:bg-white/[0.08] outline-none disabled:opacity-40 disabled:cursor-default"
    >
      <span className="group-hover:opacity-0 group-focus-visible:opacity-0 transition-opacity">{isPending ? "…" : value}</span>
      <ChevronRight
        size={12}
        aria-hidden
        className="absolute inset-0 m-auto opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 text-foreground transition-opacity"
      />
    </button>
  );
}

/** Neutral band — hunk headers are structure, not a state, so they carry no hue. */
function HunkHeader({ header, children }: { header: string; children?: React.ReactNode }) {
  return (
    <div className="bg-white/[0.03] text-muted-foreground px-3 py-0.5 select-none flex items-center justify-between gap-3">
      <span className="truncate">{header}</span>
      {children}
    </div>
  );
}

function HunkBlock({
  hunk,
  index,
  hunkAction,
  lineAction,
}: {
  hunk: Hunk;
  index: number;
  hunkAction?: ResolvedHunkAction;
  lineAction?: ResolvedLineAction;
}) {
  const { oldStart, newStart } = parseHunkStart(hunk.header);
  let oldLine = oldStart;
  let newLine = newStart;

  type Row = {
    key: number;
    oldNo: string;
    newNo: string;
    line: DiffLine;
  };

  const rows: Row[] = hunk.lines.map((line, i) => {
    let oldNo = "";
    let newNo = "";
    if (line.kind === "context") {
      oldNo = String(oldLine++);
      newNo = String(newLine++);
    } else if (line.kind === "deletion") {
      oldNo = String(oldLine++);
    } else {
      newNo = String(newLine++);
    }
    return { key: i, oldNo, newNo, line };
  });

  return (
    <div className="font-mono text-xs border-t border-border first:border-t-0">
      <HunkHeader header={hunk.header}>
        {hunkAction && <HunkActionButton hunkAction={hunkAction} index={index} />}
      </HunkHeader>

      {rows.map(({ key, oldNo, newNo, line }) => {
        const bg =
          line.kind === "addition"
            ? "bg-diff-add-bg"
            : line.kind === "deletion"
            ? "bg-diff-del-bg"
            : "";
        const fg =
          line.kind === "addition"
            ? "text-diff-add"
            : line.kind === "deletion"
            ? "text-diff-del"
            : "text-foreground/75";
        const prefix =
          line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " ";

        return (
          <div key={key} className={`flex ${bg}`}>
            {/* Old line number */}
            <LineNumberCell
              value={oldNo}
              lineIndex={oldNo ? key : undefined}
              cellKind={oldNo ? line.kind : "empty"}
              hunkIndex={index}
              lineAction={lineAction}
            />
            {/* New line number */}
            <LineNumberCell
              value={newNo}
              lineIndex={newNo ? key : undefined}
              cellKind={newNo ? line.kind : "empty"}
              hunkIndex={index}
              lineAction={lineAction}
            />
            {/* Prefix */}
            <span className={`w-4 shrink-0 text-center select-none ${fg}`}>{prefix}</span>
            {/* Content */}
            <span className={`flex-1 min-w-0 whitespace-pre-wrap break-all ${fg}`}>
              {line.content}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Side-by-side (split) rendering ──────────────────────────────────────────

type SplitCell = {
  lineNo: string;
  content: string;
  kind: "context" | "addition" | "deletion" | "empty";
  /** Index of this line within the original hunk.lines array — for lineAction. Only set for addition/deletion cells. */
  lineIndex?: number;
};

function buildSideBySideRows(hunk: Hunk): { left: SplitCell; right: SplitCell }[] {
  const { oldStart, newStart } = parseHunkStart(hunk.header);
  let oldLine = oldStart;
  let newLine = newStart;
  const rows: { left: SplitCell; right: SplitCell }[] = [];
  const lines = hunk.lines;
  let i = 0;

  while (i < lines.length) {
    if (lines[i].kind === "context") {
      const content = lines[i].content;
      rows.push({
        left: { lineNo: String(oldLine++), content, kind: "context" },
        right: { lineNo: String(newLine++), content, kind: "context" },
      });
      i++;
      continue;
    }
    // Consecutive deletions, then consecutive additions — the shape libgit2
    // emits for a changed region — paired up row by row, padding the shorter
    // side so both columns stay aligned.
    const dels: { line: DiffLine; idx: number }[] = [];
    while (i < lines.length && lines[i].kind === "deletion") { dels.push({ line: lines[i], idx: i }); i++; }
    const adds: { line: DiffLine; idx: number }[] = [];
    while (i < lines.length && lines[i].kind === "addition") { adds.push({ line: lines[i], idx: i }); i++; }

    const max = Math.max(dels.length, adds.length);
    for (let k = 0; k < max; k++) {
      const del = dels[k];
      const add = adds[k];
      rows.push({
        left: del
          ? { lineNo: String(oldLine++), content: del.line.content, kind: "deletion", lineIndex: del.idx }
          : { lineNo: "", content: "", kind: "empty" },
        right: add
          ? { lineNo: String(newLine++), content: add.line.content, kind: "addition", lineIndex: add.idx }
          : { lineNo: "", content: "", kind: "empty" },
      });
    }
  }

  return rows;
}

function splitCellClasses(cell: SplitCell): string {
  if (cell.kind === "addition") return "bg-diff-add-bg text-diff-add";
  if (cell.kind === "deletion") return "bg-diff-del-bg text-diff-del";
  if (cell.kind === "empty") return "bg-white/[0.02]";
  return "text-foreground/75";
}

function SideBySideHunkBlock({
  hunk,
  index,
  hunkAction,
  lineAction,
}: {
  hunk: Hunk;
  index: number;
  hunkAction?: ResolvedHunkAction;
  lineAction?: ResolvedLineAction;
}) {
  const rows = buildSideBySideRows(hunk);

  return (
    <div className="font-mono text-xs border-t border-border first:border-t-0">
      <HunkHeader header={hunk.header}>
        {hunkAction && <HunkActionButton hunkAction={hunkAction} index={index} />}
      </HunkHeader>

      {rows.map((row, i) => (
        <div key={i} className="flex">
          <div className={`flex flex-1 min-w-0 border-r border-border ${splitCellClasses(row.left)}`}>
            <LineNumberCell
              value={row.left.lineNo}
              lineIndex={row.left.lineIndex}
              cellKind={row.left.kind}
              hunkIndex={index}
              lineAction={lineAction}
            />
            <span className="flex-1 min-w-0 whitespace-pre-wrap break-all px-1">{row.left.content}</span>
          </div>
          <div className={`flex flex-1 min-w-0 ${splitCellClasses(row.right)}`}>
            <LineNumberCell
              value={row.right.lineNo}
              lineIndex={row.right.lineIndex}
              cellKind={row.right.kind}
              hunkIndex={index}
              lineAction={lineAction}
            />
            <span className="flex-1 min-w-0 whitespace-pre-wrap break-all px-1">{row.right.content}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────

/** Keys typed into a field or while a dialog/menu is open belong to that, not to the diff. */
function isForeignKeyTarget(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return true;
  return document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null;
}

function NavButton({ onClick, disabled, label, children }: {
  onClick: () => void; disabled: boolean; label: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-white/[0.07] active:translate-y-px disabled:opacity-30 disabled:pointer-events-none transition-colors"
    >
      {children}
    </button>
  );
}

export function FileDiffPanel({ file, commitSummary, commitOid, onClose, nav, hunkAction, fetchFullFile, lineAction }: Props) {
  // Layout and scope are preferences, not per-file state: they survive moving
  // between files (this panel remounts per file) and restarts.
  const layout = useStore((s) => s.diffLayout);
  const storedScope = useStore((s) => s.diffScope);
  const setViewPref = useStore((s) => s.setViewPref);
  const scope = fetchFullFile ? storedScope : "hunks";
  const [fullFileData, setFullFileData] = useState<FileDiff | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullFileError, setFullFileError] = useState(false);

  // Refetches whenever the caller supplies a new `file` (e.g. after staging a
  // hunk) while scope is "full", so the full-context view doesn't go stale.
  useEffect(() => {
    if (scope !== "full" || !fetchFullFile) return;
    let cancelled = false;
    setLoadingFull(true);
    fetchFullFile()
      .then((d) => { if (!cancelled) { setFullFileData(d); setFullFileError(false); } })
      .catch(() => { if (!cancelled) { setFullFileData(null); setFullFileError(true); } })
      .finally(() => { if (!cancelled) setLoadingFull(false); });
    return () => { cancelled = true; };
  }, [scope, file, fetchFullFile]);

  const activeHunks = scope === "full" && fullFileData ? fullFileData.hunks : file.hunks;
  // Tied to the SAME condition as activeHunks above, not just the scope
  // toggle: if the full-file fetch fails, activeHunks silently falls back to
  // the default-context `file.hunks`, and stage/unstage must be told that —
  // otherwise the backend would recompute full-context numbering for hunks
  // the user isn't actually looking at, staging the wrong content.
  const fullFile = scope === "full" && fullFileData !== null;
  const activeHunkAction: ResolvedHunkAction | undefined = hunkAction && {
    label: hunkAction.label,
    pendingIndex: hunkAction.pendingIndex,
    onClick: (hunkIndex) => hunkAction.onClick(hunkIndex, fullFile),
  };
  const activeLineAction: ResolvedLineAction | undefined = lineAction && {
    label: lineAction.label,
    pending: lineAction.pending,
    onClick: (hunkIndex, lineIndex) => lineAction.onClick(hunkIndex, lineIndex, fullFile),
  };

  // Esc → back to the timeline; [ ] or Alt+↑/↓ → previous/next file.
  // Read through a ref so the listener isn't re-bound on every render.
  const keysRef = useRef({ onClose, nav });
  keysRef.current = { onClose, nav };
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isForeignKeyTarget(e)) return;
      const { onClose, nav } = keysRef.current;
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (e.key === "Escape" && plain) {
        e.preventDefault();
        onClose();
      } else if (nav && ((e.key === "]" && plain) || (e.key === "ArrowDown" && e.altKey))) {
        e.preventDefault();
        if (nav.index < nav.total - 1) nav.onNext();
      } else if (nav && ((e.key === "[" && plain) || (e.key === "ArrowUp" && e.altKey))) {
        e.preventDefault();
        if (nav.index > 0) nav.onPrev();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const status = fileStatusStyle(file.status);
  const { dir, name } = splitPath(file.path);
  const stats = fileLineStats(file);

  return (
    <div className="flex-1 flex flex-col overflow-hidden border-r border-border bg-background min-w-0">
      {/* Header: back · file · (commit context) · file navigation */}
      <div className="shrink-0 h-9 border-b border-border flex items-center gap-2 px-2">
        <button
          type="button"
          onClick={onClose}
          title="Back to timeline (Esc)"
          className="flex shrink-0 items-center gap-1 h-6 text-xs text-muted-foreground hover:text-foreground px-1.5 rounded-md hover:bg-white/[0.07] active:translate-y-px transition-colors"
        >
          <ArrowLeft size={13} aria-hidden />
          Timeline
        </button>

        <div className="w-px h-3.5 bg-border shrink-0" aria-hidden />

        <span className={cn("shrink-0 font-mono text-[11px] font-semibold", status.color)} title={status.label}>
          {status.letter}
        </span>
        <h2 className="min-w-0 truncate font-mono text-xs" title={file.old_path ? `${file.old_path} → ${file.path}` : file.path}>
          {dir && <span className="text-muted-foreground">{dir}/</span>}
          <span className="text-foreground">{name}</span>
          {file.old_path && <span className="text-muted-foreground"> ← {file.old_path}</span>}
        </h2>

        <div className="ml-auto flex shrink-0 items-center gap-2 min-w-0">
          <span className="hidden lg:flex items-center gap-1.5 min-w-0 max-w-64 text-xs text-muted-foreground" title={commitSummary}>
            {commitOid && <span className="font-mono text-[11px] text-foreground/60">{commitOid.slice(0, 7)}</span>}
            <span className="truncate">{commitSummary}</span>
          </span>

          {nav && nav.total > 1 && (
            <div className="flex items-center gap-0.5" role="group" aria-label="File navigation">
              <NavButton onClick={nav.onPrev} disabled={nav.index <= 0} label="Previous file ([)">
                <ChevronLeft size={14} aria-hidden />
              </NavButton>
              <span className="min-w-12 text-center text-[11px] tabular-nums text-muted-foreground" aria-live="polite">
                {nav.index + 1} / {nav.total}
              </span>
              <NavButton onClick={nav.onNext} disabled={nav.index >= nav.total - 1} label="Next file (])">
                <ChevronRight size={14} aria-hidden />
              </NavButton>
            </div>
          )}
        </div>
      </div>

      {/* Toolbar: line counts · scope (hunks/full file) · layout (unified/split) */}
      <div className="shrink-0 h-8 border-b border-border flex items-center gap-3 px-3">
        {!file.binary && (stats.added > 0 || stats.removed > 0) && (
          <span className="flex gap-1.5 font-mono text-[11px] tabular-nums" aria-label={`${stats.added} lines added, ${stats.removed} removed`}>
            <span className="text-diff-add">+{stats.added}</span>
            <span className="text-diff-del">−{stats.removed}</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {fetchFullFile && (
            <SegmentedToggle
              label="Diff scope"
              value={scope}
              options={SCOPE_OPTIONS}
              onChange={(v) => setViewPref("diffScope", v)}
            />
          )}
          <SegmentedToggle
            label="Diff layout"
            value={layout}
            options={LAYOUT_OPTIONS}
            onChange={(v) => setViewPref("diffLayout", v)}
          />
        </div>
      </div>

      {scope === "full" && fullFileError && (
        <div className="shrink-0 border-b border-border bg-amber-500/10 text-amber-300 text-xs px-3 py-1.5" role="status">
          Couldn't load the full-file view — showing hunks instead.
        </div>
      )}

      {/* Diff content */}
      <div className="flex-1 overflow-auto">
        {scope === "full" && loadingFull && !fullFileData ? (
          // Only block on the *first* full-file fetch. Later refetches (e.g.
          // after staging a line) keep rendering the stale hunks underneath —
          // swapping in a placeholder here would collapse this scrollable
          // container's height and reset its scroll position to the top.
          <div className="px-4 py-6 text-xs text-muted-foreground">Loading full file…</div>
        ) : activeHunks.length === 0 ? (
          <div className="px-4 py-6 text-xs text-muted-foreground">
            {file.binary
              ? "Binary file — there's no text diff to show."
              : "No content changes — the file is empty, or only its mode changed."}
          </div>
        ) : (
          <div className="border-b border-border">
            {activeHunks.map((hunk, i) =>
              layout === "unified" ? (
                <HunkBlock key={i} hunk={hunk} index={i} hunkAction={activeHunkAction} lineAction={activeLineAction} />
              ) : (
                <SideBySideHunkBlock key={i} hunk={hunk} index={i} hunkAction={activeHunkAction} lineAction={activeLineAction} />
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
