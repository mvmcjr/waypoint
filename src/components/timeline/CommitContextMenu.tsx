import { GitBranch, FolderGit2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { PositionedCommit } from "@/lib/ipc";
import { CommitMenuItems } from "./CommitMenuItems";
import type { RefAction } from "./RefBadge";
import { worktreeName } from "@/lib/utils";

// Re-export so existing importers (CommitRow, RefBadge, repo.tsx) don't change.
export type { CommitAction } from "./CommitMenuItems";

interface Props {
  item: PositionedCommit;
  onAction: (action: import("./CommitMenuItems").CommitAction) => void;
  /** For branches checked out in ANOTHER worktree: dispatches "open-worktree". */
  onRefAction?: (action: RefAction) => void;
  /** Local branch shorthand -> the other worktree's path it's checked out in. */
  worktreeByBranch?: Map<string, string>;
  /** Active multi-selection — enables the "Squash N commits…" item. */
  selectedOids?: string[];
  /** Fires when the menu opens/closes — lets the caller keep the row highlighted while it's open. */
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

export function CommitContextMenu({ item, onAction, onRefAction, worktreeByBranch, selectedOids, onOpenChange, children }: Props) {
  const oid = item.commit.oid;
  const { local_branches: localBranches, remote_branches: remoteBranches } = item.commit;
  const remoteOnlyBranches = remoteBranches.filter((rb) => !rb.endsWith("/HEAD"));
  const isHead = item.commit.refs.includes("HEAD");
  const mergeLabel =
    localBranches[0] ??
    item.commit.refs.find((r) => r !== "HEAD") ??
    "";

  const checkoutSlot =
    localBranches.length > 0 ? (
      localBranches.map((branch) => {
        const heldPath = worktreeByBranch?.get(branch);
        if (heldPath) {
          return (
            <ContextMenuItem
              key={branch}
              onClick={() => onRefAction?.({ kind: "open-worktree", path: heldPath })}
            >
              <FolderGit2 />
              Open worktree{" "}
              <span className="ml-auto font-mono text-xs text-muted-foreground">{worktreeName(heldPath)}</span>
            </ContextMenuItem>
          );
        }
        return (
          <ContextMenuItem
            key={branch}
            onClick={() => onAction({ kind: "checkout-branch", branchName: branch })}
          >
            <GitBranch />
            Checkout{" "}
            <span className="ml-auto font-mono text-xs text-muted-foreground">{branch}</span>
          </ContextMenuItem>
        );
      })
    ) : remoteOnlyBranches.length > 0 ? (
      remoteOnlyBranches.map((rb) => (
        <ContextMenuItem
          key={rb}
          onClick={() => onAction({ kind: "checkout-remote-branch", remoteBranch: rb })}
        >
          <GitBranch />
          Checkout{" "}
          <span className="ml-auto font-mono text-xs text-muted-foreground">{rb}</span>
        </ContextMenuItem>
      ))
    ) : (
      <ContextMenuItem onClick={() => onAction({ kind: "checkout-detached", oid })}>
        <GitBranch />
        Checkout{" "}
        <span className="ml-auto font-mono text-xs text-muted-foreground">{oid.slice(0, 8)}</span>
      </ContextMenuItem>
    );

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <CommitMenuItems
          oid={oid}
          isHead={isHead}
          mergeLabel={mergeLabel}
          commitSummary={item.commit.summary}
          onAction={onAction}
          checkoutSlot={checkoutSlot}
          selectedOids={selectedOids}
          pluginContext={{
            surface: "commitContextMenu",
            extra: { commitOid: oid, commitSummary: item.commit.summary },
          }}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
