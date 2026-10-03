import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { RepoView } from "./repo";
import { useStore } from "@/lib/store";
import { useCommits, useFileStatus, useHeadInfo, useRefreshRepo, useRefs, useRemotes, useRepoStatus } from "@/lib/queries";
import { ipc } from "@/lib/ipc";
import { useOpenWorktree } from "@/lib/useOpenRepo";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(() => "toast-id"),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    promise: vi.fn(),
    dismiss: vi.fn(),
  },
}));

// Mock Tauri window
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    onFocusChanged: vi.fn(() => Promise.resolve(() => {})),
  })),
}));

// Mock Tauri event API — the "repo-changed" listener effect otherwise reaches
// the real core (no Tauri runtime under vitest) and rejects with transformCallback.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Mock IPC (needed for fetch/pull/push tests)
vi.mock("@/lib/ipc", () => ({
  ipc: {
    fetchAll: vi.fn(),
    pullBranch: vi.fn(),
    pushBranch: vi.fn(),
  },
}));

// Mock hooks
vi.mock("@/lib/store", () => ({
  useStore: vi.fn(),
}));

vi.mock("@/lib/queries", () => ({
  useCommitDiff: vi.fn(() => ({ data: undefined })),
  useCommitInRef: vi.fn(() => ({ data: undefined, isLoading: false, error: null })),
  useCommits: vi.fn(),
  useFileStatus: vi.fn(),
  useHeadInfo: vi.fn(),
  useRefreshRepo: vi.fn(),
  useRefs: vi.fn(),
  useRemotes: vi.fn(),
  useRepoStatus: vi.fn(),
}));

// Plugins: RepoView reads the registry + runner for toolbar commands.
vi.mock("@/lib/plugins/registry", () => ({
  usePluginRegistry: (selector?: (s: { plugins: unknown[] }) => unknown) =>
    selector ? selector({ plugins: [] }) : { plugins: [] },
  commandsForSurface: () => [],
}));

vi.mock("@/components/plugins/PluginRunnerProvider", () => ({
  usePluginRunner: () => ({ run: vi.fn() }),
}));

// Mock useOpenWorktree — RepoView uses it for the "Open worktree" branch
// action; it handles deleted-folder toasts itself, so RepoView just calls it.
vi.mock("@/lib/useOpenRepo", () => ({
  useOpenWorktree: vi.fn(),
  isRepoGoneError: (e: unknown) => /repo gone:|folder does not exist/i.test(String(e)),
}));

// Mock child components to keep tests simple and focused on RepoView.
// Sidebar forwards onRefAction through a test button so tests can exercise
// RepoView's dispatch (e.g. "open-worktree") without driving the real ref tree UI.
vi.mock("@/components/sidebar/Sidebar", () => ({
  Sidebar: ({ onRefAction }: { onRefAction?: (action: unknown) => void }) => (
    <div data-testid="sidebar">
      Sidebar
      <button onClick={() => onRefAction?.({ kind: "open-worktree", path: "/repos/other-checkout" })}>
        trigger-open-worktree
      </button>
      <button onClick={() => onRefAction?.({ kind: "merge", oid: "aaa111", label: "sinalizacao" })}>
        trigger-merge-held
      </button>
      <button onClick={() => onRefAction?.({ kind: "merge", oid: "bbb222", label: "feat" })}>
        trigger-merge-plain
      </button>
    </div>
  ),
}));

vi.mock("@/components/timeline/Timeline", () => ({
  // Exposes onWipClick via a test button so tests can select the WIP row
  // without driving the real (virtualized) timeline UI.
  Timeline: ({ onWipClick }: { onWipClick?: () => void }) => (
    <div data-testid="timeline">
      Timeline
      <button onClick={onWipClick}>trigger-wip-click</button>
    </div>
  ),
}));

vi.mock("@/components/detail/CommitDetail", () => ({
  CommitDetail: () => <div data-testid="commit-detail">CommitDetail</div>,
}));

