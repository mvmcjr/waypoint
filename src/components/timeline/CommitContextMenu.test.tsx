import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommitContextMenu } from "./CommitContextMenu";
import type { PositionedCommit } from "@/lib/ipc";

vi.mock("@/lib/plugins/registry", () => ({
  usePluginRegistry: (selector?: (s: { plugins: unknown[] }) => unknown) =>
    selector ? selector({ plugins: [] }) : { plugins: [] },
  commandsForSurface: () => [],
}));

vi.mock("@/components/plugins/PluginRunnerProvider", () => ({
  usePluginRunner: () => ({ run: vi.fn() }),
}));

function commit(overrides: Partial<PositionedCommit["commit"]> = {}): PositionedCommit {
  return {
    lane: 0,
    row: 0,
    color_idx: 0,
    edges: [],
    commit: {
      oid: "deadbeef00112233",
      parent_oids: [],
      summary: "a commit",
      body: "",
      author_name: "Ada",
      author_email: "ada@example.com",
      timestamp: 1_700_000_000,
      refs: [],
      local_branches: [],
      remote_branches: [],
      ...overrides,
    },
  };
}

describe("CommitContextMenu — worktree-held branches", () => {
  it("a held branch shows 'Open worktree <name>' and no 'Checkout <branch>'", () => {
    const onAction = vi.fn();
    const onRefAction = vi.fn();
    const worktreeByBranch = new Map([["feat", "E:\\repo-agent"]]);
    render(
      <CommitContextMenu
        item={commit({ local_branches: ["feat"], refs: ["feat"] })}
        onAction={onAction}
        onRefAction={onRefAction}
        worktreeByBranch={worktreeByBranch}
      >
        <div>row</div>
      </CommitContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("row"));

    expect(screen.getByRole("menuitem", { name: /Open worktree.*repo-agent/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Checkout feat/ })).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: /Open worktree/ }));
    expect(onRefAction).toHaveBeenCalledWith({ kind: "open-worktree", path: "E:\\repo-agent" });
    expect(onAction).not.toHaveBeenCalled();
  });

  it("a normal (not-held) branch is unchanged: Checkout still offered", () => {
    const onAction = vi.fn();
    render(
      <CommitContextMenu
        item={commit({ local_branches: ["feat"], refs: ["feat"] })}
        onAction={onAction}
      >
        <div>row</div>
      </CommitContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("row"));

    expect(screen.queryByRole("menuitem", { name: /Open worktree/ })).toBeNull();
    const checkoutItem = screen.getByRole("menuitem", { name: /Checkout/ });
    fireEvent.click(checkoutItem);
    expect(onAction).toHaveBeenCalledWith({ kind: "checkout-branch", branchName: "feat" });
  });
});
