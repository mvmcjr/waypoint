import { format } from "date-fns";
import { useCommitDiff } from "@/lib/queries";
import type { PositionedCommit } from "@/lib/ipc";
import { DiffViewer } from "./DiffViewer";
import { Separator } from "@/components/ui/separator";

interface Props {
  repoId: string;
  item: PositionedCommit;
}

export function CommitDetail({ repoId, item }: Props) {
  const { commit } = item;
  const { data: diff, isLoading } = useCommitDiff(repoId, commit.oid);

  const date = new Date(commit.timestamp * 1000);

  return (
    <aside className="w-80 shrink-0 border-l border-border flex flex-col bg-card overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        Commit
      </div>

      {/* Meta */}
      <div className="p-3 space-y-2 text-sm shrink-0">
        <p className="font-medium text-foreground leading-snug">{commit.summary}</p>
        <Separator />
        <div className="space-y-1 text-xs text-muted-foreground">
          <div className="flex gap-2">
            <span className="w-14 shrink-0 font-semibold text-foreground/60">Hash</span>
            <span className="font-mono truncate">{commit.oid.slice(0, 12)}</span>
          </div>
          <div className="flex gap-2">
            <span className="w-14 shrink-0 font-semibold text-foreground/60">Author</span>
            <span className="truncate">{commit.author_name}</span>
          </div>
          <div className="flex gap-2">
            <span className="w-14 shrink-0 font-semibold text-foreground/60">Email</span>
            <span className="truncate">{commit.author_email}</span>
          </div>
          <div className="flex gap-2">
            <span className="w-14 shrink-0 font-semibold text-foreground/60">Date</span>
            <span>{format(date, "PPpp")}</span>
          </div>
          {commit.parent_oids.length > 0 && (
            <div className="flex gap-2">
              <span className="w-14 shrink-0 font-semibold text-foreground/60">Parents</span>
              <span className="font-mono truncate">
                {commit.parent_oids.map((p) => p.slice(0, 8)).join(", ")}
              </span>
            </div>
          )}
        </div>
      </div>

      <Separator />

      {/* Diff */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Loading diff…
        </div>
      ) : (
        diff && <DiffViewer files={diff} />
      )}
    </aside>
  );
}
