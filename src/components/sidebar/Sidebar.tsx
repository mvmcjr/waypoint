import { useRefs } from "@/lib/queries";
import { RefTree } from "./RefTree";
import { StashList } from "./StashList";

interface Props {
  repoId: string | null;
  onCheckoutBranch?: (branchName: string) => void;
}

export function Sidebar({ repoId, onCheckoutBranch }: Props) {
  const { data: refs, isLoading } = useRefs(repoId);

  return (
    <aside className="w-56 shrink-0 border-r border-border flex flex-col bg-sidebar text-sidebar-foreground overflow-hidden">
      <div className="px-3 py-2.5 border-b border-border">
        <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-[0.14em]">
          Repository
        </span>
      </div>

      {isLoading && (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground/60">
          Loading…
        </div>
      )}

      {refs && <RefTree refs={refs} onCheckoutBranch={onCheckoutBranch} />}
      {repoId && <StashList repoId={repoId} />}

      {!repoId && (
        <div className="flex-1 flex items-center justify-center text-[11px] text-muted-foreground/50 px-4 text-center leading-relaxed">
          Open a repository to see branches
        </div>
      )}
    </aside>
  );
}
