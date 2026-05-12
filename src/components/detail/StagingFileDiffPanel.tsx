import { useWorkdirFileDiff } from "@/lib/queries";
import { FileDiffPanel } from "./FileDiffPanel";

interface Props {
  repoId: string;
  path: string;
  section: "staged" | "unstaged";
  onClose: () => void;
}

export function StagingFileDiffPanel({ repoId, path, section, onClose }: Props) {
  const { data: file, isLoading, error } = useWorkdirFileDiff(repoId, path, section === "staged");

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground border-r border-border">
        Loading diff…
      </div>
    );
  }

  if (error || !file) {
    return (
      <div className="flex-1 flex flex-col gap-2 items-center justify-center text-xs border-r border-border">
        <span className="text-muted-foreground">No diff available for this file.</span>
        <button onClick={onClose} className="text-xs underline text-muted-foreground hover:text-foreground">
          ← Back
        </button>
      </div>
    );
  }

  return (
    <FileDiffPanel
      file={file}
      commitSummary={section === "staged" ? "Staged changes" : "Unstaged changes"}
      onClose={onClose}
    />
  );
}
