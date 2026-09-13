import { useState, useEffect, useRef } from "react";
import { Archive, ChevronRight } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ipc, type StashEntry } from "@/lib/ipc";
import { useStashes, useRefreshRepo, useHeadInfo } from "@/lib/queries";
import { stashLabel } from "@/lib/utils";
import { StashRenameDialog } from "@/components/StashRenameDialog";

interface Props {
  repoId: string;
  onApplied?: () => void;
}

/** Pending pop/apply action awaiting cross-branch confirmation. */
interface PendingAction {
  kind: "pop" | "apply";
  stash: StashEntry;
  /** The repo this confirmation was opened for — never the render's current repoId. */
  repoId: string;
}

export function StashList({ repoId, onApplied }: Props) {
  const refresh = useRefreshRepo(repoId);
  const { data: stashes = [] } = useStashes(repoId);
  const { data: head } = useHeadInfo(repoId);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ index: number; name: string } | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  // Tracks which repo's stash op is currently in-flight (null when idle).
  const opRepoRef = useRef<string | null>(null);

  // When the user switches repos, unblock the new repo's buttons immediately.
  // But if they switch back to the repo whose op is still in-flight, keep busy
  // so they can't double-pop/apply while the first call is still running.
  // Hook must be called before the early return below (Rules of Hooks).
  useEffect(() => {
    if (opRepoRef.current === repoId) {
      setBusy(true); // op still in-flight for this repo
    } else {
      setBusy(false);
    }
  }, [repoId]);

  // A confirm opened for one repo must never carry over to another tab: once
  // the active repo no longer matches the one the confirm was opened for,
  // drop it so it can't reappear stale if the user switches back.
  useEffect(() => {
    setPending((p) => (p && p.repoId !== repoId ? null : p));
  }, [repoId]);

  if (stashes.length === 0) return null;

  function isCrossBranch(s: StashEntry) {
    return !!(s.branch && head?.branch && s.branch !== head.branch);
  }

  async function handlePop(targetRepoId: string, oid: string) {
    setBusy(true);
    opRepoRef.current = targetRepoId;
    try { await ipc.popStash(targetRepoId, oid); refresh(); onApplied?.(); }
    catch (e) { console.error(e); }
    finally { opRepoRef.current = null; setBusy(false); }
  }

  async function handleApply(targetRepoId: string, oid: string) {
    setBusy(true);
    opRepoRef.current = targetRepoId;
    try { await ipc.applyStash(targetRepoId, oid); refresh(); onApplied?.(); }
    catch (e) { console.error(e); }
    finally { opRepoRef.current = null; setBusy(false); }
  }

  function requestPop(s: StashEntry) {
    if (isCrossBranch(s)) { setPending({ kind: "pop", stash: s, repoId }); return; }
    handlePop(repoId, s.oid);
  }

  function requestApply(s: StashEntry) {
    if (isCrossBranch(s)) { setPending({ kind: "apply", stash: s, repoId }); return; }
    handleApply(repoId, s.oid);
  }

  // Keep the dialog open (with its confirm button disabled via `busy`) for
  // the duration of the op, then close it — so a slow pop/apply can't be
  // double-fired, and the dialog never lingers after it resolves.
  async function confirmPending() {
    if (!pending) return;
    const { kind, stash, repoId: targetRepoId } = pending;
    if (kind === "pop") await handlePop(targetRepoId, stash.oid);
    else await handleApply(targetRepoId, stash.oid);
    setPending(null);
  }

  async function handleDrop(oid: string) {
    setBusy(true);
    opRepoRef.current = repoId;
    try { await ipc.dropStash(repoId, oid); refresh(); }
    catch (e) { console.error(e); }
    finally { opRepoRef.current = null; setBusy(false); }
  }

  return (
    <div className="border-t border-border/50">
      <button
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-semibold text-muted-foreground/55 uppercase tracking-[0.12em] hover:text-muted-foreground/80 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <Archive size={10} className="opacity-70 shrink-0" />
        <span>Stashes</span>
        <span className="ml-auto flex items-center gap-1">
          <span className="text-[9px] opacity-40 tabular-nums">{stashes.length}</span>
          <ChevronRight
            size={10}
            className={`opacity-35 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          />
        </span>
      </button>

      {open && (
        <ul className="pb-1">
          {stashes.map((s) => {
            const label = stashLabel(s.message);
            const crossBranch = isCrossBranch(s);
            return (
              <li key={s.index}>
                <ContextMenu>
                  <ContextMenuTrigger>
                    <button
                      disabled={busy}
                      className={`w-full text-left px-3 py-[3px] text-[12px] truncate rounded-sm flex items-center gap-2 text-foreground/50 hover:text-foreground/75 hover:bg-white/[0.05] transition-colors disabled:opacity-30 ${crossBranch ? "opacity-60" : ""}`}
                      title={s.message}
                    >
                      <span className="font-mono text-[9px] text-muted-foreground/30 shrink-0 w-3.5 text-right tabular-nums">
                        {s.index}
                      </span>
                      <span className="truncate">{label}</span>
                      {s.branch && (
                        <span className="font-mono text-[9px] text-muted-foreground/40 shrink-0">
                          {s.branch}
                        </span>
                      )}
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-44">
                    <ContextMenuItem onClick={() => requestPop(s)}>
                      Pop
                      <span className="ml-auto text-xs text-muted-foreground">apply + drop</span>
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => requestApply(s)}>
                      Apply
                      <span className="ml-auto text-xs text-muted-foreground">keep stash</span>
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => setRenaming({ index: s.index, name: label })}>
                      Rename…
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      onClick={() => handleDrop(s.oid)}
                      className="text-destructive focus:text-destructive"
                    >
                      Drop
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </li>
            );
          })}
        </ul>
      )}

      {renaming && (
        <StashRenameDialog
          repoId={repoId}
          index={renaming.index}
          currentName={renaming.name}
          onClose={() => setRenaming(null)}
        />
      )}

      {pending && pending.repoId === repoId && head?.branch && (
        <Dialog open onOpenChange={(o) => !o && setPending(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Apply stash from another branch?</DialogTitle>
              <DialogDescription>
                This stash was made on <code className="font-mono">{pending.stash.branch}</code>.
                Apply it to <code className="font-mono">{head.branch}</code>?
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPending(null)} disabled={busy}>Cancel</Button>
              <Button onClick={confirmPending} disabled={busy}>
                {pending.kind === "pop" ? "Pop" : "Apply"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
