import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ipc } from "@/lib/ipc";
import { useStashes } from "@/lib/queries";

interface Props {
  repoId: string;
  onApplied?: () => void;
}

export function StashList({ repoId, onApplied }: Props) {
  const qc = useQueryClient();
  const { data: stashes = [] } = useStashes(repoId);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);

  if (stashes.length === 0) return null;

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["stashes", repoId] });
    qc.invalidateQueries({ queryKey: ["status", repoId] });
    qc.invalidateQueries({ queryKey: ["staging", repoId] });
  }

  async function handlePop(index: number) {
    setBusy(true);
    try { await ipc.popStash(repoId, index); invalidate(); onApplied?.(); }
    catch (e) { console.error(e); }
    finally { setBusy(false); }
  }

  async function handleApply(index: number) {
    setBusy(true);
    try { await ipc.applyStash(repoId, index); invalidate(); onApplied?.(); }
    catch (e) { console.error(e); }
    finally { setBusy(false); }
  }

  async function handleDrop(index: number) {
    setBusy(true);
    try { await ipc.dropStash(repoId, index); invalidate(); }
    catch (e) { console.error(e); }
    finally { setBusy(false); }
  }

  return (
    <div className="mb-1">
      <button
        className="w-full flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground uppercase tracking-wider hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>Stashes</span>
        <span className="ml-auto text-[10px] opacity-60">{stashes.length}</span>
      </button>

      {open && (
        <ul>
          {stashes.map((s) => {
            // Strip the git-generated prefix "On <branch>: " if present
            const label = s.message.replace(/^(WIP on [^:]+: [a-f0-9]+ )/, "").replace(/^On [^:]+: /, "");
            return (
              <li key={s.index}>
                <ContextMenu>
                  <ContextMenuTrigger>
                    <button
                      disabled={busy}
                      className="w-full text-left px-4 py-0.5 text-sm truncate hover:bg-white/5 rounded text-foreground/70 disabled:opacity-40"
                      title={s.message}
                    >
                      <span className="text-[10px] font-mono text-muted-foreground mr-1.5">
                        {s.index}
                      </span>
                      {label}
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-44">
                    <ContextMenuItem onClick={() => handlePop(s.index)}>
                      Pop  <span className="ml-auto text-xs text-muted-foreground">apply + drop</span>
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => handleApply(s.index)}>
                      Apply  <span className="ml-auto text-xs text-muted-foreground">keep stash</span>
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
    </div>
  );
}
