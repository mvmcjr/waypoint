import { useState, useRef, useEffect } from "react";
import { format } from "date-fns";
import { Copy, Check, ChevronLeft, ChevronRight } from "lucide-react";
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
  const [collapsed, setCollapsed] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the reset-timer if the component unmounts before it fires.
  useEffect(() => () => {
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
  }, []);

  // Re-expand when the user selects a different commit.
  useEffect(() => { setCollapsed(false); }, [commit.oid]);

  const date = new Date(commit.timestamp * 1000);

  async function copyHash() {
    try {
      await navigator.clipboard.writeText(commit.oid);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      setCopied(true);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — no UI change.
    }
  }

  if (collapsed) {
    return (
      <aside className="w-8 shrink-0 border-l border-border flex flex-col bg-card items-center pt-2 overflow-hidden">
        <button
          onClick={() => setCollapsed(false)}
          className="p-1 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
          title="Expand commit detail"
        >
          <ChevronLeft size={14} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="w-80 shrink-0 border-l border-border flex flex-col bg-card overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Commit</span>
        <button
          onClick={() => setCollapsed(true)}
          className="p-0.5 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
          title="Collapse"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* Meta */}
      <div className="p-3 space-y-2 text-sm shrink-0">
        <p className="font-medium text-foreground leading-snug">{commit.summary}</p>
        {commit.body && (
          <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
            {commit.body}
          </p>
        )}
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
