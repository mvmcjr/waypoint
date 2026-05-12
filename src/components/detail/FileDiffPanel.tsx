import { ArrowLeft } from "lucide-react";
import type { FileDiff, Hunk, DiffLine } from "@/lib/ipc";

interface Props {
  file: FileDiff;
  commitSummary: string;
  onClose: () => void;
}

const STATUS_COLOR: Record<FileDiff["status"], string> = {
  added: "text-green-400",
  deleted: "text-red-400",
  modified: "text-yellow-400",
  renamed: "text-blue-400",
  copied: "text-cyan-400",
  other: "text-muted-foreground",
};

function parseHunkStart(header: string): { oldStart: number; newStart: number } {
  const m = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  return m
    ? { oldStart: parseInt(m[1], 10), newStart: parseInt(m[2], 10) }
    : { oldStart: 1, newStart: 1 };
}

function HunkBlock({ hunk }: { hunk: Hunk }) {
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
      <div className="bg-blue-500/10 text-blue-300 px-3 py-0.5 select-none">
        {hunk.header}
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
            <span className="w-10 shrink-0 text-right pr-2 select-none text-muted-foreground/50 border-r border-border">
              {oldNo}
            </span>
            {/* New line number */}
            <span className="w-10 shrink-0 text-right pr-2 select-none text-muted-foreground/50 border-r border-border">
              {newNo}
            </span>
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

export function FileDiffPanel({ file, commitSummary, onClose }: Props) {
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

        <span className={`text-xs font-bold uppercase ${STATUS_COLOR[file.status]}`}>
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

      {/* Diff content */}
      <div className="flex-1 overflow-auto">
        {file.hunks.length === 0 ? (
          <div className="px-4 py-6 text-xs text-muted-foreground">
            Binary or empty file — no textual diff available.
          </div>
        ) : (
          <div className="border-b border-border">
            {file.hunks.map((hunk, i) => (
              <HunkBlock key={i} hunk={hunk} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
