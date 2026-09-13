import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RefBadge } from "./RefBadge";

vi.mock("@/lib/plugins/registry", () => ({
  usePluginRegistry: (selector?: (s: { plugins: unknown[] }) => unknown) =>
    selector ? selector({ plugins: [] }) : { plugins: [] },
  commandsForSurface: () => [],
}));

vi.mock("@/components/plugins/PluginRunnerProvider", () => ({
  usePluginRunner: () => ({ run: vi.fn() }),
}));

function renderBadge(overrides: Partial<React.ComponentProps<typeof RefBadge>> = {}) {
  const onAction = overrides.onAction ?? vi.fn();
  const onCommitAction = overrides.onCommitAction ?? vi.fn();
  const { rerender } = render(
    <RefBadge
      name="main"
      hasLocal
      hasRemote={false}
      isHead={false}
      isTag={false}
      oid="deadbeef00112233"
      onAction={onAction}
      onCommitAction={onCommitAction}
      commitSummary="a commit"
      {...overrides}
    />,
  );
  return { onAction, onCommitAction, rerender };
}

function rerenderBadge(rerender: (ui: React.ReactElement) => void, overrides: Partial<React.ComponentProps<typeof RefBadge>> = {}) {
  const onAction = overrides.onAction ?? vi.fn();
  const onCommitAction = overrides.onCommitAction ?? vi.fn();
  rerender(
    <RefBadge
      name="main"
      hasLocal
      hasRemote={false}
      isHead={false}
      isTag={false}
      oid="deadbeef00112233"
      onAction={onAction}
      onCommitAction={onCommitAction}
      commitSummary="a commit"
      {...overrides}
    />,
  );
}

