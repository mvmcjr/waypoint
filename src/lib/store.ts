import { create } from "zustand";
import type { PositionedCommit } from "./ipc";

interface AppState {
  repoId: string | null;
  repoPath: string | null;
  commits: PositionedCommit[];
  selectedOid: string | null;
  setRepo: (id: string, path: string) => void;
  setCommits: (commits: PositionedCommit[]) => void;
  selectCommit: (oid: string | null) => void;
}

export const useStore = create<AppState>((set) => ({
  repoId: null,
  repoPath: null,
  commits: [],
  selectedOid: null,

  setRepo: (repoId, repoPath) => set({ repoId, repoPath, commits: [], selectedOid: null }),
  setCommits: (commits) => set({ commits }),
  selectCommit: (selectedOid) => set({ selectedOid }),
}));
