import { useState, useEffect, useRef } from "react";
import { Archive, ChevronRight } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ipc } from "@/lib/ipc";
import { useStashes, useRefreshRepo } from "@/lib/queries";
import { stashLabel } from "@/lib/utils";
import { StashRenameDialog } from "@/components/StashRenameDialog";

interface Props {
  repoId: string;
  onApplied?: () => void;
}

export function StashList({ repoId, onApplied }: Props) {
  const refresh = useRefreshRepo(repoId);
  const { data: stashes = [] } = useStashes(repoId);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ index: number; name: string } | null>(null);
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

  if (stashes.length === 0) return null;

  async function handlePop(index: number) {
    setBusy(true);
    opRepoRef.current = repoId;
    try { await ipc.popStash(repoId, index); refresh(); onApplied?.(); }
    catch (e) { console.error(e); }
    finally { opRepoRef.current = null; setBusy(false); }
  }

  async function handleApply(index: number) {
    setBusy(true);
    opRepoRef.current = repoId;
    try { await ipc.applyStash(repoId, index); refresh(); onApplied?.(); }
    catch (e) { console.error(e); }
    finally { opRepoRef.current = null; setBusy(false); }
  }

  async function handleDrop(index: number) {
    setBusy(true);
    opRepoRef.current = repoId;
    try { await ipc.dropStash(repoId, index); refresh(); }
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
            return (
              <li key={s.index}>
                <ContextMenu>
                  <ContextMenuTrigger>
                    <button
                      disabled={busy}
                      className="w-full text-left px-3 py-[3px] text-[12px] truncate rounded-sm flex items-center gap-2 text-foreground/50 hover:text-foreground/75 hover:bg-white/[0.05] transition-colors disabled:opacity-30"
                      title={s.message}
                    >
                      <span className="font-mono text-[9px] text-muted-foreground/30 shrink-0 w-3.5 text-right tabular-nums">
                        {s.index}
                      </span>
                      <span className="truncate">{label}</span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-44">
                    <ContextMenuItem onClick={() => handlePop(s.index)}>
                      Pop
                      <span className="ml-auto text-xs text-muted-foreground">apply + drop</span>
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => handleApply(s.index)}>
                      Apply
                      <span className="ml-auto text-xs text-muted-foreground">keep stash</span>
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => setRenaming({ index: s.index, name: label })}>
                      Rename…
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      onClick={() => handleDrop(s.index)}
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
    </div>
  );
}
