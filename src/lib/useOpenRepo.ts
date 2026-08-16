import { useCallback } from "react";
import { ipc } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import { addToRecentRepos, getRecentRepos } from "@/lib/recentRepos";

/** Matches the backend's `Error::NotARepo` message ("not a git repository: {path}"). */
export function isNotARepoError(e: unknown): boolean {
  return /not a git repository/i.test(String(e));
}

export function useOpenRepo() {
  const openTab = useStore((s) => s.openTab);

  return useCallback(
    async (path: string): Promise<string[]> => {
      try {
        const id = await ipc.openRepo(path);
        const updated = await addToRecentRepos(path);
        openTab(id, path);
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
