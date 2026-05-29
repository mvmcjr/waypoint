import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { CherryPickDialog, PullConflictsDialog, PushRejectedDialog } from "./Dialogs";
import { ipc } from "@/lib/ipc";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    abortMerge: vi.fn(),
    pushBranch: vi.fn(),
    cherryPick: vi.fn(),
  },
}));

describe("Dialogs", () => {
  const mockOnClose = vi.fn();
  const mockOnSuccess = vi.fn();
  const mockOnAbort = vi.fn();
  const mockOnConflicts = vi.fn();

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
    };

    it("renders commit summary and short oid", () => {
      vi.mocked(ipc.cherryPick).mockResolvedValue({ kind: "applied", conflicted: [] });
      render(<CherryPickDialog {...defaultProps} />);

      expect(screen.getByRole("heading", { name: "Cherry-pick commit" })).toBeInTheDocument();
      expect(screen.getByText(/"feat: add new thing"/)).toBeInTheDocument();
      expect(screen.getByText("abc123de")).toBeInTheDocument();
    });

    it("calls onSuccess when cherry-pick applies cleanly", async () => {
      vi.mocked(ipc.cherryPick).mockResolvedValue({ kind: "applied", conflicted: [] });
      render(<CherryPickDialog {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Cherry-pick" }));
      expect(ipc.cherryPick).toHaveBeenCalledWith("repo1", "abc123def456");

      await waitFor(() => expect(mockOnSuccess).toHaveBeenCalled());
      expect(mockOnConflicts).not.toHaveBeenCalled();
    });

    it("calls onConflicts when cherry-pick produces conflicts", async () => {
      vi.mocked(ipc.cherryPick).mockResolvedValue({ kind: "conflicts", conflicted: ["src/lib.rs"] });
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
      let resolve!: (r: { kind: string; conflicted: string[] }) => void;
      vi.mocked(ipc.cherryPick).mockReturnValue(new Promise((res) => { resolve = res; }) as any);

      render(<CherryPickDialog {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: "Cherry-pick" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Applying…" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      });

      act(() => resolve({ kind: "applied", conflicted: [] }));
    });

    it("calls onClose when Cancel is clicked", () => {
      vi.mocked(ipc.cherryPick).mockResolvedValue({ kind: "applied", conflicted: [] });
      render(<CherryPickDialog {...defaultProps} />);

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(mockOnClose).toHaveBeenCalled();
      expect(ipc.cherryPick).not.toHaveBeenCalled();
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
});
