import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RefTree } from "./RefTree";
import type { RefInfo } from "@/lib/ipc";

vi.mock("@/lib/plugins/registry", () => ({
  usePluginRegistry: (selector?: (s: { plugins: unknown[] }) => unknown) =>
    selector ? selector({ plugins: [] }) : { plugins: [] },
  commandsForSurface: () => [],
}));

vi.mock("@/components/plugins/PluginRunnerProvider", () => ({
  usePluginRunner: () => ({ run: vi.fn() }),
}));

function localBranch(overrides: Partial<RefInfo> = {}): RefInfo {
  return {
    name: "refs/heads/feature",
    shorthand: "feature",
    kind: "local_branch",
    target_oid: "abc123",
    is_head: false,
    is_pushed: false,
    worktree_path: null,
    ...overrides,
  };
}

const HELD: RefInfo = localBranch({
  name: "refs/heads/main",
  shorthand: "main",
  worktree_path: "E:\\repo-agent",
});

const NORMAL: RefInfo = localBranch({
  name: "refs/heads/feature",
  shorthand: "feature",
  worktree_path: null,
});

// Backend quirk: `is_head` is also set when a branch's tip commit equals
// HEAD's commit (e.g. right after `git worktree add ../x -b feat`), not only
// for the tab's actual current branch. A branch with worktree_path can never
// really be this tab's current branch, so `held` must win over `is_head`.
const HELD_AT_HEAD_COMMIT: RefInfo = localBranch({
  name: "refs/heads/feat-at-head",
  shorthand: "feat-at-head",
  is_head: true,
  worktree_path: "E:\\x",
});

const REMOTE: RefInfo = {
  name: "refs/remotes/origin/main",
  shorthand: "origin/main",
  kind: "remote_branch",
  target_oid: "def456",
  is_head: false,
  is_pushed: false,
  worktree_path: null,
};

function renderTree(refs: RefInfo[], overrides: { onRefAction?: (a: unknown) => void } = {}) {
  const onRefAction = overrides.onRefAction ?? vi.fn();
  render(<RefTree refs={refs} onRefAction={onRefAction as any} />);
  return { onRefAction };
}

