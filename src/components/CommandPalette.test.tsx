import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
import { ipc } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import { useOpenRepo, useOpenWorktree } from "@/lib/useOpenRepo";
import { getRecentRepos, addManyToRecentRepos } from "@/lib/recentRepos";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    scanForGitRepos: vi.fn(),
    listWorktrees: vi.fn(),
  },
}));

vi.mock("@/lib/useOpenRepo", () => ({
  useOpenRepo: vi.fn(),
  useOpenWorktree: vi.fn(),
}));

vi.mock("@/lib/recentRepos", () => ({
  getRecentRepos: vi.fn(),
  addManyToRecentRepos: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

vi.mock("@/lib/plugins/registry", () => ({
  usePluginRegistry: (selector?: (s: { plugins: unknown[] }) => unknown) =>
    selector ? selector({ plugins: [] }) : { plugins: [] },
  commandsForSurface: () => [],
}));

vi.mock("@/components/plugins/PluginRunnerProvider", () => ({
  usePluginRunner: () => ({ run: vi.fn() }),
}));

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRecentRepos).mockResolvedValue([]);
    vi.mocked(addManyToRecentRepos).mockResolvedValue([]);
    vi.mocked(useOpenRepo).mockReturnValue(vi.fn());
    useStore.setState({ tabs: [], activeTabId: null } as any);
  });

  it("Open Worktree… lists other worktrees and opens the chosen one", async () => {
    useStore.setState({ tabs: [{ id: "E:\\repo", path: "E:\\repo", label: "repo", mainPath: null }], activeTabId: "E:\\repo" } as any);
    vi.mocked(ipc.listWorktrees).mockResolvedValue([
      { path: "E:\\repo", name: "repo", is_main: true, is_current: true, branch: "master", head_oid: "a", is_detached: false, is_locked: false, lock_reason: null, is_missing: false, branch_merged: false },
      { path: "E:\\repo-agent", name: "repo-agent", is_main: false, is_current: false, branch: "sinalizacao", head_oid: "b", is_detached: false, is_locked: false, lock_reason: null, is_missing: false, branch_merged: false },
    ]);
    const open = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useOpenWorktree).mockReturnValue(open);
    render(<CommandPalette open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText("Open Worktree…"));
    expect(await screen.findByText("repo-agent")).toBeInTheDocument();
    expect(screen.queryByText("master")).toBeNull(); // current excluded
    fireEvent.click(screen.getByText("repo-agent"));
    await waitFor(() => expect(open).toHaveBeenCalledWith("E:\\repo-agent"));
  });

  it("Open Worktree… is disabled when there is no active tab", async () => {
    vi.mocked(useOpenWorktree).mockReturnValue(vi.fn());
    render(<CommandPalette open onClose={vi.fn()} />);
    const item = await screen.findByText("Open Worktree…");
    expect(item.closest("button")).toBeDisabled();
  });

  it("excludes missing worktrees and shows the empty state", async () => {
    useStore.setState({ tabs: [{ id: "E:\\repo", path: "E:\\repo", label: "repo", mainPath: null }], activeTabId: "E:\\repo" } as any);
    vi.mocked(ipc.listWorktrees).mockResolvedValue([
      { path: "E:\\repo", name: "repo", is_main: true, is_current: true, branch: "master", head_oid: "a", is_detached: false, is_locked: false, lock_reason: null, is_missing: false, branch_merged: false },
      { path: "E:\\repo-gone", name: "repo-gone", is_main: false, is_current: false, branch: "gone", head_oid: "c", is_detached: false, is_locked: false, lock_reason: null, is_missing: true, branch_merged: false },
    ]);
    vi.mocked(useOpenWorktree).mockReturnValue(vi.fn());
    render(<CommandPalette open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText("Open Worktree…"));
    expect(await screen.findByText("No other worktrees.")).toBeInTheDocument();
  });

  it("shows the short hash in mono for a detached worktree, and filters by name or branch", async () => {
    useStore.setState({ tabs: [{ id: "E:\\repo", path: "E:\\repo", label: "repo", mainPath: null }], activeTabId: "E:\\repo" } as any);
    vi.mocked(ipc.listWorktrees).mockResolvedValue([
      { path: "E:\\repo", name: "repo", is_main: true, is_current: true, branch: "master", head_oid: "a", is_detached: false, is_locked: false, lock_reason: null, is_missing: false, branch_merged: false },
      { path: "E:\\repo-agent", name: "repo-agent", is_main: false, is_current: false, branch: "sinalizacao", head_oid: "bbbbbbbbbbb", is_detached: false, is_locked: false, lock_reason: null, is_missing: false, branch_merged: false },
      { path: "E:\\repo-detached", name: "repo-detached", is_main: false, is_current: false, branch: null, head_oid: "1234567abcd", is_detached: true, is_locked: false, lock_reason: null, is_missing: false, branch_merged: false },
    ]);
    vi.mocked(useOpenWorktree).mockReturnValue(vi.fn());
    render(<CommandPalette open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText("Open Worktree…"));
    await screen.findByText("repo-agent");
    const hash = screen.getByText("1234567");
    expect(hash).toHaveClass("font-mono");
    expect(hash).toHaveClass("text-amber-300/80");

    const input = screen.getByPlaceholderText(/worktree/i);
    fireEvent.change(input, { target: { value: "sinal" } });
    expect(screen.getByText("repo-agent")).toBeInTheDocument();
    expect(screen.queryByText("repo-detached")).toBeNull();
  });

  it("gives the worktree name truncate priority over the branch (name isn't squeezed to nothing)", async () => {
    useStore.setState({ tabs: [{ id: "E:\\repo", path: "E:\\repo", label: "repo", mainPath: null }], activeTabId: "E:\\repo" } as any);
    vi.mocked(ipc.listWorktrees).mockResolvedValue([
      { path: "E:\\repo", name: "repo", is_main: true, is_current: true, branch: "master", head_oid: "a", is_detached: false, is_locked: false, lock_reason: null, is_missing: false, branch_merged: false },
      {
        path: "E:\\repo-agent",
        name: "waypoint-agent-1-longer-suffix",
        is_main: false,
        is_current: false,
        branch: "feature/some-very-long-branch-name-here",
        head_oid: "b",
        is_detached: false,
        is_locked: false,
        lock_reason: null,
        is_missing: false,
        branch_merged: false,
      },
    ]);
    vi.mocked(useOpenWorktree).mockReturnValue(vi.fn());
    render(<CommandPalette open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText("Open Worktree…"));

    const nameEl = await screen.findByText("waypoint-agent-1-longer-suffix");
    expect(nameEl).toHaveClass("min-w-0", "truncate");
    const branchEl = screen.getByText("feature/some-very-long-branch-name-here");
    expect(branchEl).toHaveClass("shrink", "truncate");
  });

  it("shows an error message when loading worktrees fails, not the empty state", async () => {
    useStore.setState({ tabs: [{ id: "E:\\repo", path: "E:\\repo", label: "repo", mainPath: null }], activeTabId: "E:\\repo" } as any);
    vi.mocked(ipc.listWorktrees).mockRejectedValue(new Error("boom"));
    vi.mocked(useOpenWorktree).mockReturnValue(vi.fn());
    render(<CommandPalette open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText("Open Worktree…"));
    expect(await screen.findByText("Failed to load worktrees: Error: boom")).toBeInTheDocument();
    expect(screen.queryByText("No other worktrees.")).toBeNull();
  });

  it("guards against a stale worktree load overwriting a newer one", async () => {
    const tabA = { id: "E:\\repoA", path: "E:\\repoA", label: "repoA", mainPath: null };
    const tabB = { id: "E:\\repoB", path: "E:\\repoB", label: "repoB", mainPath: null };
    useStore.setState({ tabs: [tabA, tabB], activeTabId: "E:\\repoA" } as any);

    let resolveA!: (v: unknown) => void;
    let resolveB!: (v: unknown) => void;
    const first = new Promise((res) => { resolveA = res; });
    const second = new Promise((res) => { resolveB = res; });
    vi.mocked(ipc.listWorktrees).mockImplementationOnce(() => first as any).mockImplementationOnce(() => second as any);
    vi.mocked(useOpenWorktree).mockReturnValue(vi.fn());

    const { rerender } = render(<CommandPalette open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText("Open Worktree…"));
    expect(await screen.findByText("Loading worktrees…")).toBeInTheDocument();

    // Close the palette, switch the active tab, and reopen it — the component
    // instance stays mounted (App.tsx renders it unconditionally), so its
    // in-flight load for tab A is still pending.
    rerender(<CommandPalette open={false} onClose={vi.fn()} />);
    useStore.setState({ activeTabId: "E:\\repoB" } as any);
    rerender(<CommandPalette open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText("Open Worktree…"));

    // Resolve the newer (B) load first, then the stale (A) load last.
    resolveB([
      { path: "E:\\repoB", name: "repoB", is_main: true, is_current: true, branch: "master", head_oid: "b0", is_detached: false, is_locked: false, lock_reason: null, is_missing: false, branch_merged: false },
      { path: "E:\\repoB-agent", name: "repoB-agent", is_main: false, is_current: false, branch: "feat-b", head_oid: "b1", is_detached: false, is_locked: false, lock_reason: null, is_missing: false, branch_merged: false },
    ]);
    await screen.findByText("repoB-agent");

    resolveA([
      { path: "E:\\repoA", name: "repoA", is_main: true, is_current: true, branch: "master", head_oid: "a0", is_detached: false, is_locked: false, lock_reason: null, is_missing: false, branch_merged: false },
      { path: "E:\\repoA-agent", name: "repoA-agent", is_main: false, is_current: false, branch: "feat-a", head_oid: "a1", is_detached: false, is_locked: false, lock_reason: null, is_missing: false, branch_merged: false },
    ]);

    await waitFor(() => {
      expect(screen.getByText("repoB-agent")).toBeInTheDocument();
      expect(screen.queryByText("repoA-agent")).toBeNull();
    });
  });
});
