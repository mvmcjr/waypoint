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
    <aside className="w-52 shrink-0 border-r border-border flex flex-col bg-sidebar text-sidebar-foreground overflow-hidden">
      <div className="px-3 py-2 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        Repository
      </div>

      {isLoading && (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Loading…
        </div>
      )}

      {refs && <RefTree refs={refs} onCheckoutBranch={onCheckoutBranch} />}
      {repoId && <StashList repoId={repoId} />}

      {!repoId && (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground px-3 text-center">
          Open a repository to see branches
        </div>
      )}
    </aside>
  );
}
