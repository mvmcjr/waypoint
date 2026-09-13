import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOpenRepo, useOpenWorktree } from "./useOpenRepo";
import { useStore } from "./store";
import { ipc } from "@/lib/ipc";
import { addToRecentRepos } from "@/lib/recentRepos";
import { toast } from "sonner";

vi.mock("@/lib/ipc", () => ({
  ipc: { openRepo: vi.fn(), pruneWorktrees: vi.fn() },
}));

vi.mock("@/lib/recentRepos", () => ({
  addToRecentRepos: vi.fn(),
  getRecentRepos: vi.fn().mockResolvedValue([]),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), promise: vi.fn() },
}));

const mockInvalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

const REPO1 = "/repos/foo";
const WORKTREE_PATH = "/repos/foo-worktree";

function seed() {
  useStore.setState({
    tabs: [{ id: REPO1, path: REPO1, label: "foo", mainPath: null }],
    activeTabId: REPO1,
    commits: [{ commit: { oid: "abc" } } as any],
    selectedOid: "abc",
    initPromptPath: null,
  });
}

// This is exactly the flow the "Open worktree" branch action reuses (see
// RefTree/RefBadge's "open-worktree" RefAction, wired in routes/repo.tsx).
describe("useOpenRepo — used by the 'Open worktree' branch action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
    vi.mocked(addToRecentRepos).mockResolvedValue([WORKTREE_PATH, REPO1]);
  });

  it("opens a new tab for a path that isn't already open", async () => {
    vi.mocked(ipc.openRepo).mockResolvedValue({ id: "worktree-repo-id", main_worktree_path: null });
    const { result } = renderHook(() => useOpenRepo());

    await act(async () => {
      await result.current(WORKTREE_PATH);
    });

    expect(ipc.openRepo).toHaveBeenCalledWith(WORKTREE_PATH);
    const s = useStore.getState();
    expect(s.tabs).toEqual([
      { id: REPO1, path: REPO1, label: "foo", mainPath: null },
      { id: "worktree-repo-id", path: "worktree-repo-id", label: "worktree-repo-id", mainPath: null },
    ]);
    expect(s.activeTabId).toBe("worktree-repo-id");
  });

  it("activates the existing tab (no duplicate) when the worktree path is already open", async () => {
    useStore.setState({
      tabs: [
        { id: REPO1, path: REPO1, label: "foo", mainPath: null },
        { id: "already-open-id", path: WORKTREE_PATH, label: "foo-worktree", mainPath: null },
      ],
      activeTabId: REPO1,
    });
    vi.mocked(ipc.openRepo).mockResolvedValue({ id: "already-open-id", main_worktree_path: null });
    const { result } = renderHook(() => useOpenRepo());

    await act(async () => {
      await result.current(WORKTREE_PATH);
    });

    const s = useStore.getState();
    expect(s.tabs).toHaveLength(2); // no duplicate created
    expect(s.activeTabId).toBe("already-open-id");
  });

  it("leaves the tabs untouched when ipc.openRepo fails", async () => {
    vi.mocked(ipc.openRepo).mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useOpenRepo());

    await expect(result.current(WORKTREE_PATH)).rejects.toThrow("boom");

    const s = useStore.getState();
    expect(s.tabs).toEqual([{ id: REPO1, path: REPO1, label: "foo", mainPath: null }]);
    expect(s.activeTabId).toBe(REPO1);
  });

  it("uses the canonical id from the backend as tab id and path", async () => {
    vi.mocked(ipc.openRepo).mockResolvedValue({ id: "E:\\repo", main_worktree_path: null });
    const { result } = renderHook(() => useOpenRepo());
    await act(() => result.current("E:/repo/"));
    const tabs = useStore.getState().tabs;
    const tab = tabs[tabs.length - 1];
    expect(tab).toMatchObject({ id: "E:\\repo", path: "E:\\repo", mainPath: null });
    expect(addToRecentRepos).toHaveBeenCalledWith("E:\\repo");
  });

  it("records the MAIN repo in recents when opening a linked worktree", async () => {
    vi.mocked(ipc.openRepo).mockResolvedValue({ id: "E:\\repo-wt", main_worktree_path: "E:\\repo" });
    const { result } = renderHook(() => useOpenRepo());
    await act(() => result.current("E:\\repo-wt"));
    expect(addToRecentRepos).toHaveBeenCalledWith("E:\\repo");
    const tabsAfter = useStore.getState().tabs;
    expect(tabsAfter[tabsAfter.length - 1].mainPath).toBe("E:\\repo");
  });
});

describe("useOpenWorktree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
    vi.mocked(addToRecentRepos).mockResolvedValue([WORKTREE_PATH, REPO1]);
  });

  it("shows a prune toast when the folder is gone, never the init prompt", async () => {
    vi.mocked(ipc.openRepo).mockRejectedValue("invalid argument: folder does not exist: E:\\gone");
    const { result } = renderHook(() => useOpenWorktree("E:\\repo"));
    await act(() => result.current("E:\\gone"));
    expect(useStore.getState().initPromptPath).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(
      "Worktree folder no longer exists",
      expect.objectContaining({ action: expect.objectContaining({ label: "Prune missing" }) }),
    );
  });

  it("the toast's Prune missing action invalidates [\"worktrees\", repoId] on success", async () => {
    vi.mocked(ipc.openRepo).mockRejectedValue("invalid argument: folder does not exist: E:\\gone");
    vi.mocked(ipc.pruneWorktrees).mockResolvedValue(undefined);
    const { result } = renderHook(() => useOpenWorktree("E:\\repo"));
    await act(() => result.current("E:\\gone"));

    const call = vi.mocked(toast.error).mock.calls.find(([msg]) => msg === "Worktree folder no longer exists")!;
    const action = (call[1] as any).action;
    await act(async () => { action.onClick(); await Promise.resolve(); });

    expect(ipc.pruneWorktrees).toHaveBeenCalledWith("E:\\repo");
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["worktrees", "E:\\repo"] });
  });

  it("the toast's Prune missing action shows an error toast (and does not invalidate) when pruning fails", async () => {
    vi.mocked(ipc.openRepo).mockRejectedValue("invalid argument: folder does not exist: E:\\gone");
    vi.mocked(ipc.pruneWorktrees).mockRejectedValue(new Error("prune boom"));
    const { result } = renderHook(() => useOpenWorktree("E:\\repo"));
    await act(() => result.current("E:\\gone"));

    const call = vi.mocked(toast.error).mock.calls.find(([msg]) => msg === "Worktree folder no longer exists")!;
    const action = (call[1] as any).action;
    await act(async () => { action.onClick(); await Promise.resolve(); await Promise.resolve(); });

    expect(mockInvalidateQueries).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Error: prune boom");
  });
});
