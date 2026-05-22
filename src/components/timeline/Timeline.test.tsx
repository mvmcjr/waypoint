import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Timeline } from "./Timeline";
import { useRepoStatus, useRefs, useStashes } from "@/lib/queries";
import type { PositionedCommit } from "@/lib/ipc";

// Mock the queries
vi.mock("@/lib/queries", () => ({
  useRepoStatus: vi.fn(),
  useStashes: vi.fn(),
  useRefs: vi.fn(),
}));

// Mock the subcomponents to isolate the Timeline tests
vi.mock("./GraphLayer", () => ({
  GraphLayer: vi.fn((props) => (
    <div data-testid="graph-layer" data-width={props.width}>
      GraphLayer
    </div>
  )),
  LANE_WIDTH: 14,
  ROW_HEIGHT: 24,
  REFS_COL_WIDTH: 160,
}));

vi.mock("./CommitRow", () => ({
  CommitRow: vi.fn((props) => (
    <div data-testid={`commit-row-${props.item.commit.oid}`} onClick={props.onClick}>
      {props.item.commit.summary}
    </div>
  )),
}));

vi.mock("./WipRow", () => ({
  WipRow: vi.fn((props) => (
    <div data-testid="wip-row" onClick={props.onClick}>
      WIP
    </div>
  )),
}));

vi.mock("./CommitContextMenu", () => ({
  CommitContextMenu: vi.fn(({ children }) => <div data-testid="context-menu">{children}</div>),
}));

// Mock virtualization
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: vi.fn().mockImplementation((config) => ({
    getVirtualItems: () => Array.from({ length: config.count }).map((_, i) => ({ index: i })),
    getTotalSize: () => config.count * 24,
    scrollToIndex: vi.fn(),
  })),
}));

describe("Timeline", () => {
  const mockOnSelectOid = vi.fn();
  const mockOnCommitAction = vi.fn();
  const mockOnWipClick = vi.fn();

  const dummyCommit: PositionedCommit = {
    lane: 0,
    row: 0,
    color_idx: 0,
    edges: [],
    commit: {
      oid: "c1",
      parent_oids: [],
      author_name: "Test",
      author_email: "test@test.com",
      timestamp: 0,
      summary: "First commit",
      refs: [],
      local_branches: [],
      remote_branches: [],
    },
  };

  const defaultProps = {
    repoId: "repo1",
    commits: [dummyCommit],
    selectedOid: null,
    headOid: "c1",
    headBranch: "main",
    onSelectOid: mockOnSelectOid,
    onCommitAction: mockOnCommitAction,
    onWipClick: mockOnWipClick,
    wipSelected: false,
    searchActive: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRepoStatus).mockReturnValue({
      data: { staged_count: 0, unstaged_count: 0, merge_in_progress: false },
    } as any);
    vi.mocked(useStashes).mockReturnValue({ data: [] } as any);
    vi.mocked(useRefs).mockReturnValue({ data: [] } as any);

    // Mock localStorage
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store[key] || null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    });
  });

  it("renders empty state when there are no commits", () => {
    render(<Timeline {...defaultProps} commits={[]} />);
    expect(screen.getByText("No commits found.")).toBeInTheDocument();
  });

  it("renders empty state for search when active and no commits", () => {
    render(<Timeline {...defaultProps} commits={[]} searchActive={true} />);
    expect(screen.getByText("No matching commits.")).toBeInTheDocument();
  });

  it("renders virtualized commit rows", () => {
    render(<Timeline {...defaultProps} />);
    expect(screen.getByTestId("commit-row-c1")).toBeInTheDocument();
    expect(screen.getByText("First commit")).toBeInTheDocument();
  });

  it("calls onSelectOid when a commit row is clicked", () => {
    render(<Timeline {...defaultProps} />);
    const row = screen.getByTestId("commit-row-c1");
    fireEvent.click(row);
    expect(mockOnSelectOid).toHaveBeenCalledWith("c1");
  });

  it("renders the GraphLayer when search is inactive", () => {
    render(<Timeline {...defaultProps} />);
    expect(screen.getByTestId("graph-layer")).toBeInTheDocument();
  });

  it("hides the GraphLayer when search is active", () => {
    render(<Timeline {...defaultProps} searchActive={true} />);
    expect(screen.queryByTestId("graph-layer")).not.toBeInTheDocument();
  });

  it("calculates graph width considering edge routing, not just commit lanes", () => {
    // A commit on lane 0, but an edge routes to lane 3.
    // maxLanes should be max(0 + 1, 3 + 1) = 4.
    // naturalGraphWidth = 4 * 14 + 14 = 70.
    const complexCommit: PositionedCommit = {
      ...dummyCommit,
      lane: 0,
      edges: [
        { from_lane: 0, to_lane: 3, from_row: 0, to_row: 5, color_idx: 0 }
      ],
    };

    render(<Timeline {...defaultProps} commits={[complexCommit]} />);
    
    // maxLanes = 4 -> 4 * 14 + 14 = 70
    const graphLayer = screen.getByTestId("graph-layer");
    expect(graphLayer).toHaveAttribute("data-width", "70");
  });

  describe("WIP Row", () => {
    it("renders WIP row when there are staged or unstaged changes", () => {
      vi.mocked(useRepoStatus).mockReturnValue({
        data: { staged_count: 1, unstaged_count: 0, merge_in_progress: false },
      } as any);
      
      render(<Timeline {...defaultProps} />);
      expect(screen.getByTestId("wip-row")).toBeInTheDocument();
    });

    it("renders WIP row when a merge is in progress", () => {
      vi.mocked(useRepoStatus).mockReturnValue({
        data: { staged_count: 0, unstaged_count: 0, merge_in_progress: true },
      } as any);
      
      render(<Timeline {...defaultProps} />);
      expect(screen.getByTestId("wip-row")).toBeInTheDocument();
    });

    it("hides WIP row when search is active even if dirty", () => {
      vi.mocked(useRepoStatus).mockReturnValue({
        data: { staged_count: 1, unstaged_count: 0, merge_in_progress: false },
      } as any);
      
      render(<Timeline {...defaultProps} searchActive={true} />);
      expect(screen.queryByTestId("wip-row")).not.toBeInTheDocument();
    });

    it("calls onWipClick when WIP row is clicked", () => {
      vi.mocked(useRepoStatus).mockReturnValue({
        data: { staged_count: 1, unstaged_count: 0, merge_in_progress: false },
      } as any);
      
      render(<Timeline {...defaultProps} />);
      fireEvent.click(screen.getByTestId("wip-row"));
      expect(mockOnWipClick).toHaveBeenCalled();
    });
  });

  describe("Column splitters", () => {
    it("renders two column splitters by default", () => {
      render(<Timeline {...defaultProps} />);
      const splitters = screen.getAllByRole("separator");
      expect(splitters).toHaveLength(2);
    });

    it("renders only one column splitter when search is active", () => {
      render(<Timeline {...defaultProps} searchActive={true} />);
      const splitters = screen.getAllByRole("separator");
      expect(splitters).toHaveLength(1);
    });

    it("handles dragging the refs splitter", () => {
      render(<Timeline {...defaultProps} />);
      const splitters = screen.getAllByRole("separator");
      const refsSplitter = splitters[0];

      // Initial mousedown
      fireEvent.mouseDown(refsSplitter, { clientX: 100 });
      expect(document.body.style.cursor).toBe("col-resize");

      // Mousemove
      fireEvent.mouseMove(window, { clientX: 120 }); // delta +20
      
      // Mouseup
      fireEvent.mouseUp(window);
      expect(document.body.style.cursor).toBe("");
    });
  });
});
