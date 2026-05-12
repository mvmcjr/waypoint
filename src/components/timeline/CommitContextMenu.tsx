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
  | { kind: "create-branch"; oid: string }
  | { kind: "reset"; oid: string }
  | { kind: "rebase"; oid: string };

interface Props {
  item: PositionedCommit;
  onAction: (action: CommitAction) => void;
  children: React.ReactNode;
}

export function CommitContextMenu({ item, onAction, children }: Props) {
  const oid = item.commit.oid;
  const short = oid.slice(0, 8);

  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem
          onClick={() => onAction({ kind: "checkout-detached", oid })}
        >
          Checkout <span className="ml-auto font-mono text-xs text-muted-foreground">{short}</span>
        </ContextMenuItem>

        <ContextMenuItem onClick={() => onAction({ kind: "create-branch", oid })}>
          New branch here…
        </ContextMenuItem>

        <ContextMenuSeparator />

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
