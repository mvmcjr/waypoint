import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ipc, type WorktreeInfo } from "@/lib/ipc";
import { useWorktreeStatus } from "@/lib/queries";
import { useStore } from "@/lib/store";
import { RiskBanner } from "./Dialogs";

function ErrorNote({ msg }: { msg: string }) {
  return <p className="text-xs text-destructive mt-2 break-words">{msg}</p>;
}

interface RemoveWorktreeProps {
  repoId: string;
  worktree: WorktreeInfo;
  currentBranch: string | null;
  onClose: () => void;
  onSuccess: () => void;
}

const DELETE_BRANCH_CHECKBOX_ID = "remove-worktree-delete-branch";
const BRANCH_KEPT_REASON_ID = "remove-worktree-branch-kept-reason";

export function RemoveWorktreeDialog({ repoId, worktree, currentBranch, onClose, onSuccess }: RemoveWorktreeProps) {
  const { data: status, isLoading: statusLoading, isError: statusError } = useWorktreeStatus(worktree.path, { enabled: true });
  const closeTab = useStore((s) => s.closeTab);

  const [deleteBranch, setDeleteBranch] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = status?.changed ?? 0;
  // Only known-dirty (a resolved, non-empty status) shows the danger path — while
  // the status query is still loading, or failed, we don't know either way, so we
  // fall back to the safe default (force: false) rather than guessing "clean".
  const isDirty = !!status && changed > 0;

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const result = await ipc.removeWorktree(repoId, worktree.path, isDirty, deleteBranch);
      if (useStore.getState().tabs.some((t) => t.id === worktree.path)) {
        closeTab(worktree.path);
      }
      if (result.branch_kept_reason) {
        toast.message(result.branch_kept_reason);
      }
      onSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const branchClause = worktree.is_detached
    ? "its commit stays reachable only if another ref points to it."
    : <>commits on <code className="font-mono">{worktree.branch}</code> stay in the repository.</>;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove worktree</DialogTitle>
          <DialogDescription>
            Remove <code className="font-mono">{worktree.name}</code> ({worktree.path}). Its folder is deleted; {branchClause}
          </DialogDescription>
        </DialogHeader>

        {isDirty && (
          <RiskBanner level="danger">
            {changed} uncommitted change(s) in {worktree.name} will be permanently lost.
          </RiskBanner>
        )}

        {statusError && (
          <p className="text-xs text-muted-foreground">
            Couldn't check {worktree.name} for uncommitted changes.
          </p>
        )}

        {worktree.branch && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-sm">
              <Checkbox
                id={DELETE_BRANCH_CHECKBOX_ID}
                checked={deleteBranch}
                disabled={!worktree.branch_merged || loading}
                onCheckedChange={(checked) => setDeleteBranch(checked === true)}
                aria-describedby={!worktree.branch_merged ? BRANCH_KEPT_REASON_ID : undefined}
              />
              <label htmlFor={DELETE_BRANCH_CHECKBOX_ID} className="cursor-pointer select-none">
                Also delete branch <code className="font-mono">{worktree.branch}</code>
              </label>
            </div>
            {!worktree.branch_merged && (
              <p id={BRANCH_KEPT_REASON_ID} className="text-xs text-muted-foreground pl-6">
                Not merged into {currentBranch ?? "the current branch"}. Kept.
              </p>
            )}
          </div>
        )}

        {error && <ErrorNote msg={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button
            variant={isDirty ? "destructive" : "default"}
            onClick={run}
            disabled={loading || statusLoading}
          >
            {loading
              ? "Removing…"
              : statusLoading
              ? "Checking…"
              : isDirty
              ? "Remove and discard changes"
              : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