describe("RefBadge — worktree awareness", () => {
  it("shows a worktree glyph at opacity-60 only when worktreePath is set", () => {
    const { container: withPath } = render(
      <RefBadge name="main" hasLocal hasRemote={false} isHead={false} isTag={false} worktreePath={"E:\\repo-agent"} />,
    );
    expect(withPath.querySelector(".opacity-60")).toBeInTheDocument();

    const { container: withoutPath } = render(
      <RefBadge name="main" hasLocal hasRemote={false} isHead={false} isTag={false} worktreePath={null} />,
    );
    expect(withoutPath.querySelector(".opacity-60")).not.toBeInTheDocument();
  });

  it("badge menu puts Open worktree first and hides Delete for held branches", () => {
    const { onAction } = renderBadge({ worktreePath: "E:\\repo-agent" });
    fireEvent.contextMenu(screen.getByTitle("main"));

    const items = screen.getAllByRole("menuitem");
    expect(items[0]).toHaveTextContent(/Open worktree.*repo-agent/);
    expect(screen.queryByRole("menuitem", { name: /^Delete/ })).toBeNull();
    expect(screen.queryByText(/Checked out elsewhere/)).toBeNull();
    expect(screen.queryByText("Checkout")).not.toBeInTheDocument();

    fireEvent.click(items[0]);
    expect(onAction).toHaveBeenCalledWith({ kind: "open-worktree", path: "E:\\repo-agent" });
  });

  it("keeps Merge into current branch enabled when the badge's branch is held", () => {
    const { onCommitAction } = renderBadge({ worktreePath: "E:\\repo-agent" });
    fireEvent.contextMenu(screen.getByTitle("main"));
    const mergeItem = screen.getByText("Merge into current branch").closest('[role="menuitem"]')!;
    expect(mergeItem).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(mergeItem);
    expect(onCommitAction).toHaveBeenCalledWith({ kind: "merge", oid: "deadbeef00112233", label: "main" });
  });

  it("keeps Checkout and Delete for a normal (not held) branch", () => {
    const { onCommitAction, onAction } = renderBadge({ worktreePath: null });
    fireEvent.contextMenu(screen.getByTitle("main"));

    expect(screen.queryByRole("menuitem", { name: /Open worktree/ })).toBeNull();

    const checkoutItem = screen.getByText("Checkout").closest('[role="menuitem"]')!;
    expect(checkoutItem).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(checkoutItem);
    expect(onCommitAction).toHaveBeenCalledWith({ kind: "checkout-branch", branchName: "main" });

    fireEvent.contextMenu(screen.getByTitle("main"));
    const deleteItem = screen.getByText("Delete main").closest('[role="menuitem"]')!;
    expect(deleteItem).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(deleteItem);
    expect(onAction).toHaveBeenCalledWith({ kind: "delete-branch", branchName: "main" });
  });

  it("badge double-click checks out a normal branch and opens a held one", () => {
    const onAction = vi.fn();
    const onCommitAction = vi.fn();
    const { rerender } = renderBadge({ name: "feat", hasLocal: true, onAction, onCommitAction, oid: "abc" });
    fireEvent.doubleClick(screen.getByTitle("feat"));
    expect(onCommitAction).toHaveBeenCalledWith({ kind: "checkout-branch", branchName: "feat" });

    rerenderBadge(rerender, { name: "feat", hasLocal: true, worktreePath: "E:\\repo-agent", onAction, onCommitAction, oid: "abc" });
    fireEvent.doubleClick(screen.getByTitle("feat"));
    expect(onAction).toHaveBeenCalledWith({ kind: "open-worktree", path: "E:\\repo-agent" });
  });

  it("shows Open worktree (not Checkout) on a remote-only badge whose local counterpart is held", () => {
    const onAction = vi.fn();
    const onCommitAction = vi.fn();
    render(
      <RefBadge
        name="feat"
        trackingName="origin/feat"
        hasLocal={false}
        hasRemote
        isHead={false}
        isTag={false}
        oid="abc"
        worktreePath={"E:\\repo-agent"}
        onAction={onAction}
        onCommitAction={onCommitAction}
      />,
    );
    fireEvent.contextMenu(screen.getByTitle("feat"));
    expect(screen.getByRole("menuitem", { name: /Open worktree.*repo-agent/ })).toBeInTheDocument();
    expect(screen.queryByText("Checkout")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: /Open worktree/ }));
    expect(onAction).toHaveBeenCalledWith({ kind: "open-worktree", path: "E:\\repo-agent" });
  });

  it("a badge with both isHead and worktreePath is treated as held, not as HEAD", () => {
    // Mirrors the backend/RefTree quirk where a branch's tip commit equals
    // HEAD's commit right after `git worktree add ../x -b feat` — `isHead`
    // can be true even though the branch is actually held elsewhere. A badge
    // that's held can never really be this tab's HEAD.
    const onAction = vi.fn();
    const onCommitAction = vi.fn();
    const { container } = render(
      <RefBadge
        name="feat"
        hasLocal
        hasRemote={false}
        isHead
        isTag={false}
        oid="abc"
        worktreePath={"E:\\repo-agent"}
        onAction={onAction}
        onCommitAction={onCommitAction}
      />,
    );

    // Not rendered with the teal HEAD badge styling.
    expect(container.querySelector(".bg-teal-500\\/20")).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByTitle("feat"));
    expect(screen.getByRole("menuitem", { name: /Open worktree.*repo-agent/ })).toBeInTheDocument();
    // Reset is normally hidden on a HEAD badge — it must be offered here since
    // this isn't really HEAD.
    expect(screen.getByRole("menuitem", { name: /Reset HEAD here/ })).toBeInTheDocument();

    fireEvent.doubleClick(screen.getByTitle("feat"));
    expect(onAction).toHaveBeenCalledWith({ kind: "open-worktree", path: "E:\\repo-agent" });
  });

  it("badge double-click on a remote-only badge checks out the remote branch", () => {
    const onAction = vi.fn();
    const onCommitAction = vi.fn();
    render(
      <RefBadge
        name="feat"
        trackingName="origin/feat"
        hasLocal={false}
        hasRemote
        isHead={false}
        isTag={false}
        oid="abc"
        onAction={onAction}
        onCommitAction={onCommitAction}
      />,
    );
    fireEvent.doubleClick(screen.getByTitle("feat"));
    expect(onCommitAction).toHaveBeenCalledWith({ kind: "checkout-remote-branch", remoteBranch: "origin/feat" });
  });

  it("badge double-click on a HEAD or tag badge does nothing", () => {
    const onAction = vi.fn();
    const onCommitAction = vi.fn();
    const { rerender } = render(
      <RefBadge name="main" hasLocal hasRemote={false} isHead isTag={false} oid="abc" onAction={onAction} onCommitAction={onCommitAction} />,
    );
    fireEvent.doubleClick(screen.getByTitle("main"));
    expect(onAction).not.toHaveBeenCalled();
    expect(onCommitAction).not.toHaveBeenCalled();

    rerender(
      <RefBadge name="v1" hasLocal hasRemote={false} isHead={false} isTag oid="abc" onAction={onAction} onCommitAction={onCommitAction} />,
    );
    fireEvent.doubleClick(screen.getByTitle("v1"));
    expect(onAction).not.toHaveBeenCalled();
    expect(onCommitAction).not.toHaveBeenCalled();
  });

  it("truncation budget reserves room for the worktree glyph", () => {
    const long = "feature/very-long-branch-name-ABC-1234";
    const { rerender } = renderBadge({ name: long, hasLocal: true, maxWidth: 124 });
    const plain = screen.getByTitle(long).textContent!;

    rerenderBadge(rerender, { name: long, hasLocal: true, maxWidth: 124, worktreePath: "E:\\wt" });
    const held = screen.getByTitle(long).textContent!;

    expect(held.replace(/, checked out in worktree wt$/, "").length).toBeLessThan(plain.length);
  });

  it("includes an sr-only accessible description for held branches", () => {
    renderBadge({ worktreePath: "E:\\repo-agent" });
    expect(screen.getByText(/checked out in worktree repo-agent/)).toHaveClass("sr-only");
  });

  // These guard the global rule that commit-level actions and Push/Rename
  // stay enabled on a held branch's badge — only Checkout/Delete are
  // replaced/hidden. Cleanup for a held branch goes through Remove worktree.
  it("keeps Rebase enabled when checked out elsewhere", () => {
    const { onCommitAction } = renderBadge({ worktreePath: "E:\\repo-agent" });
    fireEvent.contextMenu(screen.getByTitle("main"));
    const rebaseItem = screen.getByText("Rebase current branch here").closest('[role="menuitem"]')!;
    expect(rebaseItem).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(rebaseItem);
    expect(onCommitAction).toHaveBeenCalledWith({ kind: "rebase", oid: "deadbeef00112233" });
  });

  it("keeps New branch here enabled when checked out elsewhere", () => {
    const { onCommitAction } = renderBadge({ worktreePath: "E:\\repo-agent" });
    fireEvent.contextMenu(screen.getByTitle("main"));
    const item = screen.getByText("New branch here…").closest('[role="menuitem"]')!;
    expect(item).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    expect(onCommitAction).toHaveBeenCalledWith({ kind: "create-branch", oid: "deadbeef00112233" });
  });

  it("keeps New tag here enabled when checked out elsewhere", () => {
    const { onCommitAction } = renderBadge({ worktreePath: "E:\\repo-agent" });
    fireEvent.contextMenu(screen.getByTitle("main"));
    const item = screen.getByText("New tag here…").closest('[role="menuitem"]')!;
    expect(item).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    expect(onCommitAction).toHaveBeenCalledWith({ kind: "create-tag", oid: "deadbeef00112233" });
  });

  it("keeps Push enabled when checked out elsewhere", () => {
    const { onAction } = renderBadge({ worktreePath: "E:\\repo-agent" });
    fireEvent.contextMenu(screen.getByTitle("main"));
    const item = screen.getByText("Push…").closest('[role="menuitem"]')!;
    expect(item).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    expect(onAction).toHaveBeenCalledWith({ kind: "push", branchName: "main" });
  });

  it("keeps Rename enabled when checked out elsewhere", () => {
    const { onAction } = renderBadge({ worktreePath: "E:\\repo-agent" });
    fireEvent.contextMenu(screen.getByTitle("main"));
    const item = screen.getByText("Rename…").closest('[role="menuitem"]')!;
    expect(item).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    expect(onAction).toHaveBeenCalledWith({ kind: "rename-branch", branchName: "main" });
  });
});
