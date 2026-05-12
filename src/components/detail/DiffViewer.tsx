import type { FileDiff } from "@/lib/ipc";
import { useState } from "react";

interface Props {
  files: FileDiff[];
}

function HunkView({ hunk }: { hunk: FileDiff["hunks"][number] }) {
  return (
    <div className="text-xs font-mono">
      <div className="bg-blue-500/10 text-blue-300 px-2 py-0.5">{hunk.header}</div>
      {hunk.lines.map((line, i) => {
        const cls =
          line.kind === "addition"
            ? "bg-green-500/10 text-green-300"
            : line.kind === "deletion"
            ? "bg-red-500/10 text-red-300"
            : "text-foreground/70";
        const prefix = line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " ";
        return (
          <div key={i} className={`px-2 whitespace-pre-wrap break-all ${cls}`}>
            {prefix}
            {line.content}
          </div>
        );
      })}
    </div>
  );
}

function FileDiffView({ file }: { file: FileDiff }) {
  const [open, setOpen] = useState(true);

  const statusColor: Record<FileDiff["status"], string> = {
    added: "text-green-400",
    deleted: "text-red-400",
    modified: "text-yellow-400",
    renamed: "text-blue-400",
    copied: "text-cyan-400",
    other: "text-muted-foreground",
  };

  return (
    <div className="border border-border rounded mb-2">
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-white/5"
        onClick={() => setOpen((o) => !o)}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span className={`text-xs font-mono uppercase font-bold ${statusColor[file.status]}`}>
          {file.status[0].toUpperCase()}
        </span>
        <span className="font-mono truncate text-foreground/90">{file.path}</span>
        {file.old_path && (
          <span className="text-muted-foreground text-xs">← {file.old_path}</span>
        )}
      </button>
      {open && (
        <div className="border-t border-border">
          {file.hunks.map((hunk, i) => (
            <HunkView key={i} hunk={hunk} />
          ))}
          {file.hunks.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">Binary or empty file</div>
          )}
        </div>
      )}
    </div>
  );
}

export function DiffViewer({ files }: Props) {
  if (files.length === 0) {
    return <div className="text-xs text-muted-foreground px-3 py-2">No changes in this commit.</div>;
  }

  return (
    <div className="overflow-auto flex-1 p-2">
      {files.map((file) => (
        <FileDiffView key={file.path} file={file} />
      ))}
    </div>
  );
}
