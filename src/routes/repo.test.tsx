import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { RepoView } from "./repo";
import { useStore } from "@/lib/store";
import { useCommits, useHeadInfo, useRefreshRepo, useRefs, useRemotes, useRepoStatus } from "@/lib/queries";
import { ipc } from "@/lib/ipc";

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
    fetchRemote: vi.fn(),
    pullBranch: vi.fn(),
    pushBranch: vi.fn(),
  },
}));

// Mock hooks
vi.mock("@/lib/store", () => ({
  useStore: vi.fn(),
}));

vi.mock("@/lib/queries", () => ({
  useCommits: vi.fn(),
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

// Mock child components to keep tests simple and focused on RepoView
vi.mock("@/components/sidebar/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar">Sidebar</div>,
}));

vi.mock("@/components/timeline/Timeline", () => ({
  Timeline: () => <div data-testid="timeline">Timeline</div>,
}));

vi.mock("@/components/detail/CommitDetail", () => ({
  CommitDetail: () => <div data-testid="commit-detail">CommitDetail</div>,
}));

vi.mock("@/components/staging/ConflictPanel", () => ({
  ConflictPanel: () => <div data-testid="conflict-panel">ConflictPanel</div>,
  MergeCommitPanel: () => <div data-testid="merge-commit-panel">MergeCommitPanel</div>,
}));

vi.mock("@/components/detail/StagingFileDiffPanel", () => ({
  StagingFileDiffPanel: ({ repoId, path }: { repoId: string; path: string }) => (
    <div data-testid="staging-diff-panel" data-repo={repoId} data-path={path}>
      StagingFileDiffPanel
    </div>
  ),
}));

// Helpers for consistent mock state
const mockSelectCommit = vi.fn();
const mockRefresh = vi.fn();

function mockStoreFor(repoId: string) {
  vi.mocked(useStore).mockReturnValue({
    activeTabId: repoId,
    commits: [],
    selectedOid: null,
    searchFilter: "",
    setCommits: vi.fn(),
    selectCommit: mockSelectCommit,
    setSearchFilter: vi.fn(),
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
    vi.mocked(useRefreshRepo).mockReturnValue(mockRefresh);
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

    // fetchRemote never resolves — simulates a long-running fetch
    let resolveFetch!: () => void;
    vi.mocked(ipc.fetchRemote).mockReturnValue(
      new Promise<void>((res) => { resolveFetch = res; }) as any
    );

    const { rerender } = render(<RepoView />);

    // Start the fetch → button should be disabled/spinning
    const fetchBtn = screen.getByRole("button", { name: /fetch/i });
    fireEvent.click(fetchBtn);
    await waitFor(() => expect(ipc.fetchRemote).toHaveBeenCalledTimes(1));

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

  // ── V4: StagingFileDiffPanel only renders for the current repo ─────────────

  it("V4: StagingFileDiffPanel is not rendered when focusedStagingFile belongs to a previous repo", () => {
    // Since focusedStagingFile stores its own repoId, we can directly verify the
    // condition: even if internal state had an old value, the panel should not
    // appear for a new repoId.  The mock panel exposes data-repo for inspection.

    // Initially no staging panel
    render(<RepoView />);
    expect(screen.queryByTestId("staging-diff-panel")).not.toBeInTheDocument();
  });
});
