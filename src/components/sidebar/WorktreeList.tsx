import { useState, useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FolderGit2, ChevronRight, Lock, ExternalLink, Check } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ipc, type WorktreeInfo } from "@/lib/ipc";
import { useWorktrees, useWorktreeStatus } from "@/lib/queries";
import { useOpenWorktree } from "@/lib/useOpenRepo";
import { explorerName, truncateMiddle } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

function subscribeVisibility(callback: () => void) {
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}
function getVisibilitySnapshot() {
  return document.visibilityState === "visible";
}
function getVisibilityServerSnapshot() {
  return true;
}

/** Re-renders on `visibilitychange` so status polling can pause while the tab is hidden. */
function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, getVisibilitySnapshot, getVisibilityServerSnapshot);
}

interface RowProps {
  wt: WorktreeInfo;
  sectionOpen: boolean;
  documentVisible: boolean;
  onSelectOid?: (oid: string) => void;
  onRemove?: (wt: WorktreeInfo) => void;
  openWorktree: (path: string) => void;
  /** Same handler as the section header's "Prune missing" button. */
  onPrune: () => void;
}

function WorktreeRow({ wt, sectionOpen, documentVisible, onSelectOid, onRemove, openWorktree, onPrune }: RowProps) {
  const enabled = !wt.is_missing && sectionOpen && documentVisible;
  const { data: status } = useWorktreeStatus(wt.is_missing ? null : wt.path, { enabled });
  const hasData = status !== undefined;
  const changed = status?.changed ?? 0;
  const conflicted = !!status?.conflicted;

  const isCurrent = wt.is_current;
  const isMissing = wt.is_missing;
  const shortHash = wt.head_oid ? wt.head_oid.slice(0, 7) : "";

  // "Done?" — a quiet affordance for a worktree whose work already landed:
  // not main, not the current worktree, confirmed clean (changed === 0 from
  // loaded data, not just the `?? 0` default while status is still loading),
  // and its branch is reachable from this tab's HEAD.
  const isConfirmedClean = hasData && changed === 0 && !conflicted;
  const showMerged = !wt.is_main && !isCurrent && isConfirmedClean && wt.branch_merged;
  // "Stuck?" — while status hasn't resolved yet (still loading) or errored,
  // show the same muted "–" as the rest of the unknown state.
  const showUnknown = !isMissing && !hasData;

  const ariaLabel = isMissing
    ? `${wt.name}, missing`
    : `${wt.name}, ${wt.branch ?? "detached " + shortHash}` +
      (isCurrent ? ", current" : "") +
      (conflicted ? ", conflicted" : "") +
      (changed > 0 ? `, ${changed} uncommitted` : "") +
      (showMerged ? ", merged" : "");

  function handleClick() {
    if (wt.head_oid) onSelectOid?.(wt.head_oid);
  }

  function handleDoubleClick() {
    if (isCurrent || isMissing) return;
    openWorktree(wt.path);
  }

  function handleOpenClick(e: React.MouseEvent) {
    e.stopPropagation();
    openWorktree(wt.path);
  }

  const canOpenNewTab = !isCurrent;
  const canReveal = !isMissing;
  const canRemove = !wt.is_main && !isCurrent;

  const btn = (
    <button
      className={[
        "w-full text-left px-3 py-[3px] text-[12px] truncate rounded-sm flex items-center justify-between gap-2 transition-colors duration-75",
        isMissing
          ? "opacity-60 italic text-foreground/55"
          : isCurrent
          ? "text-teal-300/90 font-medium hover:bg-teal-500/8"
          : "text-foreground/55 hover:text-foreground/80 hover:bg-white/[0.05]",
      ].join(" ")}
      title={wt.path}
      aria-label={ariaLabel}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <div className="flex items-center gap-2 shrink-0">
        <span className={[
          "w-1.5 h-1.5 rounded-full shrink-0 transition-colors",
          isCurrent ? "bg-teal-400 shadow-[0_0_4px_rgba(45,212,191,0.5)]" : "bg-transparent",
        ].join(" ")} />
        {/* Tail-biased: an agent worktree's distinguishing suffix
            ("<repo>-agent-1" vs "-agent-2") lives near the end — an even
            middle-split can push it into the omitted middle on both names,
            making them render identically. This container is `shrink-0`
            (not `min-w-0`) — the name never gets squeezed by flex; the
            branch span below is the only thing allowed to shrink. */}
        <span className="truncate" title={wt.name}>{truncateMiddle(wt.name, 22, 0.7)}</span>
      </div>
      <div className="flex items-center gap-1.5 min-w-0">
        {conflicted && (
          <span className="shrink-0 font-mono text-[10px] text-orange-300/80">conflict</span>
        )}
        {changed > 0 ? (
          <span
            className="shrink-0 text-[10px] tabular-nums text-orange-300/80"
            title={`${changed} uncommitted change${changed === 1 ? "" : "s"}`}
          >
            {changed}
            <span className="sr-only"> uncommitted</span>
          </span>
        ) : showMerged ? (
          <span title="merged" className="shrink-0 inline-flex">
            <Check size={10} className="opacity-50 text-foreground/45" />
            <span className="sr-only">merged</span>
          </span>
        ) : showUnknown ? (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/40">–</span>
        ) : null}
        {wt.is_locked && (
          <span title={wt.lock_reason ?? "Locked"} className="shrink-0 inline-flex">
            <Lock size={8} className="opacity-40" />
          </span>
        )}
        {isMissing ? (
          <span className="shrink-0 font-mono text-[10px] text-foreground/45">missing</span>
        ) : wt.is_detached ? (
          <span className="shrink-0 font-mono text-[10px] text-amber-300/80">{shortHash}</span>
        ) : wt.branch ? (
          <span className="font-mono text-[10px] text-foreground/45 min-w-0 truncate" title={wt.branch}>
            {truncateMiddle(wt.branch, 16)}
          </span>
        ) : null}
        {/* Reserve space for the absolutely-positioned hover-open button (sibling,
            not nested — a <button> cannot contain another <button>) so its icon
            doesn't sit on top of the branch/hash text at rest. */}
        {!isCurrent && !isMissing && <span className="w-[10px] shrink-0" aria-hidden />}
      </div>
    </button>
  );

  return (
    <li className="group relative">
      <ContextMenu>
        <ContextMenuTrigger>{btn}</ContextMenuTrigger>
        <ContextMenuContent>
          {isMissing ? (
            <>
              <ContextMenuItem onClick={() => navigator.clipboard.writeText(wt.path)}>
                Copy path
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onPrune}>
                Prune missing
              </ContextMenuItem>
            </>
          ) : (
            <>
              {canOpenNewTab && (
                <ContextMenuItem onClick={() => openWorktree(wt.path)}>
                  Open in new tab
                </ContextMenuItem>
              )}
              {canReveal && (
                <ContextMenuItem onClick={() => revealItemInDir(wt.path)}>
                  Reveal in {explorerName()}
                </ContextMenuItem>
              )}
              <ContextMenuItem onClick={() => navigator.clipboard.writeText(wt.path)}>
                Copy path
              </ContextMenuItem>
              {canRemove && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onClick={() => onRemove?.(wt)}
                    className="text-destructive focus:text-destructive"
                  >
                    Remove worktree…
                  </ContextMenuItem>
                </>
              )}
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {!isCurrent && !isMissing && (
        <button
          type="button"
          aria-label={`Open worktree ${wt.name}`}
          className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-60 focus-visible:opacity-100 transition-opacity"
          onClick={handleOpenClick}
        >
          <ExternalLink size={10} />
        </button>
      )}
    </li>
  );
}