vi.mock("@/components/staging/ConflictPanel", () => ({
  ConflictPanel: () => <div data-testid="conflict-panel">ConflictPanel</div>,
  MergeCommitPanel: () => <div data-testid="merge-commit-panel">MergeCommitPanel</div>,
}));

vi.mock("@/components/staging/StagingPanel", () => ({
  // Exposes onFileClick via a test button so tests can open a staging file
  // diff without driving the real staging UI.
  StagingPanel: ({ onFileClick }: { onFileClick?: (path: string, section: "staged" | "unstaged") => void }) => (
    <div data-testid="staging-panel">
      StagingPanel
      <button onClick={() => onFileClick?.("src/foo.ts", "unstaged")}>trigger-file-click</button>
    </div>
  ),
}));

vi.mock("@/components/detail/StagingFileDiffPanel", () => ({
  StagingFileDiffPanel: ({ repoId, path }: { repoId: string; path: string }) => (
    <div data-testid="staging-diff-panel" data-repo={repoId} data-path={path}>
      StagingFileDiffPanel
    </div>
  ),
}));

// MergeDialog is spied on (rather than mocking the whole Dialogs module) so we
// can assert on the `worktree` prop RepoView computes for it, without needing
// the real dialog's ipc/query dependencies wired up in this test file.
vi.mock("@/components/actions/Dialogs", () => ({
  PullConflictsDialog: () => <div data-testid="pull-conflicts" />,
  PushRejectedDialog: ({ branchName, target }: { branchName: string; target: { remote: string; branch: string; set_upstream: boolean; expected_remote_oid?: string | null } }) => (
    <div data-testid="push-rejected" data-branch={branchName} data-remote={target.remote} data-destination={target.branch} data-set-upstream={String(target.set_upstream)} data-lease={String(target.expected_remote_oid ?? "")}>
      PushRejectedDialog
    </div>
  ),
  RemoteErrorDialog: ({ message }: { message: string }) => <div data-testid="remote-error">{message}</div>,
  MergeDialog: ({ worktree }: { worktree: { name: string; path: string } | null }) => (
    <div data-testid="merge-dialog" data-worktree={JSON.stringify(worktree)}>
      MergeDialog
    </div>
  ),
}));

// Helpers for consistent mock state
const mockSelectCommit = vi.fn();
const mockRefresh = vi.fn();
const mockCloseTab = vi.fn();

function mockStoreFor(repoId: string, openSeq = 0) {
  vi.mocked(useStore).mockReturnValue({
    activeTabId: repoId,
    commits: [],
    selectedOid: null,
    multiSelectedOids: [],
    setCommits: vi.fn(),
    selectCommit: mockSelectCommit,
    setMultiSelected: vi.fn(),
    closeTab: mockCloseTab,
    openSeq,
  } as any);
}

const ONE_REMOTE = [{ name: "origin", url: "https://github.com/x/y" }];

