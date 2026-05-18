import { useCallback } from "react";
import { ipc } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import { addToRecentRepos } from "@/lib/recentRepos";

export function useOpenRepo() {
  const openTab = useStore((s) => s.openTab);

  return useCallback(
    async (path: string): Promise<string[]> => {
      const id = await ipc.openRepo(path);
      const updated = await addToRecentRepos(path);
      openTab(id, path);
      return updated;
    },
    [openTab],
  );
}
