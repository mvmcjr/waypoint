import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { RepoView } from "./repo";
import { useStore } from "@/lib/store";
import { useCommits, useHeadInfo, useRefreshRepo, useRemotes, useRepoStatus } from "@/lib/queries";

// Mock Tauri window
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    onFocusChanged: vi.fn(() => Promise.resolve(() => {})),
  })),
}));

// Mock hooks
vi.mock("@/lib/store", () => ({
  useStore: vi.fn(),
}));

vi.mock("@/lib/queries", () => ({
  useCommits: vi.fn(),
  useHeadInfo: vi.fn(),
  useRefreshRepo: vi.fn(),
  useRemotes: vi.fn(),
  useRepoStatus: vi.fn(),
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

describe("RepoView", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useStore).mockReturnValue({
      activeTabId: "repo1",
      commits: [],
      selectedOid: null,
      searchFilter: "",
      setCommits: vi.fn(),
      selectCommit: vi.fn(),
      setSearchFilter: vi.fn(),
    } as any);

    vi.mocked(useCommits).mockReturnValue({ data: [], isLoading: false, error: null } as any);
    vi.mocked(useHeadInfo).mockReturnValue({ data: { oid: "abcdef", branch: "main" } } as any);
    vi.mocked(useRepoStatus).mockReturnValue({ data: { merge_in_progress: false } } as any);
    vi.mocked(useRemotes).mockReturnValue({ data: [] } as any);
    vi.mocked(useRefreshRepo).mockReturnValue(vi.fn());
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
});