interface Props {
  repoId: string;
  filter?: string;
  onSelectOid?: (oid: string) => void;
  onRemove?: (wt: WorktreeInfo) => void;
}

export function WorktreeList({ repoId, filter, onSelectOid, onRemove }: Props) {
  const { data } = useWorktrees(repoId);
  const openWorktree = useOpenWorktree(repoId);
  const qc = useQueryClient();
  const documentVisible = useDocumentVisible();
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (filter) setOpen(true);
  }, [filter]);

  const worktrees = data ?? [];

  async function handlePrune() {
    try {
      await ipc.pruneWorktrees(repoId);
      qc.invalidateQueries({ queryKey: ["worktrees", repoId] });
    } catch (e) {
      toast.error(String(e));
    }
  }

  if (worktrees.length <= 1) return null;

  const visible = filter
    ? worktrees.filter((w) => {
        const f = filter.toLowerCase();
        return w.name.toLowerCase().includes(f) || (w.branch?.toLowerCase().includes(f) ?? false);
      })
    : worktrees;

  if (visible.length === 0) return null;

  const hasMissing = worktrees.some((w) => w.is_missing);

  return (
    <div>
      <div className="flex items-center group relative">
        <button
          type="button"
          className="flex-1 min-w-0 flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-semibold text-muted-foreground/55 uppercase tracking-[0.12em] hover:text-muted-foreground/80 transition-colors"
          onClick={() => setOpen((o) => !o)}
        >
          <FolderGit2 size={10} className="opacity-70 shrink-0" />
          <span>Worktrees</span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="text-[9px] opacity-40 tabular-nums">{visible.length}</span>
            <ChevronRight
              size={10}
              className={`opacity-35 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
            />
          </span>
        </button>
        {hasMissing && (
          <button
            type="button"
            className="shrink-0 pr-2.5 text-[10px] normal-case tracking-normal font-normal text-muted-foreground/50 hover:text-muted-foreground/80 transition-colors"
            onClick={handlePrune}
          >
            Prune missing
          </button>
        )}
      </div>

      {open && (
        <ul className="pb-0.5">
          {visible.map((wt) => (
            <WorktreeRow
              key={wt.path}
              wt={wt}
              sectionOpen={open}
              documentVisible={documentVisible}
              onSelectOid={onSelectOid}
              onRemove={onRemove}
              openWorktree={openWorktree}
              onPrune={handlePrune}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
