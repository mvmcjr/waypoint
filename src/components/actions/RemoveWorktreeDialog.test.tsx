import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RemoveWorktreeDialog } from "./RemoveWorktreeDialog";
import { ipc, type WorktreeInfo } from "@/lib/ipc";
import { useWorktreeStatus } from "@/lib/queries";
import { useStore } from "@/lib/store";
import { toast } from "sonner";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    removeWorktree: vi.fn(),
  },
}));

vi.mock("@/lib/queries", () => ({
  useWorktreeStatus: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { message: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const AGENT: WorktreeInfo = {
  path: "E:\\repo-agent",
  name: "repo-agent",
  is_main: false,
  is_current: false,
  branch: "feat",
  head_oid: "abc",
  is_detached: false,
  is_locked: false,
  lock_reason: null,
  is_missing: false,
  branch_merged: true,
};

describe("RemoveWorktreeDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ tabs: [], activeTabId: null } as any);
  });

  it("clean worktree: plain Remove, no danger banner", async () => {
    vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 0, conflicted: false } } as any);
    vi.mocked(ipc.removeWorktree).mockResolvedValue({ branch_deleted: false, branch_kept_reason: null });
    render(<RemoveWorktreeDialog repoId="E:\repo" worktree={AGENT} currentBranch="master" onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.queryByText(/permanently lost/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(ipc.removeWorktree).toHaveBeenCalledWith("E:\\repo", "E:\\repo-agent", false, false));
  });

  it("dirty worktree: danger banner and destructive force removal", async () => {
    vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 3, conflicted: false } } as any);
    vi.mocked(ipc.removeWorktree).mockResolvedValue({ branch_deleted: false, branch_kept_reason: null });
    render(<RemoveWorktreeDialog repoId="E:\repo" worktree={AGENT} currentBranch="master" onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByText(/3 uncommitted change\(s\) in repo-agent will be permanently lost/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove and discard changes" }));
    await waitFor(() => expect(ipc.removeWorktree).toHaveBeenCalledWith("E:\\repo", "E:\\repo-agent", true, false));
  });

  it("branch checkbox follows branch_merged", () => {
    vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 0, conflicted: false } } as any);
    const { rerender } = render(<RemoveWorktreeDialog repoId="r" worktree={AGENT} currentBranch="master" onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByRole("checkbox")).not.toHaveAttribute("aria-disabled", "true");
    rerender(<RemoveWorktreeDialog repoId="r" worktree={{ ...AGENT, branch_merged: false }} currentBranch="master" onClose={vi.fn()} onSuccess={vi.fn()} />);
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toHaveAttribute("aria-disabled", "true");
    const reason = screen.getByText("Not merged into master. Kept.");
    expect(checkbox).toHaveAttribute("aria-describedby", reason.id);
  });

  it("checkbox is not nested inside the same label as another labelable control", () => {
    vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 0, conflicted: false } } as any);
    const { container } = render(<RemoveWorktreeDialog repoId="r" worktree={AGENT} currentBranch="master" onClose={vi.fn()} onSuccess={vi.fn()} />);
    container.querySelectorAll("label").forEach((label) => {
      const labelable = label.querySelectorAll("input, button, select, textarea");
      expect(labelable.length).toBeLessThanOrEqual(1);
    });
  });

  it("disables the checkbox while removal is in flight", async () => {
    vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 0, conflicted: false } } as any);
    let resolveRemove!: (v: { branch_deleted: boolean; branch_kept_reason: string | null }) => void;
    vi.mocked(ipc.removeWorktree).mockReturnValue(new Promise((resolve) => { resolveRemove = resolve; }));
    render(<RemoveWorktreeDialog repoId="E:\repo" worktree={AGENT} currentBranch="master" onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByRole("checkbox")).toHaveAttribute("aria-disabled", "true"));
    resolveRemove({ branch_deleted: false, branch_kept_reason: null });
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toHaveAttribute("aria-disabled", "true"));
  });

  it("worktree status still loading: confirm button disabled and reads 'Checking…', no ipc call", () => {
    vi.mocked(useWorktreeStatus).mockReturnValue({ data: undefined, isLoading: true, isError: false } as any);
    render(<RemoveWorktreeDialog repoId="E:\repo" worktree={AGENT} currentBranch="master" onClose={vi.fn()} onSuccess={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Checking…" });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(ipc.removeWorktree).not.toHaveBeenCalled();
  });

  it("worktree status errored: shows a neutral note and Remove still calls with force=false", async () => {
    vi.mocked(useWorktreeStatus).mockReturnValue({ data: undefined, isLoading: false, isError: true } as any);
    vi.mocked(ipc.removeWorktree).mockResolvedValue({ branch_deleted: false, branch_kept_reason: null });
    render(<RemoveWorktreeDialog repoId="E:\repo" worktree={AGENT} currentBranch="master" onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByText("Couldn't check repo-agent for uncommitted changes.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(ipc.removeWorktree).toHaveBeenCalledWith("E:\\repo", "E:\\repo-agent", false, false));
  });

  it("success closes the worktree's open tab", async () => {
    useStore.setState({ tabs: [{ id: "E:\\repo-agent", path: "E:\\repo-agent", label: "repo-agent", mainPath: "E:\\repo" }] } as any);
    vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 0, conflicted: false } } as any);
    vi.mocked(ipc.removeWorktree).mockResolvedValue({ branch_deleted: true, branch_kept_reason: null });
    const onSuccess = vi.fn();
    render(<RemoveWorktreeDialog repoId="E:\repo" worktree={AGENT} currentBranch="master" onClose={vi.fn()} onSuccess={onSuccess} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(useStore.getState().tabs.find((t) => t.id === "E:\\repo-agent")).toBeUndefined();
  });

  it("shows branch_kept_reason as a toast on success", async () => {
    vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 0, conflicted: false } } as any);
    vi.mocked(ipc.removeWorktree).mockResolvedValue({ branch_deleted: false, branch_kept_reason: "Branch not merged; kept." });
    const onSuccess = vi.fn();
    render(<RemoveWorktreeDialog repoId="E:\repo" worktree={AGENT} currentBranch="master" onClose={vi.fn()} onSuccess={onSuccess} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(toast.message).toHaveBeenCalledWith("Branch not merged; kept.");
  });

  it("shows the backend error verbatim and keeps the dialog open", async () => {
    vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 0, conflicted: false } } as any);
    vi.mocked(ipc.removeWorktree).mockRejectedValue(new Error("worktree is locked"));
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    render(<RemoveWorktreeDialog repoId="E:\repo" worktree={AGENT} currentBranch="master" onClose={onClose} onSuccess={onSuccess} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText(/worktree is locked/)).toBeInTheDocument());
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("detached worktree description mentions the commit reachability caveat", () => {
    vi.mocked(useWorktreeStatus).mockReturnValue({ data: { changed: 0, conflicted: false } } as any);
    const detached = { ...AGENT, branch: null, is_detached: true };
    render(<RemoveWorktreeDialog repoId="E:\repo" worktree={detached} currentBranch="master" onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByText(/its commit stays reachable only if another ref points to it/)).toBeInTheDocument();
  });
});
