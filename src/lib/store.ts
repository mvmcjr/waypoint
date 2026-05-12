import { create } from "zustand";
import type { PositionedCommit } from "./ipc";

export interface Tab {
  id: string;   // = repoId (repo path used as key)
  path: string;
  label: string; // last path segment shown in the tab
}

function labelFromPath(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

interface AppState {
  tabs: Tab[];
  activeTabId: string | null;
  commits: PositionedCommit[];
  selectedOid: string | null;
  searchFilter: string;

  openTab: (id: string, path: string) => void;
  closeTab: (id: string) => void;
  switchTab: (id: string) => void;
  setCommits: (commits: PositionedCommit[]) => void;
  selectCommit: (oid: string | null) => void;
  setSearchFilter: (filter: string) => void;
}

const BLANK_VIEW = { commits: [], selectedOid: null, searchFilter: "" };

export const useStore = create<AppState>((set) => ({
  tabs: [],
  activeTabId: null,
  ...BLANK_VIEW,

  openTab: (id, path) =>
    set((state) => {
      // If already open, just switch to it.
      if (state.tabs.some((t) => t.id === id)) {
        return { activeTabId: id, ...BLANK_VIEW };
      }
      return {
        tabs: [...state.tabs, { id, path, label: labelFromPath(path) }],
        activeTabId: id,
        ...BLANK_VIEW,
      };
    }),

  closeTab: (id) =>
    set((state) => {
      const newTabs = state.tabs.filter((t) => t.id !== id);
      let newActiveId = state.activeTabId;
      if (state.activeTabId === id) {
        const idx = state.tabs.findIndex((t) => t.id === id);
        newActiveId = newTabs[Math.max(0, idx - 1)]?.id ?? null;
      }
      return { tabs: newTabs, activeTabId: newActiveId, ...BLANK_VIEW };
    }),

  switchTab: (id) => set({ activeTabId: id, ...BLANK_VIEW }),

  setCommits: (commits) => set({ commits }),
  selectCommit: (selectedOid) => set({ selectedOid }),
  setSearchFilter: (searchFilter) => set({ searchFilter }),
}));