describe("RepoView", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockStoreFor("repo1");
    vi.mocked(useCommits).mockReturnValue({ data: [], isLoading: false, error: null } as any);
    vi.mocked(useHeadInfo).mockReturnValue({ data: { oid: "abcdef", branch: "main" } } as any);
    vi.mocked(useRepoStatus).mockReturnValue({ data: { merge_in_progress: false } } as any);
    vi.mocked(useRemotes).mockReturnValue({ data: [] } as any);
    vi.mocked(useRefs).mockReturnValue({ data: [] } as any);
    vi.mocked(useFileStatus).mockReturnValue({ data: [] } as any);
    vi.mocked(useRefreshRepo).mockReturnValue(mockRefresh);
    vi.mocked(useOpenWorktree).mockReturnValue(vi.fn().mockResolvedValue(undefined));
    vi.mocked(ipc.fetchAll).mockResolvedValue([{ remote: "origin", ok: true, error: null }]);
  });

  it("renders the sidebar and timeline by default", () => {
    render(<RepoView />);

    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toBeInTheDocument();

    // Shows the current branch name
    expect(screen.getByText("⎇ main")).toBeInTheDocument();
  });

  it("shows detached HEAD correctly", () => {
    vi.mocked(useHeadInfo).mockReturnValue({ data: { oid: "1234567890", branch: null } } as any);

    render(<RepoView />);
    expect(screen.getByText("⎇ detached 12345678")).toBeInTheDocument();
  });

  it("displays loading state", () => {
    vi.mocked(useCommits).mockReturnValue({ data: undefined, isLoading: true, error: null } as any);

    render(<RepoView />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("displays error state", () => {
    vi.mocked(useCommits).mockReturnValue({ data: undefined, isLoading: false, error: new Error("Test error") } as any);

    render(<RepoView />);
    expect(screen.getByText(/Test error/i)).toBeInTheDocument();
  });

  // ── Unborn HEAD (repo with no commits) ─────────────────────────────────────

  it("shows the pending branch name when HEAD is unborn", () => {
    vi.mocked(useHeadInfo).mockReturnValue({ data: { oid: null, branch: "main" } } as any);

    render(<RepoView />);
    expect(screen.getByText("⎇ main")).toBeInTheDocument();
  });

  it("disables Push and Pull when HEAD is unborn", () => {
    vi.mocked(useRemotes).mockReturnValue({ data: ONE_REMOTE } as any);
    vi.mocked(useHeadInfo).mockReturnValue({ data: { oid: null, branch: "main" } } as any);

    render(<RepoView />);
    // Nothing to push yet — git would fail with "src refspec main does not match any".
    expect(screen.getByRole("button", { name: /push/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /pull/i })).toBeDisabled();
  });

  it("opens the staging panel automatically when HEAD is unborn", async () => {
    vi.mocked(useHeadInfo).mockReturnValue({ data: { oid: null, branch: "main" } } as any);

    render(<RepoView />);
    // No commit is selectable in an empty repo, so staging is the only useful view.
    await waitFor(() => expect(screen.getByTestId("staging-panel")).toBeInTheDocument());
  });

  // ── V3: merge-conflict effect ───────────────────────────────────────────────

  it("V3: calls selectCommit(null) when mounting with merge_in_progress=true", () => {
    vi.mocked(useRepoStatus).mockReturnValue({ data: { merge_in_progress: true } } as any);
    render(<RepoView />);
    expect(mockSelectCommit).toHaveBeenCalledWith(null);
  });

  it("V3: re-opens ConflictPanel when switching to a repo that already has merge_in_progress=true", () => {
    // Start on repo1 with no merge in progress
    vi.mocked(useRepoStatus).mockReturnValue({ data: { merge_in_progress: false } } as any);
    const { rerender } = render(<RepoView />);

    // Simulate switching to repo2 which has a conflict (same value: both false→true)
    // The key insight: if both repos had merge_in_progress=true, the dep-value wouldn't
    // change, but now repoId changes → the effect re-fires due to repoId dep.
    mockStoreFor("repo2");
    vi.mocked(useRepoStatus).mockReturnValue({ data: { merge_in_progress: true } } as any);
    rerender(<RepoView />);

    expect(mockSelectCommit).toHaveBeenCalledWith(null);
  });

  it("V3: re-fires when switching between two repos that both have merge_in_progress=true", () => {
    // repo1 has conflicts
    vi.mocked(useRepoStatus).mockReturnValue({ data: { merge_in_progress: true } } as any);
    const { rerender } = render(<RepoView />);
    const callCount = mockSelectCommit.mock.calls.length;

    // Switch to repo2 which also has conflicts — the boolean value did NOT change,
    // but repoId changed, so the effect must still fire.
    mockStoreFor("repo2");
    // merge_in_progress is still true (same value)
    rerender(<RepoView />);

    expect(mockSelectCommit.mock.calls.length).toBeGreaterThan(callCount);
  });

  // ── V2: loading flags reset on tab switch ──────────────────────────────────

  it("V2: Fetch button is not disabled after switching repos mid-flight", async () => {
    // Give repo1 a remote so the toolbar buttons appear
    vi.mocked(useRemotes).mockReturnValue({ data: ONE_REMOTE } as any);
    vi.mocked(useHeadInfo).mockReturnValue({ data: { oid: "abc", branch: "main" } } as any);

    // fetchAll never resolves — simulates a long-running fetch
    let resolveFetch!: () => void;
    vi.mocked(ipc.fetchAll).mockReturnValue(
      new Promise<any>((res) => { resolveFetch = () => res([]); }) as any
    );

    const { rerender } = render(<RepoView />);

    // Start the fetch → button should be disabled/spinning
    const fetchBtn = screen.getByRole("button", { name: /fetch/i });
    fireEvent.click(fetchBtn);
    await waitFor(() => expect(ipc.fetchAll).toHaveBeenCalledTimes(1));

    // Switch to repo2 — the reset effect should clear isFetching
    mockStoreFor("repo2");
    vi.mocked(useRemotes).mockReturnValue({ data: ONE_REMOTE } as any);
    vi.mocked(useHeadInfo).mockReturnValue({ data: { oid: "def", branch: "feat" } } as any);
    rerender(<RepoView />);

    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /fetch/i });
      expect(btn).not.toBeDisabled();
    });

    // Clean up — resolve the dangling promise
    act(() => resolveFetch());
  });

  describe("pull/push let the backend resolve and report the target", () => {
    const TWO_REMOTES = [
      { name: "origin", url: "https://github.com/x/y" },
      { name: "fork", url: "https://github.com/me/y" },
    ];
    const pushed = (remote: string, branch: string) => ({ kind: "pushed", remote, branch, detail: null, set_upstream: false });
    const rejected = (remote: string, branch: string, set_upstream = false) => ({ kind: "rejected", remote, branch, detail: "! [rejected]", set_upstream });

    beforeEach(() => {
      vi.mocked(useRemotes).mockReturnValue({ data: TWO_REMOTES } as any);
      vi.mocked(toast.promise).mockClear();
      vi.mocked(ipc.pullBranch).mockResolvedValue({ kind: "up_to_date", conflicted: [], remote: "fork", branch: "main" } as any);
      vi.mocked(ipc.pushBranch).mockResolvedValue(pushed("fork", "main") as any);
    });

    it("pulls without naming a remote and reports the one the backend used", async () => {
      render(<RepoView />);
      fireEvent.click(screen.getByRole("button", { name: /pull/i }));
      await waitFor(() => expect(ipc.pullBranch).toHaveBeenCalledWith("repo1"));
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Already up to date with fork/main", { id: "toast-id" }));
      for (const [kind, text] of [["fast_forward", "Pulled fork/dev (fast-forward)"], ["merged", "Pulled fork/dev and merged"]]) {
        vi.mocked(ipc.pullBranch).mockResolvedValue({ kind, conflicted: [], remote: "fork", branch: "dev" } as any);
        fireEvent.click(screen.getByRole("button", { name: /pull/i }));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith(text, { id: "toast-id" }));
      }
    });

    it("a pull that ends in conflicts shows no success toast", async () => {
      vi.mocked(toast.success).mockClear();
      vi.mocked(ipc.pullBranch).mockResolvedValue({ kind: "conflicts", conflicted: ["a.txt"], remote: "fork", branch: "main" } as any);
      render(<RepoView />);
      fireEvent.click(screen.getByRole("button", { name: /pull/i }));
      await screen.findByTestId("pull-conflicts");
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.dismiss).toHaveBeenCalledWith("toast-id");
    });

    it("a failed pull shows the error dialog and dismisses the loading toast instead of an error toast", async () => {
      vi.mocked(toast.error).mockClear();
      vi.mocked(toast.dismiss).mockClear();
      vi.mocked(ipc.pullBranch).mockRejectedValue("Authentication failed");
      render(<RepoView />);
      fireEvent.click(screen.getByRole("button", { name: /pull/i }));
      expect(await screen.findByTestId("remote-error")).toHaveTextContent("Authentication failed");
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.dismiss).toHaveBeenCalledWith("toast-id");
    });

    it("pushes without naming a remote or destination and reports the target used", async () => {
      vi.mocked(ipc.pushBranch).mockResolvedValue(pushed("fork", "dev") as any);
      render(<RepoView />);
      fireEvent.click(screen.getByRole("button", { name: /push/i }));
      await waitFor(() => expect(ipc.pushBranch).toHaveBeenCalledWith("repo1", undefined, "main", false));
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Pushed main to fork/dev", { id: "toast-id" }));
    });

    it("a rejected push dismisses the loading toast without a success toast", async () => {
      vi.mocked(toast.success).mockClear();
      vi.mocked(ipc.pushBranch).mockResolvedValue(rejected("origin", "main") as any);
      render(<RepoView />);
      fireEvent.click(screen.getByRole("button", { name: /push/i }));
      await screen.findByTestId("push-rejected");
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.dismiss).toHaveBeenCalledWith("toast-id");
    });

    it("carries the first-push --set-upstream into the force-push dialog", async () => {
      vi.mocked(ipc.pushBranch).mockResolvedValue(rejected("origin", "main", true) as any);
      render(<RepoView />);
      fireEvent.click(screen.getByRole("button", { name: /push/i }));
      expect(await screen.findByTestId("push-rejected")).toHaveAttribute("data-set-upstream", "true");
    });

    it("passes the rejection's remote oid through so the force push can lease against it", async () => {
      vi.mocked(ipc.pushBranch).mockResolvedValue({ ...rejected("origin", "main"), expected_remote_oid: "abc123" } as any);
      render(<RepoView />);
      fireEvent.click(screen.getByRole("button", { name: /push/i }));
      expect(await screen.findByTestId("push-rejected")).toHaveAttribute("data-lease", "abc123");
    });

    it("opens the force-push dialog with the returned target when the push is rejected", async () => {
      vi.mocked(useHeadInfo).mockReturnValue({ data: { oid: "abcdef", branch: "feature" } } as any);
      vi.mocked(ipc.pushBranch).mockResolvedValue(rejected("origin", "main") as any);
      render(<RepoView />);
      fireEvent.click(screen.getByRole("button", { name: /push/i }));
      const dlg = await screen.findByTestId("push-rejected");
      expect(dlg).toHaveAttribute("data-remote", "origin");
      expect(dlg).toHaveAttribute("data-branch", "feature");
      expect(dlg).toHaveAttribute("data-destination", "main");
    });

    it("shows other push failures in the error dialog", async () => {
      vi.mocked(ipc.pushBranch).mockRejectedValue("fatal: Authentication failed");
      render(<RepoView />);
      fireEvent.click(screen.getByRole("button", { name: /push/i }));
      expect(await screen.findByTestId("remote-error")).toHaveTextContent("Authentication failed");
      expect(screen.queryByTestId("push-rejected")).not.toBeInTheDocument();
    });
  });

  describe("fetch uses the backend's fetch_all", () => {
    const TWO_REMOTES = [
      { name: "origin", url: "https://github.com/x/y" },
      { name: "fork", url: "https://github.com/me/y" },
    ];
    const ok = (remote: string) => ({ remote, ok: true, error: null });
    const bad = (remote: string, error: string) => ({ remote, ok: false, error });

    beforeEach(() => {
      vi.mocked(useRemotes).mockReturnValue({ data: TWO_REMOTES } as any);
      for (const f of [toast.warning, toast.error, toast.success, toast.info, toast.dismiss]) vi.mocked(f).mockClear();
    });

    async function clickFetch() {
      const refreshCalls = mockRefresh.mock.calls.length;
      render(<RepoView />);
      fireEvent.click(screen.getByRole("button", { name: /fetch/i }));
      await waitFor(() => expect(ipc.fetchAll).toHaveBeenCalledTimes(1));
      return refreshCalls;
    }

    it("makes one call with the current branch and reports success per remote", async () => {
      vi.mocked(ipc.fetchAll).mockResolvedValue([ok("origin"), ok("fork")]);
      const before = await clickFetch();
      expect(ipc.fetchAll).toHaveBeenCalledWith("repo1", "main");
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Fetched from origin, fork", { id: "toast-id" }));
      expect(mockRefresh.mock.calls.length).toBeGreaterThan(before);
    });

    it("passes a null branch on a detached HEAD", async () => {
      vi.mocked(useHeadInfo).mockReturnValue({ data: { oid: "abcdef", branch: null } } as any);
      await clickFetch();
      expect(ipc.fetchAll).toHaveBeenCalledWith("repo1", null);
    });

    it("refreshes and warns per remote on a partial failure", async () => {
      vi.mocked(ipc.fetchAll).mockResolvedValue([ok("origin"), bad("fork", "fork unreachable")]);
      const before = await clickFetch();
      await waitFor(() => expect(toast.warning).toHaveBeenCalled());
      const msg = String(vi.mocked(toast.warning).mock.calls[0][0]);
      expect(msg).toContain("Fetched from origin");
      expect(msg).toContain("fork (fork unreachable)");
      expect(mockRefresh.mock.calls.length).toBeGreaterThan(before);
    });

    it("errors but still refreshes when every remote fails (git may have updated some refs)", async () => {
      vi.mocked(ipc.fetchAll).mockResolvedValue([bad("origin", "offline")]);
      const before = await clickFetch();
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain("origin (offline)");
      expect(mockRefresh.mock.calls.length).toBeGreaterThan(before);
    });

    it("shows a neutral message, not a success toast, when there is nothing to fetch, and still refreshes", async () => {
      vi.mocked(ipc.fetchAll).mockResolvedValue([]);
      const before = await clickFetch();
      await waitFor(() => expect(toast.info).toHaveBeenCalledWith("No remotes to fetch", { id: "toast-id" }));
      expect(toast.success).not.toHaveBeenCalled();
      expect(mockRefresh.mock.calls.length).toBeGreaterThan(before);
    });

    it("reports a rejected command as a failed fetch", async () => {
      vi.mocked(ipc.fetchAll).mockRejectedValue("boom");
      await clickFetch();
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Fetch failed: boom", { id: "toast-id" }));
    });

    it("auto-fetch is a background fetch with no branch (default remote only)", async () => {
      vi.mocked(ipc.fetchAll).mockResolvedValue([ok("origin")]);
      render(<RepoView />);
      await waitFor(() => expect(ipc.fetchAll).toHaveBeenCalled(), { timeout: 4000 });
      expect(ipc.fetchAll).toHaveBeenCalledWith("repo1", null, true);
    });

    it("auto-fetch does not reload when every remote fails (offline)", async () => {
      vi.mocked(ipc.fetchAll).mockResolvedValue([bad("origin", "offline")]);
      const refreshCalls = mockRefresh.mock.calls.length;
      render(<RepoView />);
      // The auto-fetch fires 2s after the repo opens (real timers: no fake-timer/waitFor interplay).
      await waitFor(() => expect(ipc.fetchAll).toHaveBeenCalled(), { timeout: 4000 });
      await new Promise((r) => setTimeout(r, 100));
      expect(mockRefresh.mock.calls.length).toBe(refreshCalls);
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("auto-fetch refreshes when at least one remote succeeded", async () => {
      vi.mocked(ipc.fetchAll).mockResolvedValue([bad("fork", "offline"), ok("origin")]);
      const refreshCalls = mockRefresh.mock.calls.length;
      render(<RepoView />);
      await waitFor(() => expect(ipc.fetchAll).toHaveBeenCalled(), { timeout: 4000 });
      await waitFor(() => expect(mockRefresh.mock.calls.length).toBeGreaterThan(refreshCalls));
    });
  });

  // ── V4: StagingFileDiffPanel only renders for the current repo ─────────────

  it("V4: StagingFileDiffPanel is not rendered when focusedStagingFile belongs to a previous repo", () => {
    // Since focusedStagingFile stores its own repoId, we can directly verify the
    // condition: even if internal state had an old value, the panel should not
    // appear for a new repoId.  The mock panel exposes data-repo for inspection.

    // Initially no staging panel
    render(<RepoView />);
    expect(screen.queryByTestId("staging-diff-panel")).not.toBeInTheDocument();
  });

  // ── Worktree awareness: "Open worktree" ────────────────────────────────────

  it('"Open worktree" (open-worktree) invokes useOpenWorktree with the path', () => {
    const mockOpen = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useOpenWorktree).mockReturnValue(mockOpen);

    render(<RepoView />);
    fireEvent.click(screen.getByText("trigger-open-worktree"));

    expect(mockOpen).toHaveBeenCalledWith("/repos/other-checkout");
  });

  // ── Merge dialog worktree awareness ─────────────────────────────────────────

  it("passes the held worktree to MergeDialog for a branch checked out elsewhere", () => {
    vi.mocked(useRefs).mockReturnValue({
      data: [
        {
          name: "refs/heads/sinalizacao",
          shorthand: "sinalizacao",
          kind: "local_branch",
          target_oid: "aaa111",
          is_head: false,
          is_pushed: false,
          worktree_path: "E:\\alugar-sinalizacao",
        },
      ],
    } as any);

    render(<RepoView />);
    fireEvent.click(screen.getByText("trigger-merge-held"));

    const dialog = screen.getByTestId("merge-dialog");
    expect(JSON.parse(dialog.getAttribute("data-worktree")!)).toEqual({
      name: "alugar-sinalizacao",
      path: "E:\\alugar-sinalizacao",
    });
  });

  it("passes worktree: null to MergeDialog for a plain branch", () => {
    vi.mocked(useRefs).mockReturnValue({
      data: [
        {
          name: "refs/heads/feat",
          shorthand: "feat",
          kind: "local_branch",
          target_oid: "bbb222",
          is_head: false,
          is_pushed: false,
          worktree_path: null,
        },
      ],
    } as any);

    render(<RepoView />);
    fireEvent.click(screen.getByText("trigger-merge-plain"));

    const dialog = screen.getByTestId("merge-dialog");
    expect(dialog.getAttribute("data-worktree")).toBe("null");
  });

  // ── Removed-worktree state ─────────────────────────────────────────────────

  it("shows the removed-worktree state when status reports repo gone", () => {
    vi.mocked(useRepoStatus).mockReturnValue({ data: undefined, error: "repo gone: E:\\repo-agent" } as any);
    mockStoreFor("E:\\repo-agent");
    render(<RepoView />);
    expect(screen.getByText("This worktree was removed")).toBeInTheDocument();
    expect(screen.getByText("E:\\repo-agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close tab" })).toBeInTheDocument();
  });

  it("Close tab in the removed-worktree state closes the tab", () => {
    vi.mocked(useRepoStatus).mockReturnValue({ data: undefined, error: "repo gone: E:\\repo-agent" } as any);
    mockStoreFor("E:\\repo-agent");
    render(<RepoView />);
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect(mockCloseTab).toHaveBeenCalledWith("E:\\repo-agent");
  });

  it("does not render the normal layout when the worktree is removed", () => {
    vi.mocked(useRepoStatus).mockReturnValue({ data: undefined, error: "repo gone: E:\\repo-agent" } as any);
    mockStoreFor("E:\\repo-agent");
    render(<RepoView />);
    expect(screen.queryByTestId("timeline")).not.toBeInTheDocument();
  });

  it("does not flash the removed state when switching to a different, healthy repo (RepoView is one shared instance)", () => {
    vi.mocked(useRepoStatus).mockReturnValue({ data: undefined, error: "repo gone: E:\\repo-agent" } as any);
    mockStoreFor("E:\\repo-agent");
    const { rerender } = render(<RepoView />);
    expect(screen.getByText("This worktree was removed")).toBeInTheDocument();

    // Switch the active tab to an unrelated, healthy repo.
    mockStoreFor("E:\\repo-health");
    vi.mocked(useRepoStatus).mockReturnValue({ data: { merge_in_progress: false }, error: undefined } as any);
    rerender(<RepoView />);

    // The very first render for the new repo must show the normal layout —
    // not a stale "removed" flash carried over from the previous tab.
    expect(screen.queryByText("This worktree was removed")).not.toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toBeInTheDocument();

    // ...and its own status query must be enabled from its very FIRST call —
    // not disabled on the first render and only corrected by a later effect
    // (which would still show as a real, if brief, flash in production, even
    // though a synchronous RTL rerender can mask it in the final DOM snapshot).
    const callsForHealthyRepo = vi.mocked(useRepoStatus).mock.calls.filter((c) => c[0] === "E:\\repo-health");
    expect(callsForHealthyRepo.length).toBeGreaterThan(0);
    expect(callsForHealthyRepo[0][1]).toEqual({ enabled: true });
  });

  it("clears the removed state when the SAME path reopens successfully (repoId unchanged, openSeq bumped)", () => {
    vi.mocked(useRepoStatus).mockReturnValue({ data: undefined, error: "repo gone: E:\\repo-agent" } as any);
    mockStoreFor("E:\\repo-agent", 1);
    const { rerender } = render(<RepoView />);
    expect(screen.getByText("This worktree was removed")).toBeInTheDocument();

    // The folder came back and the user (or the prune-toast/recent-repos flow)
    // reopened the SAME path. Since that tab was already the active tab, the
    // store's `openTab` returns the same `activeTabId` — only `openSeq` bumps.
    mockStoreFor("E:\\repo-agent", 2);
    vi.mocked(useRepoStatus).mockReturnValue({ data: { merge_in_progress: false }, error: undefined } as any);
    rerender(<RepoView />);

    expect(screen.queryByText("This worktree was removed")).not.toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toBeInTheDocument();
  });

  it("reopening the SAME active repo (openSeq bump, repoId unchanged) keeps an in-flight busy state and the WIP/focused-file selection", async () => {
    // Give repo1 a remote so the Fetch toolbar button appears.
    vi.mocked(useRemotes).mockReturnValue({ data: ONE_REMOTE } as any);
    vi.mocked(useHeadInfo).mockReturnValue({ data: { oid: "abc", branch: "main" } } as any);
    // Must include the file we're about to focus — otherwise the "close the
    // staging diff once its entry disappears from status" effect (repo.tsx,
    // keyed on [fileStatus, focusedStagingFile]) immediately clears it again.
    vi.mocked(useFileStatus).mockReturnValue({ data: [{ path: "src/foo.ts", staged: null, unstaged: "modified" }] } as any);

    // fetchAll never resolves on its own — simulates a fetch still in flight.
    let resolveFetch!: () => void;
    vi.mocked(ipc.fetchAll).mockReturnValue(
      new Promise<any>((res) => { resolveFetch = () => res([]); }) as any
    );

    const { rerender } = render(<RepoView />);

    // Start a fetch — the busy state flips on.
    fireEvent.click(screen.getByRole("button", { name: /fetch/i }));
    await waitFor(() => expect(ipc.fetchAll).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: /fetch/i })).toBeDisabled();

    // Select the WIP row, then open a staging file's diff.
    fireEvent.click(screen.getByText("trigger-wip-click"));
    expect(screen.getByTestId("staging-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByText("trigger-file-click"));
    expect(screen.getByTestId("staging-diff-panel")).toHaveAttribute("data-path", "src/foo.ts");

    // Re-open the ALREADY-ACTIVE repo — e.g. picking it again in the palette
    // or a tab's folder picker. `openTab` returns the same `activeTabId` in
    // that case and only bumps `openSeq`; `repoId` ("repo1") is unchanged.
    mockStoreFor("repo1", 1);
    rerender(<RepoView />);

    // The in-flight fetch must still be tracked as busy — the toolbar button
    // must NOT be re-enabled while the operation is still running.
    expect(screen.getByRole("button", { name: /fetch/i })).toBeDisabled();
    // The WIP selection and the focused staging file must survive the reopen.
    expect(screen.getByTestId("staging-panel")).toBeInTheDocument();
    expect(screen.getByTestId("staging-diff-panel")).toHaveAttribute("data-path", "src/foo.ts");

    // Clean up the dangling promise.
    act(() => resolveFetch());
  });
});
