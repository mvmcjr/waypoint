import { useEffect } from "react";
import { useStore } from "@/lib/store";
import { useCommits } from "@/lib/queries";
import { Timeline } from "@/components/timeline/Timeline";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { CommitDetail } from "@/components/detail/CommitDetail";

export function RepoView() {
  const { repoId, commits, selectedOid, setCommits, selectCommit } = useStore();
  const { data, isLoading, error } = useCommits(repoId);

  useEffect(() => {
    if (data) setCommits(data);
  }, [data, setCommits]);

  const selectedItem = commits.find((c) => c.commit.oid === selectedOid) ?? null;

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar repoId={repoId} />

      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Toolbar */}
        <header className="shrink-0 border-b border-border px-4 py-2 flex items-center gap-3">
          <span className="text-sm font-semibold text-foreground">Timeline</span>
          {isLoading && (
            <span className="text-xs text-muted-foreground">Loading commits…</span>
          )}
          {error && (
            <span className="text-xs text-destructive">Error: {String(error)}</span>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {commits.length > 0 && `${commits.length} commits`}
          </span>
        </header>

        <div className="flex flex-1 overflow-hidden">
          <Timeline
            commits={commits}
            selectedOid={selectedOid}
            onSelectOid={selectCommit}
          />

          {selectedItem && repoId && (
            <CommitDetail repoId={repoId} item={selectedItem} />
          )}
        </div>
      </div>
    </div>
  );
}
