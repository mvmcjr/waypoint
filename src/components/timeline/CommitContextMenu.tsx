import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { PositionedCommit } from "@/lib/ipc";

export type CommitAction =
  | { kind: "checkout-detached"; oid: string }
  | { kind: "checkout-branch"; branchName: string }
  | { kind: "checkout-remote-branch"; remoteBranch: string }
  | { kind: "create-branch"; oid: string }
  | { kind: "create-tag"; oid: string }
  | { kind: "reset"; oid: string }
  | { kind: "rebase"; oid: string }
  | { kind: "merge"; oid: string; label: string }
  | { kind: "cherry-pick"; oid: string; summary: string };

interface Props {
  item: PositionedCommit;
  onAction: (action: CommitAction) => void;
  children: React.ReactNode;
}

export function CommitContextMenu({ item, onAction, children }: Props) {
  const oid = item.commit.oid;
  const short = oid.slice(0, 8);
  const { local_branches: localBranches, remote_branches: remoteBranches } = item.commit;
  const remoteOnlyBranches = remoteBranches.filter((rb) => !rb.endsWith("/HEAD"));
  // Prefer a local branch; fall back to any ref (remote/tag) for the merge label.
  const mergeLabel =
    localBranches[0] ??
    item.commit.refs.find((r) => r !== "HEAD") ??
    "";

  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(short)}>
          Copy short hash <span className="ml-auto font-mono text-xs text-muted-foreground">{short}</span>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(oid)}>
          Copy full hash
        </ContextMenuItem>

        <ContextMenuSeparator />

        {localBranches.length > 0 ? (
          localBranches.map((branch) => (
            <ContextMenuItem key={branch} onClick={() => onAction({ kind: "checkout-branch", branchName: branch })}>
              Checkout <span className="ml-auto font-mono text-xs text-muted-foreground">{branch}</span>
            </ContextMenuItem>
          ))
        ) : remoteOnlyBranches.length > 0 ? (
          remoteOnlyBranches.map((rb) => (
            <ContextMenuItem key={rb} onClick={() => onAction({ kind: "checkout-remote-branch", remoteBranch: rb })}>
              Checkout <span className="ml-auto font-mono text-xs text-muted-foreground">{rb}</span>
            </ContextMenuItem>
          ))
        ) : (
          <ContextMenuItem onClick={() => onAction({ kind: "checkout-detached", oid })}>
            Checkout <span className="ml-auto font-mono text-xs text-muted-foreground">{short}</span>
          </ContextMenuItem>
        )}

        <ContextMenuItem onClick={() => onAction({ kind: "create-branch", oid })}>
          New branch here…
        </ContextMenuItem>

        <ContextMenuItem onClick={() => onAction({ kind: "create-tag", oid })}>
          New tag here…
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onClick={() => onAction({ kind: "merge", oid, label: mergeLabel })}>
          Merge into current branch
        </ContextMenuItem>

        <ContextMenuItem onClick={() => onAction({ kind: "cherry-pick", oid, summary: item.commit.summary })}>
          Cherry-pick onto current branch
        </ContextMenuItem>

        <ContextMenuItem onClick={() => onAction({ kind: "rebase", oid })}>
          Rebase current branch here
        </ContextMenuItem>

        <ContextMenuItem
          onClick={() => onAction({ kind: "reset", oid })}
          className="text-destructive focus:text-destructive"
        >
          Reset HEAD here…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
