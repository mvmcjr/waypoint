import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import {
  CherryPickDialog,
  RevertDialog,
  PullConflictsDialog,
  PushRejectedDialog,
  SquashDialog,
  CheckInBranchDialog,
} from "./Dialogs";
import { ipc } from "@/lib/ipc";
import { useRefs, useCommitInRef } from "@/lib/queries";
import type { RefInfo } from "@/lib/ipc";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    abortMerge: vi.fn(),
    pushBranch: vi.fn(),
    cherryPick: vi.fn(),
    finishCherryPick: vi.fn(),
    revertCommit: vi.fn(),
    finishRevert: vi.fn(),
    doCommit: vi.fn(),
    getSquashPreview: vi.fn(),
    squashCommits: vi.fn(),
  },
}));

vi.mock("@/lib/queries", () => ({
  useRefs: vi.fn(),
  useCommitInRef: vi.fn(),
}));

describe("Dialogs", () => {
  const mockOnClose = vi.fn();
  const mockOnSuccess = vi.fn();
  const mockOnAbort = vi.fn();
  const mockOnConflicts = vi.fn();
  const mockOnLeaveStaged = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("CherryPickDialog", () => {
    const defaultProps = {
      repoId: "repo1",
      oid: "abc123def456",
      summary: "feat: add new thing",
      onClose: mockOnClose,
      onSuccess: mockOnSuccess,
      onConflicts: mockOnConflicts,
      onLeaveStaged: mockOnLeaveStaged,
    };

    it("renders commit summary and short oid", () => {
      vi.mocked(ipc.cherryPick).mockResolvedValue({ kind: "staged", conflicted: [], message: "" });
      render(<CherryPickDialog {...defaultProps} />);

      expect(screen.getByRole("heading", { name: "Cherry-pick commit" })).toBeInTheDocument();
      expect(screen.getByText(/"feat: add new thing"/)).toBeInTheDocument();
      expect(screen.getByText("abc123de")).toBeInTheDocument();
    });

    it("shows staged dialog when cherry-pick applies cleanly", async () => {
      vi.mocked(ipc.cherryPick).mockResolvedValue({ kind: "staged", conflicted: [], message: "feat: add new thing" });
      render(<CherryPickDialog {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Cherry-pick" }));
      expect(ipc.cherryPick).toHaveBeenCalledWith("repo1", "abc123def456");

      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Cherry-pick applied cleanly" })).toBeInTheDocument()
      );
      expect(mockOnSuccess).not.toHaveBeenCalled();
      expect(mockOnConflicts).not.toHaveBeenCalled();
    });

    it("calls onSuccess after committing from staged dialog", async () => {
      vi.mocked(ipc.cherryPick).mockResolvedValue({ kind: "staged", conflicted: [], message: "feat: add new thing" });
      vi.mocked(ipc.doCommit).mockResolvedValue(undefined);
      render(<CherryPickDialog {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Cherry-pick" }));
      await waitFor(() => screen.getByRole("heading", { name: "Cherry-pick applied cleanly" }));

      fireEvent.click(screen.getByRole("button", { name: "Commit Cherry-pick" }));
      await waitFor(() => expect(mockOnSuccess).toHaveBeenCalled());
      expect(ipc.doCommit).toHaveBeenCalledWith("repo1", "feat: add new thing");
    });

    it("calls onLeaveStaged when Leave staged is clicked", async () => {
      vi.mocked(ipc.cherryPick).mockResolvedValue({ kind: "staged", conflicted: [], message: "feat: add new thing" });
      render(<CherryPickDialog {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Cherry-pick" }));
      await waitFor(() => screen.getByRole("heading", { name: "Cherry-pick applied cleanly" }));

      fireEvent.click(screen.getByRole("button", { name: "Leave staged" }));
      expect(mockOnLeaveStaged).toHaveBeenCalled();
      expect(mockOnSuccess).not.toHaveBeenCalled();
      expect(mockOnConflicts).not.toHaveBeenCalled();
    });

    it("calls onConflicts when cherry-pick produces conflicts", async () => {
      vi.mocked(ipc.cherryPick).mockResolvedValue({ kind: "conflicts", conflicted: ["src/lib.rs"], message: "" });
      render(<CherryPickDialog {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Cherry-pick" }));

      await waitFor(() => expect(mockOnConflicts).toHaveBeenCalled());
      expect(mockOnSuccess).not.toHaveBeenCalled();
    });

    it("shows error message when ipc.cherryPick throws", async () => {
      vi.mocked(ipc.cherryPick).mockRejectedValue(new Error("repo not found"));
      render(<CherryPickDialog {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Cherry-pick" }));

      await waitFor(() => expect(screen.getByText("Error: repo not found")).toBeInTheDocument());
      expect(mockOnSuccess).not.toHaveBeenCalled();
      expect(mockOnConflicts).not.toHaveBeenCalled();
    });

    it("disables both buttons while applying", async () => {
      let resolve!: (r: { kind: string; conflicted: string[]; message: string }) => void;
      vi.mocked(ipc.cherryPick).mockReturnValue(new Promise((res) => { resolve = res; }) as any);

      render(<CherryPickDialog {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Cherry-pick" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Applying…" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      });

      act(() => resolve({ kind: "staged", conflicted: [], message: "" }));
    });

    it("calls onClose when Cancel is clicked", () => {
      vi.mocked(ipc.cherryPick).mockResolvedValue({ kind: "staged", conflicted: [], message: "" });
      render(<CherryPickDialog {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(mockOnClose).toHaveBeenCalled();
      expect(ipc.cherryPick).not.toHaveBeenCalled();
    });
  });

  describe("RevertDialog", () => {
    const defaultProps = {
      repoId: "repo1",
      oid: "abc123def456",
      summary: "feat: add new thing",
      onClose: mockOnClose,
      onSuccess: mockOnSuccess,
      onConflicts: mockOnConflicts,
      onLeaveStaged: mockOnLeaveStaged,
    };

    it("renders commit summary and short oid", () => {
      vi.mocked(ipc.revertCommit).mockResolvedValue({ kind: "staged", conflicted: [], message: "" });
      render(<RevertDialog {...defaultProps} />);

      expect(screen.getByRole("heading", { name: "Revert commit" })).toBeInTheDocument();
      expect(screen.getByText(/"revert: feat: add new thing"/)).toBeInTheDocument();
      expect(screen.getByText("abc123de")).toBeInTheDocument();
    });

    it("shows staged dialog when revert applies cleanly", async () => {
      vi.mocked(ipc.revertCommit).mockResolvedValue({ kind: "staged", conflicted: [], message: "revert: feat: add new thing" });
      render(<RevertDialog {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Revert" }));
      expect(ipc.revertCommit).toHaveBeenCalledWith("repo1", "abc123def456");

      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Revert applied cleanly" })).toBeInTheDocument()
      );
      expect(mockOnSuccess).not.toHaveBeenCalled();
      expect(mockOnConflicts).not.toHaveBeenCalled();
    });

    it("calls onSuccess after committing from staged dialog", async () => {
      vi.mocked(ipc.revertCommit).mockResolvedValue({ kind: "staged", conflicted: [], message: "revert: feat: add new thing" });
      vi.mocked(ipc.doCommit).mockResolvedValue(undefined);
      render(<RevertDialog {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Revert" }));
      await waitFor(() => screen.getByRole("heading", { name: "Revert applied cleanly" }));

      fireEvent.click(screen.getByRole("button", { name: "Commit Revert" }));
      await waitFor(() => expect(mockOnSuccess).toHaveBeenCalled());
      expect(ipc.doCommit).toHaveBeenCalledWith("repo1", "revert: feat: add new thing");
    });

    it("calls onLeaveStaged when Leave staged is clicked", async () => {
      vi.mocked(ipc.revertCommit).mockResolvedValue({ kind: "staged", conflicted: [], message: "revert: feat: add new thing" });
      render(<RevertDialog {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Revert" }));
      await waitFor(() => screen.getByRole("heading", { name: "Revert applied cleanly" }));

      fireEvent.click(screen.getByRole("button", { name: "Leave staged" }));
      expect(mockOnLeaveStaged).toHaveBeenCalled();
      expect(mockOnSuccess).not.toHaveBeenCalled();
      expect(mockOnConflicts).not.toHaveBeenCalled();
    });

    it("calls onConflicts when revert produces conflicts", async () => {
      vi.mocked(ipc.revertCommit).mockResolvedValue({ kind: "conflicts", conflicted: ["src/lib.rs"], message: "" });
      render(<RevertDialog {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Revert" }));

      await waitFor(() => expect(mockOnConflicts).toHaveBeenCalled());
      expect(mockOnSuccess).not.toHaveBeenCalled();
    });

    it("shows error message when ipc.revertCommit throws", async () => {
      vi.mocked(ipc.revertCommit).mockRejectedValue(new Error("repo not found"));
      render(<RevertDialog {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Revert" }));

      await waitFor(() => expect(screen.getByText("Error: repo not found")).toBeInTheDocument());
      expect(mockOnSuccess).not.toHaveBeenCalled();
      expect(mockOnConflicts).not.toHaveBeenCalled();
    });

    it("disables both buttons while reverting", async () => {
      let resolve!: (r: { kind: string; conflicted: string[]; message: string }) => void;
      vi.mocked(ipc.revertCommit).mockReturnValue(new Promise((res) => { resolve = res; }) as any);

      render(<RevertDialog {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Revert" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Reverting…" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      });

      act(() => resolve({ kind: "staged", conflicted: [], message: "" }));
    });

    it("calls onClose when Cancel is clicked", () => {
      vi.mocked(ipc.revertCommit).mockResolvedValue({ kind: "staged", conflicted: [], message: "" });
      render(<RevertDialog {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(mockOnClose).toHaveBeenCalled();
      expect(ipc.revertCommit).not.toHaveBeenCalled();
    });
  });

  describe("SquashDialog", () => {
    const oids = ["abc123def456", "def456abc789"];
    const defaultProps = {
      repoId: "repo1",
      oids,
      onClose: mockOnClose,
      onSuccess: mockOnSuccess,
    };

    it("loads preview: shows count and suggested subject/body", async () => {
      vi.mocked(ipc.getSquashPreview).mockResolvedValue({ count: 3, default_subject: "feat: combined", default_body: "details here" });
      render(<SquashDialog {...defaultProps} />);

      expect(ipc.getSquashPreview).toHaveBeenCalledWith("repo1", oids);
      await waitFor(() => expect(screen.getByText("3")).toBeInTheDocument());
      expect(screen.getByDisplayValue("feat: combined")).toBeInTheDocument();
      expect(screen.getByDisplayValue("details here")).toBeInTheDocument();
    });

    it("composes subject + body into a single message and calls onSuccess", async () => {
      vi.mocked(ipc.getSquashPreview).mockResolvedValue({ count: 2, default_subject: "subj", default_body: "body text" });
      vi.mocked(ipc.squashCommits).mockResolvedValue(undefined);
      render(<SquashDialog {...defaultProps} />);

      await screen.findByDisplayValue("subj");
      fireEvent.click(screen.getByRole("button", { name: "Squash" }));

      expect(ipc.squashCommits).toHaveBeenCalledWith("repo1", oids, "subj\n\nbody text");
      await waitFor(() => expect(mockOnSuccess).toHaveBeenCalled());
    });

    it("omits the blank line when body is empty", async () => {
      vi.mocked(ipc.getSquashPreview).mockResolvedValue({ count: 2, default_subject: "only subject", default_body: "" });
      vi.mocked(ipc.squashCommits).mockResolvedValue(undefined);
      render(<SquashDialog {...defaultProps} />);

      await screen.findByDisplayValue("only subject");
      fireEvent.click(screen.getByRole("button", { name: "Squash" }));

      expect(ipc.squashCommits).toHaveBeenCalledWith("repo1", oids, "only subject");
      await waitFor(() => expect(mockOnSuccess).toHaveBeenCalled());
    });

    it("shows preview error and disables Squash when preview fails", async () => {
      vi.mocked(ipc.getSquashPreview).mockRejectedValue(new Error("Cannot squash across a merge commit."));
      render(<SquashDialog {...defaultProps} />);

      await waitFor(() =>
        expect(screen.getByText("Error: Cannot squash across a merge commit.")).toBeInTheDocument()
      );
      expect(screen.getByRole("button", { name: "Squash" })).toBeDisabled();
      expect(ipc.squashCommits).not.toHaveBeenCalled();
    });

    it("shows error when ipc.squashCommits throws", async () => {
      vi.mocked(ipc.getSquashPreview).mockResolvedValue({ count: 2, default_subject: "subj", default_body: "" });
      vi.mocked(ipc.squashCommits).mockRejectedValue(new Error("HEAD is detached"));
      render(<SquashDialog {...defaultProps} />);

      await screen.findByDisplayValue("subj");
      fireEvent.click(screen.getByRole("button", { name: "Squash" }));

      await waitFor(() => expect(screen.getByText("Error: HEAD is detached")).toBeInTheDocument());
      expect(mockOnSuccess).not.toHaveBeenCalled();
    });

    it("disables Squash when the subject is empty", async () => {
      vi.mocked(ipc.getSquashPreview).mockResolvedValue({ count: 2, default_subject: "subj", default_body: "" });
      render(<SquashDialog {...defaultProps} />);

      const box = await screen.findByDisplayValue("subj");
      fireEvent.change(box, { target: { value: "   " } });
      expect(screen.getByRole("button", { name: "Squash" })).toBeDisabled();
    });

    it("calls onClose when Cancel is clicked without squashing", async () => {
      vi.mocked(ipc.getSquashPreview).mockResolvedValue({ count: 2, default_subject: "subj", default_body: "" });
      render(<SquashDialog {...defaultProps} />);

      await screen.findByDisplayValue("subj");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(mockOnClose).toHaveBeenCalled();
      expect(ipc.squashCommits).not.toHaveBeenCalled();
    });
  });

  describe("PullConflictsDialog", () => {
    it("calls onClose when Resolve conflicts is clicked", () => {
      render(
        <PullConflictsDialog
          repoId="repo1"
          onClose={mockOnClose}
          onAbort={mockOnAbort}
        />
      );

      expect(screen.getByRole("heading", { name: "Merge conflicts" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Resolve conflicts" }));
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("calls ipc.abortMerge then onAbort when Abort merge is clicked", async () => {
      vi.mocked(ipc.abortMerge).mockResolvedValue(undefined);

      render(
        <PullConflictsDialog
          repoId="repo1"
          onClose={mockOnClose}
          onAbort={mockOnAbort}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Abort merge" }));
      expect(ipc.abortMerge).toHaveBeenCalledWith("repo1");

      await waitFor(() => {
        expect(mockOnAbort).toHaveBeenCalled();
      });
    });
  });

  describe("PushRejectedDialog", () => {
    it("renders rejection message and calls ipc.pushBranch with force on confirm", async () => {
      vi.mocked(ipc.pushBranch).mockResolvedValue(undefined);

      render(
        <PushRejectedDialog
          repoId="repo1"
          remoteName="origin"
          branchName="main"
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />
      );

      expect(screen.getByRole("heading", { name: "Push rejected" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Force push" }));
      expect(ipc.pushBranch).toHaveBeenCalledWith("repo1", "origin", "main", true);

      await waitFor(() => {
        expect(mockOnSuccess).toHaveBeenCalled();
      });
    });

    it("calls onClose when Cancel is clicked", () => {
      render(
        <PushRejectedDialog
          repoId="repo1"
          remoteName="origin"
          branchName="main"
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  describe("CheckInBranchDialog", () => {
    const REFS: RefInfo[] = [
      { name: "refs/heads/main", shorthand: "main", kind: "local_branch", target_oid: "aaa111", is_head: true, is_pushed: true },
      { name: "refs/heads/feature", shorthand: "feature", kind: "local_branch", target_oid: "bbb222", is_head: false, is_pushed: false },
      { name: "refs/remotes/origin/main", shorthand: "origin/main", kind: "remote_branch", target_oid: "aaa111", is_head: false, is_pushed: false },
      { name: "refs/remotes/origin/HEAD", shorthand: "origin/HEAD", kind: "remote_branch", target_oid: "aaa111", is_head: false, is_pushed: false },
    ];

    const defaultProps = {
      repoId: "repo1",
      oid: "c123456789",
      summary: "fix login bug",
      onClose: mockOnClose,
    };

    beforeEach(() => {
      vi.mocked(useRefs).mockReturnValue({ data: REFS } as any);
    });

    it("renders the short hash and summary", () => {
      vi.mocked(useCommitInRef).mockReturnValue({ data: true, isLoading: false, error: null } as any);
      render(<CheckInBranchDialog {...defaultProps} currentBranch="main" />);

      expect(screen.getByRole("heading", { name: "Check if in branch" })).toBeInTheDocument();
      // The hash also appears in the result line below, so scope to the description.
      const description = document.querySelector('[data-slot="dialog-description"]');
      expect(description).toHaveTextContent("c1234567");
      expect(description).toHaveTextContent("fix login bug");
    });

    it("defaults to the current branch when it exists locally, and queries with its tip oid", () => {
      vi.mocked(useCommitInRef).mockReturnValue({ data: true, isLoading: false, error: null } as any);
      render(<CheckInBranchDialog {...defaultProps} currentBranch="feature" />);

      expect(useCommitInRef).toHaveBeenCalledWith("repo1", "c123456789", "feature", "bbb222");
    });

    it("defaults to the first local branch when there is no current branch", () => {
      vi.mocked(useCommitInRef).mockReturnValue({ data: true, isLoading: false, error: null } as any);
      render(<CheckInBranchDialog {...defaultProps} currentBranch={null} />);

      expect(useCommitInRef).toHaveBeenCalledWith("repo1", "c123456789", "main", "aaa111");
    });

    it("shows a muted 'Checking…' state while the query is loading", () => {
      vi.mocked(useCommitInRef).mockReturnValue({ data: undefined, isLoading: true, error: null } as any);
      render(<CheckInBranchDialog {...defaultProps} currentBranch="main" />);

      expect(screen.getByText("Checking…")).toBeInTheDocument();
    });

    it("shows the in-branch result", () => {
      vi.mocked(useCommitInRef).mockReturnValue({ data: true, isLoading: false, error: null } as any);
      render(<CheckInBranchDialog {...defaultProps} currentBranch="main" />);

      expect(screen.getByText(/is in/)).toBeInTheDocument();
    });

    it("shows the not-in-branch result", () => {
      vi.mocked(useCommitInRef).mockReturnValue({ data: false, isLoading: false, error: null } as any);
      render(<CheckInBranchDialog {...defaultProps} currentBranch="main" />);

      expect(screen.getByText(/is not in/)).toBeInTheDocument();
    });

    it("shows an error note when the query fails", () => {
      vi.mocked(useCommitInRef).mockReturnValue({ data: undefined, isLoading: false, error: new Error("boom") } as any);
      render(<CheckInBranchDialog {...defaultProps} currentBranch="main" />);

      expect(screen.getByText("Error: boom")).toBeInTheDocument();
    });

    it("calls onClose when Close is clicked", () => {
      vi.mocked(useCommitInRef).mockReturnValue({ data: true, isLoading: false, error: null } as any);
      render(<CheckInBranchDialog {...defaultProps} currentBranch="main" />);

      // The dialog also has a built-in "X" close button with the same "Close"
      // accessible (sr-only) name — pick the visible footer button specifically.
      const footerClose = screen
        .getAllByRole("button", { name: "Close" })
        .find((b) => b.getAttribute("data-slot") !== "dialog-close")!;
      fireEvent.click(footerClose);
      expect(mockOnClose).toHaveBeenCalled();
    });

    // Base UI's Select renders its options through a portal that only opens on a
    // real pointer interaction, which is unreliable to drive in jsdom. Instead of
    // asserting on the opened popup, we verify branch ordering/grouping indirectly:
    // the default-selection tests above already prove locals are queried and
    // preferred over remotes (feature/main are local_branch entries picked ahead
    // of the remote-tracking origin/main), and this test confirms origin/HEAD
    // (the only remote entry excluded from selection) never becomes the default
    // even when it is first among remotes in the refs list.
    it("never defaults to a remote-tracking */HEAD entry", () => {
      vi.mocked(useRefs).mockReturnValue({
        data: [
          { name: "refs/remotes/origin/HEAD", shorthand: "origin/HEAD", kind: "remote_branch", target_oid: "aaa111", is_head: false, is_pushed: false },
          { name: "refs/heads/main", shorthand: "main", kind: "local_branch", target_oid: "aaa111", is_head: true, is_pushed: true },
        ],
      } as any);
      vi.mocked(useCommitInRef).mockReturnValue({ data: true, isLoading: false, error: null } as any);
      render(<CheckInBranchDialog {...defaultProps} currentBranch={null} />);

      expect(useCommitInRef).toHaveBeenCalledWith("repo1", "c123456789", "main", "aaa111");
    });
  });
});
