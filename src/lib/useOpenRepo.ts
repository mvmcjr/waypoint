import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ipc } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import { addToRecentRepos, getRecentRepos } from "@/lib/recentRepos";

/** Matches the backend's `Error::NotARepo` message ("not a git repository: {path}"). */
export function isNotARepoError(e: unknown): boolean {
  return /not a git repository/i.test(String(e));
}

/** Matches the backend's "repo gone" errors — the repo/worktree folder no longer exists on disk. */
export function isRepoGoneError(e: unknown): boolean {
  return /repo gone:|folder does not exist/i.test(String(e));
}

export function useOpenRepo() {
  const openTab = useStore((s) => s.openTab);

  return useCallback(
    async (path: string): Promise<string[]> => {
      try {
        const { id, main_worktree_path } = await ipc.openRepo(path);
        const updated = await addToRecentRepos(main_worktree_path ?? id);
        openTab(id, id, main_worktree_path);
        return updated;
      } catch (e) {
        // The folder simply isn't a repo yet — offer to create one there instead of
        // surfacing a raw error. The dialog re-enters this flow after `git init`.
        if (isNotARepoError(e)) {
          useStore.getState().setInitPromptPath(path);
          return getRecentRepos();
        }
        throw e;
      }
    },
    [openTab],
  );
}

/** Open a worktree in its own tab (activates it if open). Never shows the init prompt. */
export function useOpenWorktree(repoId: string | null) {
  const openTab = useStore((s) => s.openTab);
  const qc = useQueryClient();
  return useCallback(
    async (path: string) => {
      try {
        const { id, main_worktree_path } = await ipc.openRepo(path);
        openTab(id, id, main_worktree_path);
      } catch (e) {
        if (isRepoGoneError(e) || isNotARepoError(e)) {
          toast.error("Worktree folder no longer exists", {
            description: path,
            action: repoId
              ? {
                  label: "Prune missing",
                  onClick: () => {
                    ipc
                      .pruneWorktrees(repoId)
                      .then(() => qc.invalidateQueries({ queryKey: ["worktrees", repoId] }))
                      .catch((err) => toast.error(String(err)));
                  },
                }
              : undefined,
          });
          return;
        }
        toast.error(`Failed to open worktree: ${String(e)}`);
      }
    },
    [openTab, repoId, qc],
  );
}
