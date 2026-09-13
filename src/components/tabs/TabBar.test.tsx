import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { TabBar } from "./TabBar";
import { useStore } from "@/lib/store";
import { useOpenRepo } from "@/lib/useOpenRepo";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@/lib/useOpenRepo", () => ({
  useOpenRepo: vi.fn(),
}));

describe("TabBar", () => {
  beforeEach(() => {
    vi.mocked(useOpenRepo).mockReturnValue(vi.fn());
  });

  it("marks linked-worktree tabs and exposes the full path", () => {
    useStore.setState({
      tabs: [{ id: "E:\\repo-agent", path: "E:\\repo-agent", label: "repo-agent", mainPath: "E:\\repo" }],
      activeTabId: "E:\\repo-agent",
    } as any);
    render(<TabBar />);
    const tab = screen.getByRole("tab", { name: /repo-agent, worktree of repo/ });
    expect(tab).toHaveAttribute("title", "E:\\repo-agent");
  });

  it("does not add a worktree aria-label for a tab with no mainPath", () => {
    useStore.setState({
      tabs: [{ id: "E:\\repo", path: "E:\\repo", label: "repo", mainPath: null }],
      activeTabId: "E:\\repo",
    } as any);
    render(<TabBar />);
    const tab = screen.getByRole("tab");
    expect(tab).not.toHaveAttribute("aria-label");
    expect(tab).toHaveAttribute("title", "E:\\repo");
  });

  it("disambiguates colliding tab labels in the rendered text", () => {
    useStore.setState({
      tabs: [
        { id: "E:\\a\\.worktrees\\fix", path: "E:\\a\\.worktrees\\fix", label: "fix", mainPath: "E:\\alugar" },
        { id: "E:\\w\\.worktrees\\fix", path: "E:\\w\\.worktrees\\fix", label: "fix", mainPath: "E:\\waypoint" },
      ],
      activeTabId: "E:\\a\\.worktrees\\fix",
    } as any);
    render(<TabBar />);
    expect(screen.getByText("fix · alugar")).toBeInTheDocument();
    expect(screen.getByText("fix · waypoint")).toBeInTheDocument();
  });
});
