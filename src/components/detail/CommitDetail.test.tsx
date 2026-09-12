import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { CommitDetail } from "./CommitDetail";
import { useCommit, useCommitDiff, useCommitInRef } from "@/lib/queries";
import { useStore } from "@/lib/store";
import type { FileDiff, PositionedCommit } from "@/lib/ipc";

vi.mock("@/lib/queries", () => ({
  useCommit: vi.fn(),
  useCommitDiff: vi.fn(),
  useCommitInRef: vi.fn(),
}));

// jsdom has no layout, so no scrolling APIs.
Element.prototype.scrollTo = vi.fn();
Element.prototype.scrollIntoView = vi.fn();

function commit(overrides: Partial<PositionedCommit["commit"]> = {}): PositionedCommit {
  return {
    commit: {
      oid: "988b9f5f81ff00112233445566778899aabbccdd",
      parent_oids: ["529a0f0f00112233445566778899aabbccddeeff"],
      summary: "fix: support new and commit-less repositories",
      body: "",
      author_name: "Ada",
      author_email: "ada@example.com",
      timestamp: 1_755_300_000,
      refs: [],
      local_branches: [],
      remote_branches: [],
      ...overrides,
    },
    lane: 0, row: 0, color_idx: 0, edges: [],
  };
}

function file(path: string, adds: number, dels: number, extra: Partial<FileDiff> = {}): FileDiff {
  return {
    path,
    old_path: null,
    status: "modified",
    binary: false,
    hunks: [{
      header: "@@ -1,1 +1,1 @@",
      lines: [
        ...Array.from({ length: dels }, (_, i) => ({ kind: "deletion" as const, content: `old secret line ${i}` })),
        ...Array.from({ length: adds }, (_, i) => ({ kind: "addition" as const, content: `new secret line ${i}` })),
      ],
    }],
    ...extra,
  };
}

const FILES = [
  file("scripts/fixtures/make-fixtures.mjs", 88, 6),
  file("src/lib/ipc.ts", 2, 1),
  file("logo.png", 0, 0, { binary: true, hunks: [], status: "added" }),
];

function mockDiff(state: Partial<ReturnType<typeof useCommitDiff>>) {
  vi.mocked(useCommitDiff).mockReturnValue({
    data: undefined, isLoading: false, error: null, refetch: vi.fn(), isFetching: false, ...state,
  } as unknown as ReturnType<typeof useCommitDiff>);
}

