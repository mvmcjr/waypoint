import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { CommitMenuItems, type CommitMenuItemsProps } from "./CommitMenuItems";

vi.mock("@/lib/plugins/registry", () => ({
  usePluginRegistry: (selector?: (s: { plugins: unknown[] }) => unknown) =>
    selector ? selector({ plugins: [] }) : { plugins: [] },
  commandsForSurface: () => [],
}));

vi.mock("@/components/plugins/PluginRunnerProvider", () => ({
  usePluginRunner: () => ({ run: vi.fn() }),
}));

function renderMenu(overrides: Partial<CommitMenuItemsProps> = {}) {
  const onAction = vi.fn();
  render(
    <ContextMenu>
      <ContextMenuTrigger>
        <div>trigger</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <CommitMenuItems
          oid="deadbeef00112233"
          isHead={false}
          mergeLabel="main"
          commitSummary="fix login bug"
          onAction={onAction}
          {...overrides}
        />
      </ContextMenuContent>
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText("trigger"));
  return { onAction };
}

describe("CommitMenuItems", () => {
  it('calls onAction with a check-in-branch action when "Check if in branch…" is clicked', () => {
    const { onAction } = renderMenu();
    fireEvent.click(screen.getByText("Check if in branch…"));
    expect(onAction).toHaveBeenCalledWith({
      kind: "check-in-branch",
      oid: "deadbeef00112233",
      summary: "fix login bug",
    });
  });

  it("falls back to the short hash as the summary when none is provided", () => {
    const { onAction } = renderMenu({ commitSummary: undefined });
    fireEvent.click(screen.getByText("Check if in branch…"));
    expect(onAction).toHaveBeenCalledWith({
      kind: "check-in-branch",
      oid: "deadbeef00112233",
      summary: "deadbeef",
    });
  });
});
