import { useState } from "react";
import { format } from "date-fns";
import { Copy, Check } from "lucide-react";
import { useCommitDiff } from "@/lib/queries";
import type { FileDiff, PositionedCommit } from "@/lib/ipc";
import { DiffViewer } from "./DiffViewer";
import { Separator } from "@/components/ui/separator";

interface Props {
  repoId: string;
  item: PositionedCommit;
  onFileClick?: (file: FileDiff) => void;
}

export function CommitDetail({ repoId, item, onFileClick }: Props) {
  const { commit } = item;
  const { data: diff, isLoading } = useCommitDiff(repoId, commit.oid);
  const [copied, setCopied] = useState(false);

  const date = new Date(commit.timestamp * 1000);

  function copyHash() {
    navigator.clipboard.writeText(commit.oid);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <aside className="w-80 shrink-0 border-l border-border flex flex-col bg-card overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        Commit
      </div>

      {/* Meta */}
      <div className="p-3 space-y-2 text-sm shrink-0">
        <p className="font-medium text-foreground leading-snug">{commit.summary}</p>
        <Separator />
        <div className="space-y-1 text-xs text-muted-foreground">
          <div className="flex gap-2 items-center">
            <span className="w-14 shrink-0 font-semibold text-foreground/60">Hash</span>
            <button
              onClick={copyHash}
              title="Copy full hash"
              className="flex items-center gap-1 font-mono truncate rounded px-1 -mx-1 hover:bg-muted transition-colors cursor-pointer group"
            >
              <span className="truncate">{commit.oid.slice(0, 12)}</span>
              {copied
                ? <Check className="size-3 shrink-0 text-green-500" />
                : <Copy className="size-3 shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" />
              }
            </button>
          </div>
          <div className="flex gap-2">
            <span className="w-14 shrink-0 font-semibold text-foreground/60">Author</span>
            <span className="truncate">{commit.author_name}</span>
          </div>
          <div className="flex gap-2">
            <span className="w-14 shrink-0 font-semibold text-foreground/60">Email</span>
            <span className="truncate">{commit.author_email}</span>
          </div>
          <div className="flex gap-2">
            <span className="w-14 shrink-0 font-semibold text-foreground/60">Date</span>
            <span>{format(date, "PPpp")}</span>
          </div>
          {commit.parent_oids.length > 0 && (
            <div className="flex gap-2">
              <span className="w-14 shrink-0 font-semibold text-foreground/60">Parents</span>
              <span className="font-mono truncate">
                {commit.parent_oids.map((p) => p.slice(0, 8)).join(", ")}
              </span>
            </div>
          )}
        </div>
      </div>

      <Separator />

      {/* Diff */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Loading diff…
        </div>
      ) : (
        diff && <DiffViewer files={diff} onFileClick={onFileClick} />
      )}
    </aside>
  );
}
