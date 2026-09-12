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

export type FileListView = "path" | "tree";
export type DiffLayout = "unified" | "split";
export type DiffScope = "hunks" | "full";

/** How the user likes to look at files and diffs — kept across tabs, files, and restarts. */
export interface ViewPrefs {
  fileListView: FileListView;
  diffLayout: DiffLayout;
  diffScope: DiffScope;
  commitPanelCollapsed: boolean;
}

const VIEW_PREFS_KEY = "waypoint.viewPrefs";
const DEFAULT_VIEW_PREFS: ViewPrefs = {
  fileListView: "path",
  diffLayout: "unified",
  diffScope: "hunks",
  commitPanelCollapsed: false,
};

function loadViewPrefs(): ViewPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_PREFS_KEY) ?? "{}");
    return {
      fileListView: raw.fileListView === "tree" ? "tree" : "path",
      diffLayout: raw.diffLayout === "split" ? "split" : "unified",
      diffScope: raw.diffScope === "full" ? "full" : "hunks",
      commitPanelCollapsed: raw.commitPanelCollapsed === true,
    };
  } catch {
    return DEFAULT_VIEW_PREFS;
  }
}

function saveViewPrefs(prefs: ViewPrefs) {
  try { localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

interface AppState extends ViewPrefs {
  tabs: Tab[];
  activeTabId: string | null;
  commits: PositionedCommit[];
  selectedOid: string | null;
  /** Multi-selection for range operations (e.g. squash). Always contains selectedOid when non-empty. */
  multiSelectedOids: string[];
  settingsOpen: boolean;
  /** Folder the user picked that turned out not to be a repo — prompts to run `git init`. */
  initPromptPath: string | null;

  openTab: (id: string, path: string) => void;
  closeTab: (id: string) => void;
  switchTab: (id: string) => void;
  setCommits: (commits: PositionedCommit[]) => void;
  selectCommit: (oid: string | null) => void;
  setMultiSelected: (oids: string[]) => void;
  setSettingsOpen: (open: boolean) => void;
  setInitPromptPath: (path: string | null) => void;
  setViewPref: <K extends keyof ViewPrefs>(key: K, value: ViewPrefs[K]) => void;
}

const BLANK_VIEW = { commits: [], selectedOid: null, multiSelectedOids: [] };

export const useStore = create<AppState>((set) => ({
  tabs: [],
  activeTabId: null,
  settingsOpen: false,
  initPromptPath: null,
  ...BLANK_VIEW,
  ...loadViewPrefs(),

  openTab: (id, path) =>
    set((state) => {
      if (state.activeTabId === id) return state;
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
      if (state.activeTabId === id) {
        const idx = state.tabs.findIndex((t) => t.id === id);
        const newActiveId = newTabs[Math.max(0, idx - 1)]?.id ?? null;
        return { tabs: newTabs, activeTabId: newActiveId, ...BLANK_VIEW };
      }
      return { tabs: newTabs };
    }),

  switchTab: (id) => set((state) =>
    state.activeTabId === id ? state : { activeTabId: id, ...BLANK_VIEW }
  ),

  setCommits: (commits) => set({ commits }),
  selectCommit: (selectedOid) =>
    set({ selectedOid, multiSelectedOids: selectedOid ? [selectedOid] : [] }),
  setMultiSelected: (multiSelectedOids) => set({ multiSelectedOids }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setInitPromptPath: (initPromptPath) => set({ initPromptPath }),
  setViewPref: (key, value) =>
    set((state) => {
      const prefs: ViewPrefs = {
        fileListView: state.fileListView,
        diffLayout: state.diffLayout,
        diffScope: state.diffScope,
        commitPanelCollapsed: state.commitPanelCollapsed,
        [key]: value,
      };
      saveViewPrefs(prefs);
      return prefs;
    }),
}));
