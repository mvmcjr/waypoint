import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PullDialog, PushDialog } from "./Dialogs";
import { ipc } from "@/lib/ipc";

// Mock the ipc module
vi.mock("@/lib/ipc", () => ({
  ipc: {
    pullBranch: vi.fn(),
    pushBranch: vi.fn(),
  },
}));

describe("Dialogs", () => {
  const mockOnClose = vi.fn();
  const mockOnSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("PullDialog", () => {
    it("renders and calls ipc.pullBranch on pull", async () => {
      const remotes = [{ name: "origin", url: "https://github.com/test/test.git" }];
      vi.mocked(ipc.pullBranch).mockResolvedValue({ kind: "merged", conflicted: [] });

      render(
        <PullDialog
          repoId="repo1"
          remotes={remotes}
          currentBranch="main"
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />
      );

      expect(screen.getByRole("heading", { name: "Pull" })).toBeInTheDocument();
      expect(screen.getByText("origin")).toBeInTheDocument();

      const pullButton = screen.getByRole("button", { name: "Pull" });
      fireEvent.click(pullButton);

      expect(ipc.pullBranch).toHaveBeenCalledWith("repo1", "origin");
      
      await waitFor(() => {
        expect(mockOnSuccess).toHaveBeenCalledWith({ kind: "merged", conflicted: [] });
      });
    });
  });

  describe("PushDialog", () => {
    it("renders and calls ipc.pushBranch on push", async () => {
      const remotes = [{ name: "origin", url: "https://github.com/test/test.git" }];
      vi.mocked(ipc.pushBranch).mockResolvedValue(undefined);

      render(
        <PushDialog
          repoId="repo1"
          remotes={remotes}
          currentBranch="main"
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />
      );

      expect(screen.getByRole("heading", { name: "Push" })).toBeInTheDocument();

      const pushButton = screen.getByRole("button", { name: "Push" });
      fireEvent.click(pushButton);

      expect(ipc.pushBranch).toHaveBeenCalledWith("repo1", "origin", "main", false);
      
      await waitFor(() => {
        expect(mockOnSuccess).toHaveBeenCalled();
      });
    });

    it("handles force push", async () => {
      const remotes = [{ name: "origin", url: "https://github.com/test/test.git" }];
      vi.mocked(ipc.pushBranch).mockResolvedValue(undefined);

      render(
        <PushDialog
          repoId="repo1"
          remotes={remotes}
          currentBranch="main"
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />
      );

      const forceCheckbox = screen.getByRole("checkbox");
      fireEvent.click(forceCheckbox);

      expect(screen.getByText(/Force push will overwrite/i)).toBeInTheDocument();

      const forcePushButton = screen.getByRole("button", { name: "Force Push" });
      fireEvent.click(forcePushButton);

      expect(ipc.pushBranch).toHaveBeenCalledWith("repo1", "origin", "main", true);
    });
  });
});
