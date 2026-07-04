import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import type { FileDiff, Hunk, DiffLine } from "@/lib/ipc";
import { DIFF_STATUS_COLOR } from "@/lib/ipc";

interface Props {
  file: FileDiff;
  commitSummary: string;
  onClose: () => void;
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
      onClick={() => hunkAction.onClick(index)}
      disabled={hunkAction.pendingIndex !== null}
      className="text-[10px] normal-case font-sans text-blue-200 hover:text-white hover:bg-blue-500/20 rounded px-1.5 py-0.5 disabled:opacity-40"
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
      onClick={() => lineAction.onClick(hunkIndex, lineIndex)}
      disabled={lineAction.pending !== null}
      title={lineAction.label}
      className="group relative w-10 shrink-0 text-right pr-2 border-r border-border text-muted-foreground/50 hover:bg-blue-500/20 disabled:opacity-40 disabled:cursor-default"
    >
      <span className="group-hover:opacity-0 transition-opacity">{isPending ? "…" : value}</span>
      <ChevronRight
        size={12}
        className="absolute inset-0 m-auto opacity-0 group-hover:opacity-100 text-blue-200 transition-opacity"
      />
    </button>
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
    <div className="mb-0 font-mono text-xs">
      {/* Hunk header */}
      <div className="bg-blue-500/10 text-blue-300 px-3 py-0.5 select-none flex items-center justify-between">
        <span>{hunk.header}</span>
        {hunkAction && <HunkActionButton hunkAction={hunkAction} index={index} />}
      </div>

      {rows.map(({ key, oldNo, newNo, line }) => {
        const bg =
          line.kind === "addition"
            ? "bg-green-500/10"
            : line.kind === "deletion"
            ? "bg-red-500/10"
            : "";
        const fg =
          line.kind === "addition"
            ? "text-green-300"
            : line.kind === "deletion"
            ? "text-red-300"
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
  if (cell.kind === "addition") return "bg-green-500/10 text-green-300";
  if (cell.kind === "deletion") return "bg-red-500/10 text-red-300";
  if (cell.kind === "empty") return "bg-muted/20";
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
    <div className="mb-0 font-mono text-xs">
      <div className="bg-blue-500/10 text-blue-300 px-3 py-0.5 select-none flex items-center justify-between">
        <span>{hunk.header}</span>
        {hunkAction && <HunkActionButton hunkAction={hunkAction} index={index} />}
      </div>

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

export function FileDiffPanel({ file, commitSummary, onClose, hunkAction, fetchFullFile, lineAction }: Props) {
  const [scope, setScope] = useState<"hunks" | "full">("hunks");
  const [layout, setLayout] = useState<"unified" | "split">("unified");
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

  return (
    <div className="flex-1 flex flex-col overflow-hidden border-r border-border bg-background min-w-0">
      {/* Header */}
      <div className="shrink-0 border-b border-border flex items-center gap-2 px-2 py-1.5">
        <button
          onClick={onClose}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-white/5"
        >
          <ArrowLeft size={13} />
          Timeline
        </button>

        <span className="text-muted-foreground/40 text-xs">|</span>

        <span className={`text-xs font-bold uppercase ${DIFF_STATUS_COLOR[file.status]}`}>
          {file.status[0].toUpperCase()}
        </span>

        <span className="font-mono text-sm text-foreground/90 truncate min-w-0">
          {file.path}
        </span>
        {file.old_path && (
          <span className="text-muted-foreground text-xs shrink-0">← {file.old_path}</span>
        )}

        <span className="ml-auto text-xs text-muted-foreground truncate max-w-48 hidden lg:block" title={commitSummary}>
          {commitSummary}
        </span>
      </div>

      {/* Toolbar: scope (hunks/full file) + layout (unified/split) toggles */}
      <div className="shrink-0 border-b border-border flex items-center gap-2 px-2 py-1">
        {fetchFullFile && (
          <div className="flex items-center gap-0.5 bg-white/5 rounded p-0.5">
            {(["hunks", "full"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={[
                  "text-[10px] px-1.5 py-0.5 rounded transition-colors",
                  scope === s ? "bg-white/15 text-foreground" : "text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                {s === "hunks" ? "Hunks" : "Full file"}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-0.5 bg-white/5 rounded p-0.5 ml-auto">
          {(["unified", "split"] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLayout(l)}
              className={[
                "text-[10px] capitalize px-1.5 py-0.5 rounded transition-colors",
                layout === l ? "bg-white/15 text-foreground" : "text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {scope === "full" && fullFileError && (
        <div className="shrink-0 border-b border-border bg-yellow-500/10 text-yellow-400 text-xs px-3 py-1.5">
          Couldn't load full-file view — showing the regular hunk view instead.
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
            Binary or empty file — no textual diff available.
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
