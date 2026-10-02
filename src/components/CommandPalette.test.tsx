import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
import { ipc } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import { useOpenRepo, useOpenWorktree } from "@/lib/useOpenRepo";
import { getRecentRepos, addManyToRecentRepos } from "@/lib/recentRepos";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useRemotes, useHeadInfo, useRefs } from "@/lib/queries";
import { commandsForSurface } from "@/lib/plugins/registry";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    scanForGitRepos: vi.fn(),
    listWorktrees: vi.fn(),
  },
}));

vi.mock("@/lib/queries", () => ({
  useRemotes: vi.fn(() => ({ data: undefined })),
  useHeadInfo: vi.fn(() => ({ data: undefined })),
  useRefs: vi.fn(() => ({ data: undefined })),
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
  openUrl: vi.fn(),
}));

vi.mock("@/lib/plugins/registry", () => ({
  usePluginRegistry: (selector?: (s: { plugins: unknown[] }) => unknown) =>
    selector ? selector({ plugins: [] }) : { plugins: [] },
  commandsForSurface: vi.fn(() => []),
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

describe("CommandPalette — open in browser", () => {
  const REPO = "E:\\repo";
  const remoteRef = (shorthand: string) => ({
    name: `refs/remotes/${shorthand}`, shorthand, kind: "remote_branch", target_oid: "a",
    is_head: false, is_pushed: false, worktree_path: null,
  });

  function setRepoData({
    remotes = [{ name: "origin", url: "git@github.com:me/repo.git" }],
    branch = "feat/x" as string | null,
    refs = [remoteRef("origin/feat/x")],
  } = {}) {
    vi.mocked(useRemotes).mockReturnValue({ data: remotes } as any);
    vi.mocked(useHeadInfo).mockReturnValue({ data: { oid: "a", branch } } as any);
    vi.mocked(useRefs).mockReturnValue({ data: refs } as any);
  }

  function commandLabels() {
    return screen.getAllByRole("button").map((b) => b.textContent);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRecentRepos).mockResolvedValue([]);
    vi.mocked(useOpenRepo).mockReturnValue(vi.fn());
    vi.mocked(useOpenWorktree).mockReturnValue(vi.fn());
    vi.mocked(openUrl).mockResolvedValue(undefined);
    vi.mocked(useRemotes).mockReturnValue({ data: undefined } as any);
    vi.mocked(useHeadInfo).mockReturnValue({ data: undefined } as any);
    vi.mocked(useRefs).mockReturnValue({ data: undefined } as any);
    vi.mocked(commandsForSurface).mockReturnValue([]);
    useStore.setState({ tabs: [{ id: REPO, path: REPO, label: "repo", mainPath: null }], activeTabId: REPO } as any);
  });

  it("lists browser commands after plugin commands, so their async arrival can't shift the selection", () => {
    vi.mocked(commandsForSurface).mockReturnValue([
      { pluginId: "p", command: { id: "c", title: "Plugin Thing" } },
    ] as any);
    setRepoData();
    render(<CommandPalette open onClose={vi.fn()} />);
    const labels = commandLabels();
    expect(labels.indexOf("Open Current Branch in Browser")).toBeGreaterThan(labels.indexOf("Plugin Thing"));
    expect(labels.indexOf("Open Remote in Browser: origin")).toBeGreaterThan(labels.indexOf("Plugin Thing"));
  });

  it("prefers a remote with a web page over a local origin for the current branch", async () => {
    setRepoData({
      remotes: [
        { name: "origin", url: "/srv/mirror/repo.git" },
        { name: "github", url: "git@github.com:me/repo.git" },
      ],
      refs: [remoteRef("origin/feat/x"), remoteRef("github/feat/x")],
    });
    render(<CommandPalette open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Current Branch in Browser" }));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/me/repo/tree/feat/x");
  });

  it("says when the current branch is only on a remote without a web page", () => {
    setRepoData({
      remotes: [
        { name: "origin", url: "/srv/mirror/repo.git" },
        { name: "github", url: "git@github.com:me/repo.git" },
      ],
      refs: [remoteRef("origin/feat/x")],
    });
    render(<CommandPalette open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Current Branch in Browser" }));
    expect(screen.getByText("No web page known for origin/feat/x's remote")).toBeInTheDocument();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("typing after a message brings the command list back", () => {
    setRepoData({ refs: [] });
    render(<CommandPalette open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Current Branch in Browser" }));
    expect(screen.getByText("feat/x isn't on any remote yet")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Type a command…"), { target: { value: "remote" } });
    expect(screen.queryByText("feat/x isn't on any remote yet")).toBeNull();
    expect(screen.getByRole("button", { name: "Open Remote in Browser: origin" })).toBeInTheDocument();
  });

  it("appends one command per remote with a web page, after the built-ins, and opens it", async () => {
    setRepoData({
      remotes: [
        { name: "origin", url: "git@github.com:me/repo.git" },
        { name: "backup", url: "/srv/git/repo.git" },
      ],
    });
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} />);
    expect(useRemotes).toHaveBeenCalledWith(REPO);

    const labels = commandLabels();
    const settingsIdx = labels.indexOf("Preferences: Open Settings");
    expect(labels.indexOf("Open Remote in Browser: origin")).toBeGreaterThan(settingsIdx);
    expect(labels.some((l) => l?.includes("backup"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Open Remote in Browser: origin" }));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/me/repo");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("opens the current branch's page on its remote", async () => {
    setRepoData();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Current Branch in Browser" }));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/me/repo/tree/feat/x");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("explains instead of opening when the current branch isn't pushed", () => {
    setRepoData({ refs: [remoteRef("origin/main")] });
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Current Branch in Browser" }));
    expect(screen.getByText("feat/x isn't on any remote yet")).toBeInTheDocument();
    expect(openUrl).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("hides the current-branch command on a detached HEAD", () => {
    setRepoData({ branch: null });
    render(<CommandPalette open onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Open Current Branch in Browser" })).toBeNull();
  });

  it("shows no browser commands while remotes load or without an active repo", () => {
    vi.mocked(useHeadInfo).mockReturnValue({ data: { oid: "a", branch: "main" } } as any);
    const { unmount } = render(<CommandPalette open onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /in Browser/ })).toBeNull();
    unmount();

    setRepoData();
    useStore.setState({ tabs: [], activeTabId: null } as any);
    render(<CommandPalette open onClose={vi.fn()} />);
    expect(useRemotes).toHaveBeenLastCalledWith(null);
  });
});
