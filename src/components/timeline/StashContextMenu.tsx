import { useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ipc } from "@/lib/ipc";
import { useRefreshRepo } from "@/lib/queries";
import { StashRenameDialog } from "@/components/StashRenameDialog";

interface Props {
  repoId: string;
  /** Stash index (stash@{index}). */
  index: number;
  /** Current stash name (for the rename dialog's initial value). */
  currentName: string;
  /** Fires when the menu opens/closes — lets the caller keep the row highlighted while it's open. */
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

/**
 * Context menu for stash rows in the timeline. Stashes aren't real commits, so
 * they get Pop / Apply / Drop instead of the checkout/merge/rebase commit menu.
 */
export function StashContextMenu({ repoId, index, currentName, onOpenChange, children }: Props) {
  const refresh = useRefreshRepo(repoId);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      refresh();
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem disabled={busy} onClick={() => act(() => ipc.popStash(repoId, index))}>
          Pop
          <span className="ml-auto text-xs text-muted-foreground">apply + drop</span>
        </ContextMenuItem>
        <ContextMenuItem disabled={busy} onClick={() => act(() => ipc.applyStash(repoId, index))}>
          Apply
          <span className="ml-auto text-xs text-muted-foreground">keep stash</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={busy} onClick={() => setRenaming(true)}>
          Rename…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={busy}
          onClick={() => act(() => ipc.dropStash(repoId, index))}
          className="text-destructive focus:text-destructive"
        >
          Drop
        </ContextMenuItem>
      </ContextMenuContent>

      {renaming && (
        <StashRenameDialog
          repoId={repoId}
          index={index}
          currentName={currentName}
          onClose={() => setRenaming(false)}
        />
      )}
    </ContextMenu>
  );
}
