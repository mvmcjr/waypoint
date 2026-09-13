import { useState, useEffect } from "react";
import { Search } from "lucide-react";
import type { RefInfo, WorktreeInfo } from "@/lib/ipc";
import { useRefs } from "@/lib/queries";
import { RefTree, type RefAction } from "./RefTree";
import { StashList } from "./StashList";
import { WorktreeList } from "./WorktreeList";

interface Props {
  repoId: string | null;
  onSelectRef?: (ref: RefInfo) => void;
  onRefAction?: (action: RefAction) => void;
  onSelectOid?: (oid: string) => void;
  onRemoveWorktree?: (wt: WorktreeInfo) => void;
}

export function Sidebar({ repoId, onSelectRef, onRefAction, onSelectOid, onRemoveWorktree }: Props) {
  const { data: refs, isLoading } = useRefs(repoId);
  const [filter, setFilter] = useState("");

  // Clear the search filter when switching repos so branch/tag names from the
  // previous repo don't remain applied to a completely different ref list.
  useEffect(() => {
    setFilter("");
  }, [repoId]);

  return (
    <aside className="w-56 shrink-0 border-r border-border flex flex-col bg-sidebar text-sidebar-foreground overflow-hidden">
      <div className="px-3 py-2.5 border-b border-border">
        <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-[0.14em]">
          Repository
        </span>
      </div>

      {refs && (
        <div className="px-2 py-1.5 border-b border-border/50">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/[0.04] border border-white/[0.06]">
            <Search size={11} className="text-muted-foreground/40 shrink-0" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              className="flex-1 bg-transparent text-[11px] text-foreground/70 placeholder:text-muted-foreground/35 outline-none min-w-0"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>
      )}

      {isLoading && (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground/60">
          Loading…
        </div>
      )}

      {refs && (
        <RefTree
          refs={refs}
          filter={filter}
          onSelectRef={onSelectRef}
          onRefAction={onRefAction}
          afterBranches={
            repoId && (
              <WorktreeList
                repoId={repoId}
                filter={filter}
                onSelectOid={onSelectOid}
                onRemove={onRemoveWorktree}
              />
            )
          }
        />
      )}
      {repoId && <StashList repoId={repoId} />}

      {!repoId && (
        <div className="flex-1 flex items-center justify-center text-[11px] text-muted-foreground/50 px-4 text-center leading-relaxed">
          Open a repository to see branches
        </div>
      )}
    </aside>
  );
}