describe("RefTree — worktree awareness", () => {
  it("renders a worktree indicator only for the local branch checked out in another worktree", () => {
    const refs: RefInfo[] = [HELD, NORMAL];
    renderTree(refs);

    const indicators = screen.getAllByTestId("worktree-indicator");
    expect(indicators).toHaveLength(1);
  });

  it("does not render an indicator for a normal branch", () => {
    renderTree([NORMAL]);
    expect(screen.queryByTestId("worktree-indicator")).not.toBeInTheDocument();
  });

  it("held branch row shows the worktree name chip and an accessible description", () => {
    renderTree([HELD]);
    expect(screen.getByTestId("worktree-indicator")).toHaveTextContent("repo-agent");
    expect(screen.getByText(/checked out in worktree repo-agent/)).toHaveClass("sr-only");
  });

  it("held branch menu names the worktree and has no Delete or disabled reason", () => {
    renderTree([HELD]);
    fireEvent.contextMenu(screen.getByText(HELD.shorthand));
    const item = screen.getByRole("menuitem", { name: /Open worktree/ });
    expect(item).toHaveTextContent("repo-agent");
    expect(screen.queryByText(/Checked out elsewhere/)).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /^Delete/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Merge into current/ })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("clicking Open worktree in the sidebar menu dispatches open-worktree", () => {
    const { onRefAction } = renderTree([HELD]);
    fireEvent.contextMenu(screen.getByText(HELD.shorthand));
    fireEvent.click(screen.getByRole("menuitem", { name: /Open worktree/ }));
    expect(onRefAction).toHaveBeenCalledWith({ kind: "open-worktree", path: "E:\\repo-agent" });
  });

  it("keeps Checkout and Delete enabled for a normal (not-held) branch", () => {
    const { onRefAction } = renderTree([NORMAL]);

    fireEvent.contextMenu(screen.getByText(NORMAL.shorthand));

    expect(screen.queryByTestId("worktree-indicator")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Open worktree/ })).toBeNull();

    const checkoutItem = screen.getByText(`Checkout ${NORMAL.shorthand}`).closest('[role="menuitem"]')!;
    expect(checkoutItem).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(checkoutItem);
    expect(onRefAction).toHaveBeenCalledWith({ kind: "checkout-branch", branchName: NORMAL.shorthand });

    // The menu closes on item click — reopen it to check the Delete item.
    fireEvent.contextMenu(screen.getByText(NORMAL.shorthand));
    const deleteItem = screen.getByText(`Delete ${NORMAL.shorthand}`).closest('[role="menuitem"]')!;
    expect(deleteItem).not.toHaveAttribute("aria-disabled", "true");
  });

  it("keeps Rename and Merge enabled for a held branch", () => {
    const { onRefAction } = renderTree([HELD]);

    fireEvent.contextMenu(screen.getByText(HELD.shorthand));
    const renameItem = screen.getByText("Rename…").closest('[role="menuitem"]')!;
    expect(renameItem).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(renameItem);
    expect(onRefAction).toHaveBeenCalledWith({ kind: "rename-branch", branchName: HELD.shorthand });

    fireEvent.contextMenu(screen.getByText(HELD.shorthand));
    const mergeItem = screen.getByText("Merge into current").closest('[role="menuitem"]')!;
    expect(mergeItem).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(mergeItem);
    expect(onRefAction).toHaveBeenCalledWith({ kind: "merge", oid: HELD.target_oid, label: HELD.shorthand });
  });

  it("remote checkout is replaced by Open worktree when the local branch is held", () => {
    renderTree([HELD, { ...REMOTE, shorthand: `origin/${HELD.shorthand}` }]);
    fireEvent.contextMenu(screen.getByText(`origin/${HELD.shorthand}`));
    expect(screen.getByRole("menuitem", { name: /Open worktree/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Checkout origin/ })).toBeNull();
  });

  it("keeps the normal Checkout item for a remote whose local counterpart is not held", () => {
    const { onRefAction } = renderTree([NORMAL, { ...REMOTE, shorthand: `origin/${NORMAL.shorthand}` }]);
    fireEvent.contextMenu(screen.getByText(`origin/${NORMAL.shorthand}`));
    const checkoutItem = screen.getByText(`Checkout origin/${NORMAL.shorthand}`).closest('[role="menuitem"]')!;
    fireEvent.click(checkoutItem);
    expect(onRefAction).toHaveBeenCalledWith({ kind: "checkout-remote-branch", remoteBranch: `origin/${NORMAL.shorthand}` });
  });

  it("double-click: normal branch → checkout dialog; held branch → open worktree", () => {
    const onRefAction = vi.fn();
    renderTree([HELD, NORMAL], { onRefAction });
    fireEvent.doubleClick(screen.getByText(NORMAL.shorthand));
    expect(onRefAction).toHaveBeenCalledWith({ kind: "checkout-branch", branchName: NORMAL.shorthand });
    fireEvent.doubleClick(screen.getByText(HELD.shorthand));
    expect(onRefAction).toHaveBeenCalledWith({ kind: "open-worktree", path: "E:\\repo-agent" });
  });

  it("double-click on a remote row checks out the remote branch, or opens the worktree when its local counterpart is held", () => {
    const onRefAction = vi.fn();
    const heldUpstream = { ...REMOTE, shorthand: `origin/${HELD.shorthand}` };
    const normalRemote = { ...REMOTE, name: "refs/remotes/origin/other", shorthand: "origin/other" };
    renderTree([HELD, heldUpstream, normalRemote], { onRefAction });

    fireEvent.doubleClick(screen.getByText("origin/other"));
    expect(onRefAction).toHaveBeenCalledWith({ kind: "checkout-remote-branch", remoteBranch: "origin/other" });

    fireEvent.doubleClick(screen.getByText(`origin/${HELD.shorthand}`));
    expect(onRefAction).toHaveBeenCalledWith({ kind: "open-worktree", path: "E:\\repo-agent" });
  });

  it("a held branch whose tip matches HEAD's commit is not treated as the current branch", () => {
    const onRefAction = vi.fn();
    renderTree([HELD_AT_HEAD_COMMIT], { onRefAction });

    fireEvent.contextMenu(screen.getByText(HELD_AT_HEAD_COMMIT.shorthand));
    expect(screen.getByRole("menuitem", { name: /Open worktree/ })).toBeInTheDocument();
    expect(screen.queryByText("Current branch")).toBeNull();

    fireEvent.doubleClick(screen.getByText(HELD_AT_HEAD_COMMIT.shorthand));
    expect(onRefAction).toHaveBeenCalledWith({ kind: "open-worktree", path: "E:\\x" });
  });

  it("HEAD rows and Tags do not respond to double-click", () => {
    const onRefAction = vi.fn();
    const head = localBranch({ name: "refs/heads/dev", shorthand: "dev", is_head: true });
    const tag: RefInfo = {
      name: "refs/tags/v1",
      shorthand: "v1",
      kind: "tag",
      target_oid: "abc",
      is_head: false,
      is_pushed: false,
      worktree_path: null,
    };
    renderTree([head, tag], { onRefAction });

    fireEvent.doubleClick(screen.getByText("dev"));
    fireEvent.doubleClick(screen.getByText("v1"));

    expect(onRefAction).not.toHaveBeenCalled();
  });
});
