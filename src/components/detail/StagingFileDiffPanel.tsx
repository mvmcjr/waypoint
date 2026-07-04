import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkdirFileDiff } from "@/lib/queries";
import { ipc } from "@/lib/ipc";
import { FileDiffPanel } from "./FileDiffPanel";

interface Props {
  repoId: string;
  path: string;
  section: "staged" | "unstaged";
  onClose: () => void;
}

export function StagingFileDiffPanel({ repoId, path, section, onClose }: Props) {
  const { data: file, isLoading, error } = useWorkdirFileDiff(repoId, path, section === "staged");
  const qc = useQueryClient();
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const [pendingLine, setPendingLine] = useState<{ hunkIndex: number; lineIndex: number } | null>(null);

  // Awaited by callers before clearing their pending state — invalidateQueries
  // resolves once the matching active queries actually finish refetching, not
  // just when marked stale. Without awaiting this, buttons re-enable right
  // after the mutation IPC call resolves, before fresh hunk/line boundaries
  // arrive; a second click in that window would carry an index computed
  // against the stale, now-superseded layout.
  async function invalidateAfterChange() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["workdir-diff", repoId] }),
      qc.invalidateQueries({ queryKey: ["staging", repoId] }),
      qc.invalidateQueries({ queryKey: ["status", repoId] }),
    ]);
  }

  async function handleHunkAction(hunkIndex: number, fullFile: boolean) {
    setPendingIndex(hunkIndex);
    try {
      if (section === "staged") {
        await ipc.unstageHunk(repoId, path, hunkIndex, fullFile);
      } else {
        await ipc.stageHunk(repoId, path, hunkIndex, fullFile);
      }
      await invalidateAfterChange();
    } finally {
      setPendingIndex(null);
    }
  }

  async function handleLineAction(hunkIndex: number, lineIndex: number, fullFile: boolean) {
    setPendingLine({ hunkIndex, lineIndex });
    try {
      if (section === "staged") {
        await ipc.unstageLine(repoId, path, hunkIndex, lineIndex, fullFile);
      } else {
        await ipc.stageLine(repoId, path, hunkIndex, lineIndex, fullFile);
      }
      await invalidateAfterChange();
    } finally {
      setPendingLine(null);
    }
  }

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
      hunkAction={{
        label: section === "staged" ? "Unstage hunk" : "Stage hunk",
        pendingIndex,
        onClick: handleHunkAction,
      }}
      lineAction={{
        label: section === "staged" ? "Unstage line" : "Stage line",
        pending: pendingLine,
        onClick: handleLineAction,
      }}
      fetchFullFile={() => ipc.getWorkdirFileFull(repoId, path, section === "staged")}
    />
  );
}
