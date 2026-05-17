import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PullConflictsDialog, PushRejectedDialog } from "./Dialogs";
import { ipc } from "@/lib/ipc";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    abortMerge: vi.fn(),
    pushBranch: vi.fn(),
  },
}));

describe("Dialogs", () => {
  const mockOnClose = vi.fn();
  const mockOnSuccess = vi.fn();
  const mockOnAbort = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
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
