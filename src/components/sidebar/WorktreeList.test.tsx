import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorktreeList } from "./WorktreeList";
import { ipc, type WorktreeInfo } from "@/lib/ipc";
import { useWorktrees, useWorktreeStatus } from "@/lib/queries";
import { useOpenWorktree } from "@/lib/useOpenRepo";
import { toast } from "sonner";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    pruneWorktrees: vi.fn(),
  },
}));

vi.mock("@/lib/queries", () => ({
  useWorktrees: vi.fn(),
  useWorktreeStatus: vi.fn(),
}));

vi.mock("@/lib/useOpenRepo", () => ({
  useOpenWorktree: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), promise: vi.fn() },
}));

const REPO_ID = "E:\\repo";

const WT = (o: Partial<WorktreeInfo>): WorktreeInfo => ({
  path: "E:\\r", name: "r", is_main: false, is_current: false, branch: "feat",
  head_oid: "abcdef1234", is_detached: false, is_locked: false, lock_reason: null,
  is_missing: false, branch_merged: false, ...o,
});
const MAIN = WT({ path: "E:\\repo", name: "repo", is_main: true, is_current: true, branch: "master" });
const AGENT = WT({ path: "E:\\repo-agent", name: "repo-agent", branch: "sinalizacao" });

describe("WorktreeList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useWorktreeStatus).mockReturnValue({ data: undefined, isError: false } as any);
    vi.mocked(useOpenWorktree).mockReturnValue(vi.fn());
  });

  it("renders nothing with only the main worktree", () => {
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN] } as any);
    const { container } = render(<WorktreeList repoId={REPO_ID} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists worktrees with branch, current marker and live change count", () => {
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, AGENT] } as any);
    vi.mocked(useWorktreeStatus).mockImplementation((p) =>
      ({ data: p === "E:\\repo-agent" ? { changed: 3, conflicted: false } : { changed: 0, conflicted: false } }) as any);
    render(<WorktreeList repoId={REPO_ID} />);
    expect(screen.getByText("Worktrees")).toBeInTheDocument();
    expect(screen.getByText("sinalizacao")).toHaveClass("font-mono");
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^repo, master, current/ })).toBeInTheDocument();
  });

  it("never nests a button inside another button (a11y/content-model hazard)", () => {
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, AGENT] } as any);
    const { container } = render(<WorktreeList repoId={REPO_ID} />);
    expect(container.querySelectorAll("button button").length).toBe(0);
  });

  it("header is a keyboard-reachable button that toggles the rows", () => {
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, AGENT] } as any);
    render(<WorktreeList repoId={REPO_ID} />);
    const header = screen.getByRole("button", { name: /Worktrees/ });
    expect(screen.getByRole("button", { name: /^repo-agent, / })).toBeInTheDocument();
    fireEvent.click(header);
    expect(screen.queryByRole("button", { name: /^repo-agent, / })).toBeNull();
    fireEvent.click(header);
    expect(screen.getByRole("button", { name: /^repo-agent, / })).toBeInTheDocument();
  });

  it("shows short hash for a detached worktree", () => {
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, WT({ name: "det", branch: null, is_detached: true, head_oid: "1234567abc" })] } as any);
    render(<WorktreeList repoId={REPO_ID} />);
    expect(screen.getByText("1234567")).toBeInTheDocument();
  });

  it("double-click opens the worktree in a tab; never on the current row", () => {
    const open = vi.fn();
    vi.mocked(useOpenWorktree).mockReturnValue(open);
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, AGENT] } as any);
    render(<WorktreeList repoId={REPO_ID} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: /^repo-agent, / }));
    expect(open).toHaveBeenCalledWith("E:\\repo-agent");
    fireEvent.doubleClick(screen.getByRole("button", { name: /^repo, master, current/ }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("click selects the worktree's HEAD commit", () => {
    const onSelectOid = vi.fn();
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, AGENT] } as any);
    render(<WorktreeList repoId={REPO_ID} onSelectOid={onSelectOid} />);
    fireEvent.click(screen.getByRole("button", { name: /^repo-agent, / }));
    expect(onSelectOid).toHaveBeenCalledWith("abcdef1234");
  });

  // ── Design P2: missing-worktree rows are actionable ────────────────────────

  it("missing row's context menu is exactly Copy path, separator, Prune missing — no disabled items", async () => {
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, WT({ name: "gone", is_missing: true, branch: null, head_oid: null })] } as any);
    render(<WorktreeList repoId={REPO_ID} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /^gone, missing$/ }));

    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Copy path", "Prune missing"]);
    items.forEach((i) => expect(i).not.toHaveAttribute("data-disabled"));

    fireEvent.click(screen.getByRole("menuitem", { name: "Prune missing" }));
    await waitFor(() => expect(ipc.pruneWorktrees).toHaveBeenCalledWith(REPO_ID));
  });

  it("raises the missing row from opacity-35 to opacity-60, keeping italics and the label", () => {
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, WT({ name: "gone", is_missing: true, branch: null, head_oid: null })] } as any);
    render(<WorktreeList repoId={REPO_ID} />);
    const row = screen.getByRole("button", { name: /^gone, missing$/ });
    expect(row).toHaveClass("opacity-60", "italic");
    expect(row).not.toHaveClass("opacity-35");
    expect(screen.getByText("missing")).toBeInTheDocument();
  });

  it("missing worktree is dimmed and the header offers Prune missing", async () => {
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, WT({ name: "gone", is_missing: true, branch: null, head_oid: null })] } as any);
    render(<WorktreeList repoId={REPO_ID} />);
    expect(screen.getByText("missing")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Prune missing"));
    await waitFor(() => expect(ipc.pruneWorktrees).toHaveBeenCalledWith("E:\\repo"));
  });

  it("missing row's accessible name is '<name>, missing'", () => {
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, WT({ name: "gone", is_missing: true, branch: null, head_oid: null })] } as any);
    render(<WorktreeList repoId={REPO_ID} />);
    expect(screen.getByRole("button", { name: /^gone, missing$/ })).toBeInTheDocument();
  });

  it("a rejected prune shows an error toast instead of failing silently", async () => {
    vi.mocked(ipc.pruneWorktrees).mockRejectedValue(new Error("prune boom"));
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, WT({ name: "gone", is_missing: true, branch: null, head_oid: null })] } as any);
    render(<WorktreeList repoId={REPO_ID} />);
    fireEvent.click(screen.getByText("Prune missing"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Error: prune boom"));
  });

  // ── Design P1: "stuck?" and "done?" ────────────────────────────────────────

  it("shows a mono 'conflict' tag in WIP orange before the count", () => {
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, AGENT] } as any);
    vi.mocked(useWorktreeStatus).mockImplementation((p) =>
      ({ data: p === "E:\\repo-agent" ? { changed: 2, conflicted: true } : { changed: 0, conflicted: false } }) as any);
    render(<WorktreeList repoId={REPO_ID} />);
    const tag = screen.getByText("conflict");
    expect(tag).toHaveClass("font-mono", "text-orange-300/80");
    // Conflict tag renders before the count in document order.
    const count = screen.getByTitle("2 uncommitted changes");
    expect(tag.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("includes conflicted in the row's aria-label", () => {
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, AGENT] } as any);
    vi.mocked(useWorktreeStatus).mockImplementation((p) =>
      ({ data: p === "E:\\repo-agent" ? { changed: 1, conflicted: true } : { changed: 0, conflicted: false } }) as any);
    render(<WorktreeList repoId={REPO_ID} />);
    expect(screen.getByRole("button", { name: /repo-agent, sinalizacao, conflicted, 1 uncommitted/ })).toBeInTheDocument();
  });

  it("shows a quiet merged Check icon for a clean, merged, non-main, non-current row", () => {
    vi.mocked(useWorktrees).mockReturnValue({
      data: [MAIN, WT({ name: "done", branch: "done-feat", branch_merged: true })],
    } as any);
    vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 0, conflicted: false } } as any);
    render(<WorktreeList repoId={REPO_ID} />);
    expect(screen.getByTitle("merged")).toBeInTheDocument();
    expect(screen.getByText("merged")).toHaveClass("sr-only");
    expect(screen.getByRole("button", { name: /done, done-feat, merged$/ })).toBeInTheDocument();
  });

  it("does not show the merged icon while status is still loading, even though branch_merged is true", () => {
    vi.mocked(useWorktrees).mockReturnValue({
      data: [MAIN, WT({ name: "done", branch: "done-feat", branch_merged: true })],
    } as any);
    vi.mocked(useWorktreeStatus).mockReturnValue({ data: undefined, isError: false } as any);
    render(<WorktreeList repoId={REPO_ID} />);
    expect(screen.queryByTitle("merged")).not.toBeInTheDocument();
  });

  it("does not show the merged icon for main or the current worktree even when clean and merged", () => {
    vi.mocked(useWorktrees).mockReturnValue({
      data: [
        WT({ path: "E:\\repo", name: "repo", is_main: true, is_current: true, branch: "master", branch_merged: true }),
        WT({ name: "cur", is_current: true, branch_merged: true }),
        WT({ name: "other", branch: "x" }),
      ],
    } as any);
    vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 0, conflicted: false } } as any);
    render(<WorktreeList repoId={REPO_ID} />);
    expect(screen.queryByTitle("merged")).not.toBeInTheDocument();
  });

  it("shows a muted dash while a row's status is loading (no data, no error) — same as unknown", () => {
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, AGENT] } as any);
    vi.mocked(useWorktreeStatus).mockReturnValue({ data: undefined, isError: false } as any);
    render(<WorktreeList repoId={REPO_ID} />);
    const dashes = screen.getAllByText("–");
    expect(dashes.length).toBeGreaterThan(0);
    dashes.forEach((d) => expect(d).toHaveClass("text-muted-foreground/40"));
  });

  it("the count has an accessible unit: sr-only ' uncommitted' and a pluralized title", () => {
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, AGENT] } as any);
    vi.mocked(useWorktreeStatus).mockImplementation((p) =>
      ({ data: p === "E:\\repo-agent" ? { changed: 1, conflicted: false } : { changed: 0, conflicted: false } }) as any);
    const { rerender } = render(<WorktreeList repoId={REPO_ID} />);
    const count = screen.getByText("1");
    expect(count).toHaveAttribute("title", "1 uncommitted change");
    expect(count.querySelector(".sr-only")).toHaveTextContent("uncommitted");

    vi.mocked(useWorktreeStatus).mockImplementation((p) =>
      ({ data: p === "E:\\repo-agent" ? { changed: 3, conflicted: false } : { changed: 0, conflicted: false } }) as any);
    rerender(<WorktreeList repoId={REPO_ID} />);
    expect(screen.getByText("3")).toHaveAttribute("title", "3 uncommitted changes");
  });

  // ── Design P2: names don't hide agent suffixes ─────────────────────────────

  it("distinguishes agent worktree names whose differentiator is buried mid-string when truncated", () => {
    const wt1 = WT({ path: "E:\\repo1", name: "waypoint-agent-1-longer-suffix", branch: "b1" });
    const wt2 = WT({ path: "E:\\repo2", name: "waypoint-agent-2-longer-suffix", branch: "b2" });
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, wt1, wt2] } as any);
    render(<WorktreeList repoId={REPO_ID} />);

    const rendered = screen.getAllByTitle(/^waypoint-agent-\d-longer-suffix$/).map((el) => el.textContent);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).not.toBe(rendered[1]);
    // Both suffixes ("agent-1"/"agent-2") must be visibly present, not just
    // present in the title tooltip.
    expect(rendered.some((t) => t?.includes("1"))).toBe(true);
    expect(rendered.some((t) => t?.includes("2"))).toBe(true);
  });

  it("keeps the full folder name available via title even when the visible text is truncated", () => {
    const longName = "waypoint-agent-1-longer-suffix";
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, WT({ path: "E:\\r2", name: longName })] } as any);
    render(<WorktreeList repoId={REPO_ID} />);
    expect(screen.getByTitle(longName)).toBeInTheDocument();
  });

  it("lets the branch shrink and middle-truncate instead of a fixed end-cut", () => {
    vi.mocked(useWorktrees).mockReturnValue({
      data: [MAIN, WT({ name: "wt", branch: "feature/very-long-branch-name-here" })],
    } as any);
    render(<WorktreeList repoId={REPO_ID} />);
    const branchEl = screen.getByTitle("feature/very-long-branch-name-here");
    expect(branchEl).toHaveClass("min-w-0", "truncate");
    expect(branchEl.textContent).toContain("…");
  });

  // ── Item 1: the branch shrinks, not the name (class structure only — jsdom
  //    has no layout, so we assert the flex classes that make shrinking
  //    possible rather than actual rendered widths) ───────────────────────────

  it("gives the right-hand cluster min-w-0 (not shrink-0) so its shrinkable child can give way", () => {
    vi.mocked(useWorktrees).mockReturnValue({
      data: [MAIN, WT({ name: "wt", branch: "feature/very-long-branch-name-here" })],
    } as any);
    render(<WorktreeList repoId={REPO_ID} />);
    const branchEl = screen.getByTitle("feature/very-long-branch-name-here");
    // The right cluster is the branch span's parent.
    const rightCluster = branchEl.parentElement!;
    expect(rightCluster).toHaveClass("min-w-0");
    expect(rightCluster).not.toHaveClass("shrink-0");
  });

  it("keeps the right cluster's fixed-size children shrink-0 (count, conflict tag, lock, spacer)", () => {
    vi.mocked(useWorktrees).mockReturnValue({
      data: [MAIN, AGENT],
    } as any);
    vi.mocked(useWorktreeStatus).mockImplementation((p) =>
      ({ data: p === "E:\\repo-agent" ? { changed: 2, conflicted: true } : { changed: 0, conflicted: false } }) as any);
    render(<WorktreeList repoId={REPO_ID} />);
    expect(screen.getByText("conflict")).toHaveClass("shrink-0");
    expect(screen.getByTitle("2 uncommitted changes")).toHaveClass("shrink-0");
  });

  it("makes the name container shrink-0 so the name is never squeezed by flex", () => {
    vi.mocked(useWorktrees).mockReturnValue({
      data: [MAIN, WT({ name: "wt", branch: "feature/very-long-branch-name-here" })],
    } as any);
    render(<WorktreeList repoId={REPO_ID} />);
    const nameSpan = screen.getByTitle("wt");
    const nameContainer = nameSpan.parentElement!;
    expect(nameContainer).toHaveClass("shrink-0");
    expect(nameContainer).not.toHaveClass("min-w-0");
  });

  it("filter matches folder name or branch", () => {
    vi.mocked(useWorktrees).mockReturnValue({ data: [MAIN, AGENT] } as any);
    const { rerender } = render(<WorktreeList repoId={REPO_ID} filter="sinal" />);
    expect(screen.getByText("repo-agent")).toBeInTheDocument();
    rerender(<WorktreeList repoId={REPO_ID} filter="zzz" />);
    expect(screen.queryByText("Worktrees")).toBeNull();
  });
});
