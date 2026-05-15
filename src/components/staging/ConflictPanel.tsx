import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { GitMerge, Check, X, AlertTriangle, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { useMergeStatus } from "@/lib/queries";
import { ConflictHunkPicker } from "./ConflictHunkPicker";

interface Props {
  repoId: string;
  onDone: () => void;
}

export function ConflictPanel({ repoId, onDone }: Props) {
  const qc = useQueryClient();
  const { data: merge } = useMergeStatus(repoId);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);

  useEffect(() => {
    if (merge?.default_message && !message) {
      setMessage(merge.default_message);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merge?.default_message]);

  if (!merge || !merge.in_progress) return null;

  const isCherryPick = merge.kind === "cherry_pick";

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["staging", repoId] });
    qc.invalidateQueries({ queryKey: ["status", repoId] });
    qc.invalidateQueries({ queryKey: ["merge-status", repoId] });
  }

  async function handleResolveOurs(path: string) {
    setWorking(true);
    setExpandedPath(null);
    try { await ipc.resolveOurs(repoId, path); invalidate(); }
    catch (e) { setError(String(e)); }
    finally { setWorking(false); }
  }

  async function handleResolveTheirs(path: string) {
    setWorking(true);
    setExpandedPath(null);
    try { await ipc.resolveTheirs(repoId, path); invalidate(); }
    catch (e) { setError(String(e)); }
    finally { setWorking(false); }
  }

  async function handleAbort() {
    setWorking(true);
    setError(null);
    try { await ipc.abortMerge(repoId); invalidate(); onDone(); }
    catch (e) { setError(String(e)); }
    finally { setWorking(false); }
  }

  async function handleFinish() {
    const msg = message.trim();
    if (!msg) return;
    setCommitting(true);
    setError(null);
    try {
      if (isCherryPick) {
        await ipc.finishCherryPick(repoId, msg);
      } else {
        await ipc.finishMerge(repoId, msg);
      }
      onDone();
    }
    catch (e) { setError(String(e)); }
    finally { setCommitting(false); }
  }

  const conflicts = merge.conflicted_paths;
  const hasConflicts = conflicts.length > 0;
  const disabled = working || committing;
  const canFinish = !hasConflicts && message.trim().length > 0 && !committing;

  return (
    <div className="flex flex-col h-full border-l border-border text-sm overflow-hidden">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-1.5">
          <GitMerge size={13} className="text-orange-400 shrink-0" />
          <span className="font-semibold text-orange-300 text-xs uppercase tracking-wide">
            {isCherryPick ? "Cherry-pick in Progress" : "Merge in Progress"}
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-destructive hover:text-destructive gap-1 shrink-0"
          onClick={handleAbort}
          disabled={disabled}
        >
          <X size={11} />
          Abort
        </Button>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {hasConflicts && (
          <>
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-orange-400/80 font-semibold border-b border-border/30">
              Conflicts ({conflicts.length})
            </div>
            {conflicts.map((path) => {
              const parts = path.split("/");
              const name = parts[parts.length - 1];
              const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
              const expanded = expandedPath === path;

              return (
                <div key={path} className="border-b border-border/20 last:border-b-0">
                  {/* File row */}
                  <div className="flex items-center gap-1 py-1 px-2 hover:bg-white/[0.04]">
                    {/* Expand toggle + filename */}
                    <button
                      className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
                      onClick={() => setExpandedPath(expanded ? null : path)}
                      disabled={disabled}
                    >
                      <ChevronRight
                        size={10}
                        className={`text-muted-foreground/45 shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
                      />
                      <AlertTriangle size={10} className="text-orange-400 shrink-0" />
                      <span className="flex-1 min-w-0 truncate text-xs leading-tight">
                        <span className="text-foreground/85">{name}</span>
                        {dir && <span className="text-muted-foreground/50 ml-1.5 text-[10px]">{dir}</span>}
                      </span>
                    </button>
                    {/* Quick whole-file resolution */}
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => handleResolveOurs(path)}
                        disabled={disabled}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-blue-400/35 text-blue-300/80 hover:text-blue-200 hover:bg-blue-400/10 disabled:opacity-30 transition-colors"
                        title="Accept our version (pre-merge)"
                      >
                        Ours
                      </button>
                      <button
                        onClick={() => handleResolveTheirs(path)}
                        disabled={disabled}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-purple-400/35 text-purple-300/80 hover:text-purple-200 hover:bg-purple-400/10 disabled:opacity-30 transition-colors"
                        title="Accept their version (incoming)"
                      >
                        Theirs
                      </button>
                    </div>
                  </div>

                  {/* Inline hunk picker */}
                  {expanded && (
                    <ConflictHunkPicker
                      repoId={repoId}
                      path={path}
                      onResolved={() => {
                        setExpandedPath(null);
                        invalidate();
                      }}
                    />
                  )}
                </div>
              );
            })}
          </>
        )}

        {!hasConflicts && (
          <div className="px-3 py-3 flex items-center gap-2 text-xs text-green-400">
            <Check size={13} />
            All conflicts resolved — ready to commit.
          </div>
        )}
      </div>

      {/* Commit area */}
      <div className="shrink-0 border-t border-border p-3 flex flex-col gap-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          disabled={disabled}
          className="w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          placeholder={isCherryPick ? "Cherry-pick commit message…" : "Merge commit message…"}
        />
        {error && <p className="text-xs text-destructive break-words">{error}</p>}
        <Button
          size="sm"
          className="w-full gap-1.5"
          onClick={handleFinish}
          disabled={!canFinish}
        >
          <GitMerge size={13} />
          {hasConflicts
            ? `Resolve ${conflicts.length} conflict${conflicts.length !== 1 ? "s" : ""} first`
            : isCherryPick ? "Commit Cherry-pick" : "Commit Merge"}
        </Button>
      </div>
    </div>
  );
}
