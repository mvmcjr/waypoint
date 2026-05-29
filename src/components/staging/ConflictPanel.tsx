import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  GitMerge,
  Check,
  X,
  AlertTriangle,
  Columns2,
  AlignJustify,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { useMergeStatus } from "@/lib/queries";
import { ConflictHunkPicker, type ViewMode } from "./ConflictHunkPicker";

interface Props {
  repoId: string;
}

interface CommitPanelProps {
  repoId: string;
  onDone: () => void;
}

export function ConflictPanel({ repoId }: Props) {
  const qc = useQueryClient();
  const { data: merge } = useMergeStatus(repoId);

  const [working,    setWorking]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewMode,   setViewMode]   = useState<ViewMode>("stacked");

  // Auto-select first conflicted file on load / when conflict list changes
  useEffect(() => {
    if (!merge?.conflicted_paths?.length) return;
    setSelectedPath((prev) => {
      if (prev && merge.conflicted_paths.includes(prev)) return prev;
      return merge.conflicted_paths[0];
    });
  }, [merge?.conflicted_paths]);

  // Hooks must live above any early return ─────────────────────────────────

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["staging",      repoId] });
    qc.invalidateQueries({ queryKey: ["status",       repoId] });
    qc.invalidateQueries({ queryKey: ["merge-status", repoId] });
  }, [qc, repoId]);

  // Stable callback so ConflictHunkPicker's onResolvedRef always sees the
  // latest conflict list without re-registering the apply effect.
  //
  // Navigation is anchored on `resolvedPath` (the file that was just written),
  // not on `selectedPath` (a closure that can be stale when two files are
  // resolved in rapid succession before the React Query re-fetch lands).
  // Using the resolved file's index in the current list means we always advance
  // forward correctly even if conflicted_paths hasn't been refreshed yet.
  const handleFileResolved = useCallback((resolvedPath: string) => {
    invalidate();
    setSelectedPath(() => {
      const paths = merge?.conflicted_paths ?? [];
      const idx = paths.indexOf(resolvedPath);
      if (idx === -1 || paths.length <= 1) return null;
      // Prefer the path after the resolved one; fall back to the one before.
      return paths[idx + 1] ?? paths[idx - 1] ?? null;
    });
  }, [merge?.conflicted_paths, invalidate]);

  // ─────────────────────────────────────────────────────────────────────────

  if (!merge?.in_progress) return null;

  const isCherryPick  = merge.kind === "cherry_pick";
  const conflicts     = merge.conflicted_paths;
  const hasConflicts  = conflicts.length > 0;
  const disabled      = working;

  // ── Whole-file resolution ─────────────────────────────────────────────────

  async function handleResolveOurs(path: string, e: React.MouseEvent) {
    e.stopPropagation();
    setWorking(true);
    try { await ipc.resolveOurs(repoId, path); invalidate(); }
    catch (err) { setError(String(err)); }
    finally { setWorking(false); }
  }

  async function handleResolveTheirs(path: string, e: React.MouseEvent) {
    e.stopPropagation();
    setWorking(true);
    try { await ipc.resolveTheirs(repoId, path); invalidate(); }
    catch (err) { setError(String(err)); }
    finally { setWorking(false); }
  }

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col overflow-hidden border-r border-border bg-background min-w-0">

      {/* ── Header ── */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
        <GitMerge size={14} className="text-orange-400 shrink-0" />
        <span className="font-semibold text-orange-300 text-xs uppercase tracking-wide">
          {isCherryPick ? "Cherry-pick in Progress" : "Merge in Progress"}
        </span>

        {/* View mode toggle */}
        <div className="ml-auto flex items-center gap-0.5 rounded-md border border-border/50 p-0.5">
          <button
            title="Stacked view"
            onClick={() => setViewMode("stacked")}
            className={`rounded p-1 transition-colors ${viewMode === "stacked" ? "bg-white/10 text-foreground" : "text-muted-foreground/50 hover:text-foreground"}`}
          >
            <AlignJustify size={12} />
          </button>
          <button
            title="Side-by-side view"
            onClick={() => setViewMode("side-by-side")}
            className={`rounded p-1 transition-colors ${viewMode === "side-by-side" ? "bg-white/10 text-foreground" : "text-muted-foreground/50 hover:text-foreground"}`}
          >
            <Columns2 size={12} />
          </button>
        </div>

      </div>

      {error && (
        <div className="shrink-0 px-3 py-1.5 text-[10px] text-destructive border-b border-destructive/20 bg-destructive/5">
          {error}
        </div>
      )}

      {/* ── Body: file list + hunk editor ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Left: file list sidebar */}
        <div className="w-52 shrink-0 border-r border-border flex flex-col overflow-hidden">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/65 font-semibold border-b border-border/40">
            {hasConflicts
              ? `${conflicts.length} unresolved`
              : "All resolved"}
          </div>

          <div className="flex-1 overflow-y-auto min-h-0">
            {hasConflicts ? (
              conflicts.map((path) => {
                const parts = path.split("/");
                const name  = parts[parts.length - 1];
                const dir   = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
                const isSelected = path === selectedPath;

                return (
                  <div key={path}>
                    <button
                      className={`w-full text-left px-2 py-1.5 flex items-start gap-1.5 transition-colors group ${
                        isSelected
                          ? "bg-orange-500/10 border-l-2 border-orange-400/60"
                          : "border-l-2 border-transparent hover:bg-white/[0.04]"
                      }`}
                      onClick={() => setSelectedPath(path)}
                      disabled={disabled}
                    >
                      <AlertTriangle size={10} className="text-orange-400 shrink-0 mt-0.5" />
                      <span className="flex-1 min-w-0">
                        <span className="block truncate text-xs text-foreground/90 leading-tight">{name}</span>
                        {dir && (
                          <span className="block truncate text-[10px] text-muted-foreground/60 leading-tight">{dir}</span>
                        )}
                      </span>
                    </button>

                    {/* Quick whole-file resolution — shown when this row is selected */}
                    {isSelected && (
                      <div className="flex gap-1 px-2 pb-1.5">
                        <button
                          onClick={(e) => handleResolveOurs(path, e)}
                          disabled={disabled}
                          className="flex-1 text-[10px] py-0.5 rounded border border-blue-400/30 text-blue-300/80 hover:text-blue-200 hover:bg-blue-400/10 disabled:opacity-30 transition-colors"
                        >
                          Ours
                        </button>
                        <button
                          onClick={(e) => handleResolveTheirs(path, e)}
                          disabled={disabled}
                          className="flex-1 text-[10px] py-0.5 rounded border border-purple-400/30 text-purple-300/80 hover:text-purple-200 hover:bg-purple-400/10 disabled:opacity-30 transition-colors"
                        >
                          Theirs
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-green-400">
                <Check size={13} />
                All conflicts resolved
              </div>
            )}
          </div>
        </div>

        {/* Right: hunk editor */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {selectedPath && hasConflicts ? (
            <ConflictHunkPicker
              key={selectedPath}
              repoId={repoId}
              path={selectedPath}
              viewMode={viewMode}
              onResolved={handleFileResolved}
            />
          ) : !hasConflicts ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
              <div className="w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center">
                <Check size={20} className="text-green-400" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground/80">All conflicts resolved</p>
                <p className="text-xs text-muted-foreground/70 mt-0.5">
                  Review the commit message on the right and finish the {isCherryPick ? "cherry-pick" : "merge"}.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground/55 italic">
              Select a file to resolve its conflicts
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

// ── Right-panel merge commit widget ──────────────────────────────────────────

export function MergeCommitPanel({ repoId, onDone }: CommitPanelProps) {
  const qc = useQueryClient();
  const { data: merge } = useMergeStatus(repoId);

  const [message,    setMessage]    = useState("");
  const [committing, setCommitting] = useState(false);
  const [aborting,   setAborting]   = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  useEffect(() => {
    if (merge?.default_message && !message) {
      setMessage(merge.default_message);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merge?.default_message]);

  if (!merge?.in_progress) return null;

  const isCherryPick = merge.kind === "cherry_pick";
  const conflicts    = merge.conflicted_paths;
  const hasConflicts = conflicts.length > 0;
  const busy         = committing || aborting;
  const canFinish    = !hasConflicts && message.trim().length > 0 && !busy;

  async function handleFinish() {
    const msg = message.trim();
    if (!msg) return;
    setCommitting(true);
    setError(null);
    try {
      if (isCherryPick) await ipc.finishCherryPick(repoId, msg);
      else await ipc.finishMerge(repoId, msg);
      onDone();
    } catch (err) { setError(String(err)); }
    finally { setCommitting(false); }
  }

  async function handleAbort() {
    setAborting(true);
    setError(null);
    try {
      await ipc.abortMerge(repoId);
      qc.invalidateQueries({ queryKey: ["merge-status", repoId] });
      qc.invalidateQueries({ queryKey: ["status",       repoId] });
      onDone();
    } catch (err) { setError(String(err)); }
    finally { setAborting(false); }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden border-l border-border">
      {/* Header */}
      <div className="shrink-0 px-3 py-2 border-b border-border flex items-center gap-2">
        <GitMerge size={13} className="text-orange-400 shrink-0" />
        <span className="text-xs font-semibold text-orange-300 uppercase tracking-wide">
          {isCherryPick ? "Cherry-pick" : "Merge"}
        </span>
      </div>

      {/* Status badge */}
      <div className="shrink-0 px-3 py-2.5 border-b border-border/50">
        {hasConflicts ? (
          <div className="flex items-center gap-2 text-xs text-orange-400">
            <AlertTriangle size={12} className="shrink-0" />
            <span>{conflicts.length} conflict{conflicts.length !== 1 ? "s" : ""} remaining</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-green-400">
            <Check size={12} className="shrink-0" />
            <span className="font-medium">All conflicts resolved</span>
          </div>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Commit section */}
      <div className="shrink-0 px-3 py-3 flex flex-col gap-2 border-t border-border">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/65 font-medium">
          Commit message
        </span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          disabled={busy}
          className="resize-none rounded border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          placeholder={isCherryPick ? "Cherry-pick commit message…" : "Merge commit message…"}
        />
        {error && <p className="text-[10px] text-destructive break-words">{error}</p>}
        <Button
          size="sm"
          className="w-full gap-1.5"
          onClick={handleFinish}
          disabled={!canFinish}
        >
          <GitMerge size={13} />
          {committing ? "Committing…" : isCherryPick ? "Commit Cherry-pick" : "Commit Merge"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="w-full h-6 text-xs text-muted-foreground hover:text-destructive gap-1"
          onClick={handleAbort}
          disabled={busy}
        >
          <X size={11} />
          {aborting ? "Aborting…" : "Abort"}
        </Button>
      </div>
    </div>
  );
}