describe("CommitDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ fileListView: "path", commitPanelCollapsed: false });
    vi.mocked(useCommit).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useCommit>);
    vi.mocked(useCommitInRef).mockReturnValue(
      { data: undefined, isLoading: false, error: null } as unknown as ReturnType<typeof useCommitInRef>,
    );
    mockDiff({ data: FILES });
  });

  it("lists files as rows without rendering any diff content inline", () => {
    render(<CommitDetail repoId="r" item={commit()} />);
    expect(screen.getByRole("button", { name: /make-fixtures\.mjs, modified, in scripts\/fixtures/ })).toBeInTheDocument();
    expect(screen.queryByText(/secret line/)).not.toBeInTheDocument();
    expect(screen.queryByText("@@ -1,1 +1,1 @@")).not.toBeInTheDocument();
  });

  it("shows per-file and total line counts, and marks binary files", () => {
    render(<CommitDetail repoId="r" item={commit()} />);
    const list = screen.getByRole("region", { name: "Changed files" });
    expect(within(list).getByText("+88")).toBeInTheDocument();
    expect(within(list).getByText("−6")).toBeInTheDocument();
    expect(within(list).getByLabelText("90 lines added, 7 removed")).toBeInTheDocument();
    expect(within(list).getByText("bin")).toBeInTheDocument();
  });

  it("opens a file on click and highlights the open file", () => {
    const onFileClick = vi.fn();
    render(<CommitDetail repoId="r" item={commit()} selectedPath="src/lib/ipc.ts" onFileClick={onFileClick} />);
    const row = screen.getByRole("button", { name: /^ipc\.ts/ });
    expect(row).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: /^make-fixtures\.mjs/ }));
    expect(onFileClick).toHaveBeenCalledWith(FILES[0]);
  });

  it("moves between rows with the arrow keys", () => {
    render(<CommitDetail repoId="r" item={commit()} />);
    const first = screen.getByRole("button", { name: /^make-fixtures\.mjs/ });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: /^ipc\.ts/ })).toHaveFocus();
  });

  it("groups files by folder in tree view", () => {
    useStore.setState({ fileListView: "tree" });
    render(<CommitDetail repoId="r" item={commit()} />);
    const folder = screen.getByRole("button", { name: "src folder" });
    expect(folder).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(folder);
    expect(screen.queryByRole("button", { name: /^ipc\.ts/ })).not.toBeInTheDocument();
  });

  it("offers a retry when the changes fail to load", () => {
    const refetch = vi.fn();
    mockDiff({ data: undefined, error: new Error("boom"), refetch });
    render(<CommitDetail repoId="r" item={commit()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load this commit's changes.");
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("labels merge commits as diffed against the first parent and lets parents be opened", () => {
    const onSelectCommit = vi.fn();
    const parents = ["1111111aaaa", "2222222bbbb"];
    render(<CommitDetail repoId="r" item={commit({ parent_oids: parents })} onSelectCommit={onSelectCommit} />);
    expect(screen.getByText(/changes shown against the first parent/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to parent commit 2222222" }));
    expect(onSelectCommit).toHaveBeenCalledWith("2222222bbbb");
  });

  it("stays collapsed across commits", () => {
    const { rerender } = render(<CommitDetail repoId="r" item={commit()} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse commit details" }));
    rerender(<CommitDetail repoId="r" item={commit({ oid: "ffffffffffffffff" })} />);
    expect(screen.getByRole("button", { name: "Expand commit details" })).toBeInTheDocument();
  });
});

describe("CommitDetail — in-branch badge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ fileListView: "path", commitPanelCollapsed: false });
    vi.mocked(useCommit).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useCommit>);
    mockDiff({ data: FILES });
  });

  it('shows "in {branch}" when the commit is in the checked-out branch', () => {
    vi.mocked(useCommitInRef).mockReturnValue(
      { data: true, isLoading: false, error: null } as unknown as ReturnType<typeof useCommitInRef>,
    );
    render(<CommitDetail repoId="r" item={commit()} headBranch="master" headOid="abc123" />);
    expect(screen.getByLabelText("This commit is in master")).toHaveTextContent("in master");
  });

  it('shows "not in {branch}" when the commit is not in the checked-out branch', () => {
    vi.mocked(useCommitInRef).mockReturnValue(
      { data: false, isLoading: false, error: null } as unknown as ReturnType<typeof useCommitInRef>,
    );
    render(<CommitDetail repoId="r" item={commit()} headBranch="master" headOid="abc123" />);
    expect(screen.getByLabelText("This commit is not in master")).toHaveTextContent("not in master");
  });

  it('labels the badge "HEAD" when HEAD is detached (no branch name)', () => {
    vi.mocked(useCommitInRef).mockReturnValue(
      { data: true, isLoading: false, error: null } as unknown as ReturnType<typeof useCommitInRef>,
    );
    render(<CommitDetail repoId="r" item={commit()} headBranch={null} headOid="abc123" />);
    expect(screen.getByLabelText("This commit is in HEAD")).toBeInTheDocument();
  });

  it("hides the badge when headOid is null (unborn repo)", () => {
    vi.mocked(useCommitInRef).mockReturnValue(
      { data: true, isLoading: false, error: null } as unknown as ReturnType<typeof useCommitInRef>,
    );
    render(<CommitDetail repoId="r" item={commit()} headBranch="master" headOid={null} />);
    expect(screen.queryByLabelText(/This commit is/)).not.toBeInTheDocument();
  });

  it("hides the badge while the answer is still loading", () => {
    vi.mocked(useCommitInRef).mockReturnValue(
      { data: undefined, isLoading: true, error: null } as unknown as ReturnType<typeof useCommitInRef>,
    );
    render(<CommitDetail repoId="r" item={commit()} headBranch="master" headOid="abc123" />);
    expect(screen.queryByLabelText(/This commit is/)).not.toBeInTheDocument();
  });

  it("truncates a long branch name inside the chip, keeping the full name in the title", () => {
    vi.mocked(useCommitInRef).mockReturnValue(
      { data: true, isLoading: false, error: null } as unknown as ReturnType<typeof useCommitInRef>,
    );
    const longBranch = "feature/a-very-long-branch-name-that-should-be-truncated";
    render(<CommitDetail repoId="r" item={commit()} headBranch={longBranch} headOid="abc123" />);

    const chip = screen.getByLabelText(`This commit is in ${longBranch}`);
    expect(chip).toHaveAttribute("title", longBranch);
    expect(within(chip).getByText(longBranch)).toHaveClass("truncate");
  });

  it("hides the badge on error", () => {
    vi.mocked(useCommitInRef).mockReturnValue(
      { data: undefined, isLoading: false, error: new Error("boom") } as unknown as ReturnType<typeof useCommitInRef>,
    );
    render(<CommitDetail repoId="r" item={commit()} headBranch="master" headOid="abc123" />);
    expect(screen.queryByLabelText(/This commit is/)).not.toBeInTheDocument();
  });
});
