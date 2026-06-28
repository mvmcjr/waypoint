import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ipc, type CheckoutRemoteResult, type RemoteInfo } from "@/lib/ipc";

// ─── Shared helpers ────────────────────────────────────────────────────────

function short(oid: string) {
  return oid.slice(0, 8);
}

interface BaseProps {
  repoId: string;
  onClose: () => void;
  onSuccess: () => void;
}

function ErrorNote({ msg }: { msg: string }) {
  return <p className="text-xs text-destructive mt-2 break-words">{msg}</p>;
}

// ─── Remote operation helpers ──────────────────────────────────────────────

function RemoteSelect({
  remotes,
  value,
  onChange,
}: {
  remotes: RemoteInfo[];
  value: string;
  onChange: (v: string) => void;
}) {
  if (remotes.length <= 1) {
    return (
      <p className="text-sm text-muted-foreground">
        Remote: <code className="font-mono text-foreground">{value}</code>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground">Remote</label>
      <Select value={value} onValueChange={(v) => v !== null && onChange(v)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {remotes.map((r) => (
            <SelectItem key={r.name} value={r.name}>
              {r.name} — {r.url}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}


// ─── Pull conflicts ────────────────────────────────────────────────────────

interface PullConflictsProps {
  repoId: string;
  onClose: () => void;
  onAbort: () => void;
}

export function PullConflictsDialog({ repoId, onClose, onAbort }: PullConflictsProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAbort() {
    setLoading(true);
    setError(null);
    try {
      await ipc.abortMerge(repoId);
      onAbort();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge conflicts</DialogTitle>
          <DialogDescription>
            The pull resulted in conflicts. Resolve them now, or abort the merge to keep only the fetched changes.
          </DialogDescription>
        </DialogHeader>
        {error && <ErrorNote msg={error} />}
        <DialogFooter>
          <Button variant="outline" onClick={handleAbort} disabled={loading}>
            {loading ? "Aborting…" : "Abort merge"}
          </Button>
          <Button onClick={onClose} disabled={loading}>
            Resolve conflicts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Push rejected ─────────────────────────────────────────────────────────

interface PushRejectedProps {
  repoId: string;
  remoteName: string;
  branchName: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function PushRejectedDialog({ repoId, remoteName, branchName, onClose, onSuccess }: PushRejectedProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleForcePush() {
    setLoading(true);
    setError(null);
    try {
      await ipc.pushBranch(repoId, remoteName, branchName, true);
      onSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Push rejected</DialogTitle>
          <DialogDescription>
            <code className="font-mono">{remoteName}/{branchName}</code> has diverged from your local branch. You can force push to overwrite it.
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-destructive font-semibold">
          ⚠ Force push will overwrite the remote branch and may cause data loss for collaborators.
        </p>
        {error && <ErrorNote msg={error} />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button variant="destructive" onClick={handleForcePush} disabled={loading}>
            {loading ? "Pushing…" : "Force push"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Remote error ──────────────────────────────────────────────────────────

export function RemoteErrorDialog({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remote operation failed</DialogTitle>
          <DialogDescription className="break-words">{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onClose}>Dismiss</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Shared checkout shell ─────────────────────────────────────────────────

interface CheckoutShellProps<T> {
  title: string;
  description: React.ReactNode;
  onRun: (force: boolean) => Promise<T>;
  onClose: () => void;
  onSuccess: (result: T) => void;
}

function CheckoutShell<T>({ title, description, onRun, onClose, onSuccess }: CheckoutShellProps<T>) {
  const [force, setForce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const result = await onRun(force);
      onSuccess(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            className="accent-primary"
          />
          Force (discard uncommitted local changes)
        </label>
        {error && <ErrorNote msg={error} />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={run} disabled={loading}>
            {loading ? "Checking out…" : "Checkout"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Checkout Commit (detached HEAD) ───────────────────────────────────────

interface CheckoutCommitProps extends BaseProps {
  oid: string;
}

export function CheckoutCommitDialog({ repoId, oid, onClose, onSuccess }: CheckoutCommitProps) {
  return (
    <CheckoutShell
      title="Checkout commit"
      description={<>This will create a <strong>detached HEAD</strong> at{" "}<code className="font-mono">{short(oid)}</code>.</>}
      onRun={(force) => ipc.checkoutCommit(repoId, oid, force)}
      onClose={onClose}
      onSuccess={onSuccess}
    />
  );
}

// ─── Checkout Branch ───────────────────────────────────────────────────────

interface CheckoutBranchProps extends BaseProps {
  branchName: string;
}

export function CheckoutBranchDialog({ repoId, branchName, onClose, onSuccess }: CheckoutBranchProps) {
  return (
    <CheckoutShell
      title="Checkout branch"
      description={<>Switch to <code className="font-mono">{branchName}</code></>}
      onRun={(force) => ipc.checkoutBranch(repoId, branchName, force)}
      onClose={onClose}
      onSuccess={onSuccess}
    />
  );
}

// ─── Checkout Remote Branch ────────────────────────────────────────────────

interface CheckoutRemoteBranchProps extends Omit<BaseProps, "onSuccess"> {
  remoteBranch: string;
  /** Receives the checkout outcome so the caller can react (e.g. toast on diverged). */
  onSuccess: (result: CheckoutRemoteResult) => void;
}

export function CheckoutRemoteBranchDialog({ repoId, remoteBranch, onClose, onSuccess }: CheckoutRemoteBranchProps) {
  const localName = remoteBranch.slice(remoteBranch.indexOf("/") + 1);
  return (
    <CheckoutShell
      title="Checkout branch"
      description={<>Switch to <code className="font-mono">{localName}</code>, tracking{" "}<code className="font-mono">{remoteBranch}</code>. If your local branch has diverged, you'll land on the remote tip in a detached HEAD and your local branch is kept.</>}
      onRun={(force) => ipc.checkoutRemoteBranch(repoId, remoteBranch, force)}
      onClose={onClose}
      onSuccess={onSuccess}
    />
  );
}

// ─── Create Branch ─────────────────────────────────────────────────────────

interface CreateBranchProps extends BaseProps {
  oid: string;
}

export function CreateBranchDialog({ repoId, oid, onClose, onSuccess }: CreateBranchProps) {
  const [name, setName] = useState("");
  const [checkout, setCheckout] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const trimmed = name.trim();
    if (!trimmed) { setError("Branch name is required."); return; }
    setLoading(true);
    setError(null);
    try {
      await ipc.createBranchAt(repoId, trimmed, oid, checkout);
      onSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create branch</DialogTitle>
          <DialogDescription>
            New branch at <code className="font-mono">{short(oid)}</code>
          </DialogDescription>
        </DialogHeader>

        <Input
          placeholder="branch-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          autoFocus
        />

        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={checkout}
            onChange={(e) => setCheckout(e.target.checked)}
            className="accent-primary"
          />
          Checkout after creating
        </label>

        {error && <ErrorNote msg={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={run} disabled={loading || !name.trim()}>
            {loading ? "Creating…" : "Create branch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Reset HEAD ────────────────────────────────────────────────────────────

type ResetKind = "soft" | "mixed" | "hard";

interface ResetProps extends BaseProps {
  oid: string;
}

export function ResetDialog({ repoId, oid, onClose, onSuccess }: ResetProps) {
  const [kind, setKind] = useState<ResetKind>("mixed");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      await ipc.resetHead(repoId, oid, kind);
      onSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const options: { value: ResetKind; label: string; desc: string }[] = [
    { value: "soft",  label: "Soft",  desc: "Move HEAD only. Index and working tree unchanged." },
    { value: "mixed", label: "Mixed", desc: "Move HEAD and unstage changes. Working tree unchanged." },
    { value: "hard",  label: "Hard",  desc: "Move HEAD and discard ALL uncommitted changes." },
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset HEAD</DialogTitle>
          <DialogDescription>
            Reset current branch to <code className="font-mono">{short(oid)}</code>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {options.map((opt) => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors
                ${kind === opt.value ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30"}`}
            >
              <input
                type="radio"
                name="reset-kind"
                value={opt.value}
                checked={kind === opt.value}
                onChange={() => setKind(opt.value)}
                className="mt-0.5 accent-primary"
              />
              <div>
                <p className="text-sm font-semibold">{opt.label}</p>
                <p className="text-xs text-muted-foreground">{opt.desc}</p>
              </div>
            </label>
          ))}
        </div>

        {kind === "hard" && (
          <p className="text-xs text-destructive font-semibold">
            ⚠ Hard reset will permanently discard uncommitted changes.
          </p>
        )}

        {error && <ErrorNote msg={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button
            variant={kind === "hard" ? "destructive" : "default"}
            onClick={run}
            disabled={loading}
          >
            {loading ? "Resetting…" : `Reset (${kind})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Merge ─────────────────────────────────────────────────────────────────

interface MergeProps extends BaseProps {
  oid: string;
  label: string;
  currentBranch: string | null;
  onConflicts: () => void;
}

export function MergeDialog({ repoId, oid, label, currentBranch, onClose, onSuccess, onConflicts }: MergeProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const result = await ipc.mergeCommit(repoId, oid, label);
      if (result.kind === "conflicts") {
        onConflicts();
      } else {
        onSuccess();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const target = label || short(oid);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge</DialogTitle>
          <DialogDescription>
            Merge <code className="font-mono">{target}</code> into{" "}
            {currentBranch
              ? <code className="font-mono">{currentBranch}</code>
              : "the current branch"}.
          </DialogDescription>
        </DialogHeader>
        {error && <ErrorNote msg={error} />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={run} disabled={loading}>
            {loading ? "Merging…" : "Merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Cherry-pick ───────────────────────────────────────────────────────────

interface CherryPickProps extends BaseProps {
  oid: string;
  summary: string;
  onConflicts: () => void;
  onLeaveStaged: () => void;
}

export function CherryPickDialog({ repoId, oid, summary, onClose, onSuccess, onConflicts, onLeaveStaged }: CherryPickProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<{ message: string } | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const result = await ipc.cherryPick(repoId, oid);
      if (result.kind === "conflicts") {
        onConflicts();
      } else {
        // Clean apply — ask user: commit now or leave staged.
        setStaged({ message: result.message });
        setCommitMsg(result.message);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleCommit() {
    setCommitting(true);
    setError(null);
    try {
      await ipc.doCommit(repoId, commitMsg.trim());
      onSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setCommitting(false);
    }
  }

  function handleLeaveStaged() {
    onLeaveStaged();
  }

  if (staged) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cherry-pick applied cleanly</DialogTitle>
            <DialogDescription>
              Changes from <code className="font-mono">{short(oid)}</code> are staged.
              Commit now or leave staged to review first.
            </DialogDescription>
          </DialogHeader>

          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            rows={4}
            className="w-full resize-none rounded border border-border bg-background px-2.5 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="Commit message…"
          />

          {error && <ErrorNote msg={error} />}

          <DialogFooter>
            <Button variant="outline" onClick={handleLeaveStaged} disabled={committing}>
              Leave staged
            </Button>
            <Button onClick={handleCommit} disabled={committing || !commitMsg.trim()}>
              {committing ? "Committing…" : "Commit Cherry-pick"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cherry-pick commit</DialogTitle>
          <DialogDescription>
            Apply the changes from{" "}
            <code className="font-mono">{short(oid)}</code> onto the current branch.
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-foreground/80 border border-border rounded px-3 py-2 bg-muted/30 italic">
          "{summary}"
        </p>

        {error && <ErrorNote msg={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={run} disabled={loading}>
            {loading ? "Applying…" : "Cherry-pick"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Revert ────────────────────────────────────────────────────────────────

interface RevertProps extends BaseProps {
  oid: string;
  summary: string;
  onConflicts: () => void;
  onLeaveStaged: () => void;
}

export function RevertDialog({ repoId, oid, summary, onClose, onSuccess, onConflicts, onLeaveStaged }: RevertProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<{ message: string } | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const result = await ipc.revertCommit(repoId, oid);
      if (result.kind === "conflicts") {
        onConflicts();
      } else {
        // Clean apply — ask user: commit now or leave staged.
        setStaged({ message: result.message });
        setCommitMsg(result.message);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleCommit() {
    setCommitting(true);
    setError(null);
    try {
      await ipc.doCommit(repoId, commitMsg.trim());
      onSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setCommitting(false);
    }
  }

  function handleLeaveStaged() {
    onLeaveStaged();
  }

  if (staged) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revert applied cleanly</DialogTitle>
            <DialogDescription>
              Changes to revert <code className="font-mono">{short(oid)}</code> are staged.
              Commit now or leave staged to review first.
            </DialogDescription>
          </DialogHeader>

          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            rows={4}
            className="w-full resize-none rounded border border-border bg-background px-2.5 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="Commit message…"
          />

          {error && <ErrorNote msg={error} />}

          <DialogFooter>
            <Button variant="outline" onClick={handleLeaveStaged} disabled={committing}>
              Leave staged
            </Button>
            <Button onClick={handleCommit} disabled={committing || !commitMsg.trim()}>
              {committing ? "Committing…" : "Commit Revert"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revert commit</DialogTitle>
          <DialogDescription>
            Revert the changes from{" "}
            <code className="font-mono">{short(oid)}</code>. This will create a new commit.
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-foreground/80 border border-border rounded px-3 py-2 bg-muted/30 italic">
          "revert: {summary}"
        </p>

        {error && <ErrorNote msg={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={run} disabled={loading}>
            {loading ? "Reverting…" : "Revert"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Delete Branch ─────────────────────────────────────────────────────────

interface DeleteBranchProps extends BaseProps {
  branchName: string;
}

export function DeleteBranchDialog({ repoId, branchName, onClose, onSuccess }: DeleteBranchProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      await ipc.deleteBranch(repoId, branchName);
      onSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete branch</DialogTitle>
          <DialogDescription>
            Delete local branch <code className="font-mono">{branchName}</code>. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {error && <ErrorNote msg={error} />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button variant="destructive" onClick={run} disabled={loading}>
            {loading ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Rename Branch ─────────────────────────────────────────────────────────

interface RenameBranchProps extends BaseProps {
  branchName: string;
  /** True when a remote branch of the same name exists — enables remote rename. */
  hasRemote: boolean;
  remotes: RemoteInfo[];
}

export function RenameBranchDialog({ repoId, branchName, hasRemote, remotes, onClose, onSuccess }: RenameBranchProps) {
  const [name, setName] = useState(branchName);
  const [alsoRenameRemote, setAlsoRenameRemote] = useState(hasRemote);
  const [remoteName, setRemoteName] = useState(
    remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? ""
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const unchanged = trimmed === branchName;

  async function run() {
    if (!trimmed) { setError("New branch name is required."); return; }
    if (unchanged) { setError("New name is the same as the current name."); return; }
    setLoading(true);
    setError(null);
    try {
      // Local rename first; the remote rename pushes the now-renamed local branch.
      await ipc.renameBranch(repoId, branchName, trimmed);
      if (hasRemote && alsoRenameRemote && remoteName) {
        await ipc.renameRemoteBranch(repoId, remoteName, branchName, trimmed);
      }
      onSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename branch</DialogTitle>
          <DialogDescription>
            Rename <code className="font-mono">{branchName}</code>.
          </DialogDescription>
        </DialogHeader>

        <Input
          placeholder="branch-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          autoFocus
        />

        {hasRemote && remotes.length > 0 && (
          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={alsoRenameRemote}
                onChange={(e) => setAlsoRenameRemote(e.target.checked)}
              />
              Also rename on remote
            </label>
            {alsoRenameRemote && (
              <RemoteSelect remotes={remotes} value={remoteName} onChange={setRemoteName} />
            )}
          </div>
        )}

        {error && <ErrorNote msg={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={run} disabled={loading || !trimmed || unchanged}>
            {loading ? "Renaming…" : "Rename"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Rebase Onto ───────────────────────────────────────────────────────────

interface RebaseProps extends BaseProps {
  ontoOid: string;
  currentBranch: string | null;
}

export function RebaseDialog({ repoId, ontoOid, currentBranch, onClose, onSuccess }: RebaseProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      await ipc.rebaseOnto(repoId, ontoOid);
      onSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rebase branch</DialogTitle>
          <DialogDescription>
            Rebase{" "}
            {currentBranch
              ? <code className="font-mono">{currentBranch}</code>
              : "current branch"}{" "}
            onto <code className="font-mono">{short(ontoOid)}</code>.
            This rewrites commit history.
          </DialogDescription>
        </DialogHeader>

        {error && <ErrorNote msg={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button variant="destructive" onClick={run} disabled={loading}>
            {loading ? "Rebasing…" : "Rebase"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Squash commits ─────────────────────────────────────────────────────────

interface SquashProps extends BaseProps {
  /** The selected commits to combine (contiguous range). */
  oids: string[];
}

export function SquashDialog({ repoId, oids, onClose, onSuccess }: SquashProps) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the suggested subject/body and commit count once on open.
  useEffect(() => {
    let cancelled = false;
    ipc
      .getSquashPreview(repoId, oids)
      .then((p) => {
        if (cancelled) return;
        setCount(p.count);
        setSubject(p.default_subject);
        setBody(p.default_body);
      })
      .catch((e) => !cancelled && setPreviewError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [repoId, oids]);

  async function run() {
    const trimmedSubject = subject.trim();
    if (!trimmedSubject) return;
    const trimmedBody = body.trim();
    const message = trimmedBody ? `${trimmedSubject}\n\n${trimmedBody}` : trimmedSubject;
    setLoading(true);
    setError(null);
    try {
      await ipc.squashCommits(repoId, oids, message);
      onSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Squash commits</DialogTitle>
          <DialogDescription>
            Combine{" "}
            <strong>{count ?? oids.length}</strong>{" "}
            selected commits into one. This rewrites commit history.
          </DialogDescription>
        </DialogHeader>

        {previewError ? (
          <ErrorNote msg={previewError} />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Summary</label>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="font-mono text-sm"
                placeholder="Summary line"
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Description</label>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={7}
                className="font-mono text-sm resize-none"
                placeholder="Extended description (optional)"
              />
            </div>
          </div>
        )}

        {error && <ErrorNote msg={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={run}
            disabled={loading || !!previewError || !subject.trim()}
          >
            {loading ? "Squashing…" : "Squash"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Create Tag ─────────────────────────────────────────────────────────────

interface CreateTagProps extends BaseProps {
  oid: string;
  remotes: RemoteInfo[];
}

export function CreateTagDialog({ repoId, oid, remotes, onClose, onSuccess }: CreateTagProps) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [pushToRemote, setPushToRemote] = useState(false);
  const [remoteName, setRemoteName] = useState(
    remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? ""
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setLoading(true);
    setError(null);
    try {
      await ipc.createTag(repoId, trimmedName, oid, message.trim());
      if (pushToRemote && remoteName) {
        await ipc.pushTag(repoId, remoteName, trimmedName);
      }
      onSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create tag</DialogTitle>
          <DialogDescription>
            Tag commit <code className="font-mono">{short(oid)}</code>.
            Leave message blank for a lightweight tag.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Input
            placeholder="Tag name (e.g. v1.0.0)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            autoFocus
          />
          <Input
            placeholder="Annotation message (optional)"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          {remotes.length > 0 && (
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={pushToRemote}
                onChange={(e) => setPushToRemote(e.target.checked)}
              />
              Push to remote
            </label>
          )}
          {pushToRemote && (
            <RemoteSelect remotes={remotes} value={remoteName} onChange={setRemoteName} />
          )}
        </div>

        {error && <ErrorNote msg={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={run} disabled={loading || !name.trim()}>
            {loading ? "Creating…" : "Create tag"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Delete Tag ──────────────────────────────────────────────────────────────

interface DeleteTagProps extends BaseProps {
  tagName: string;
  remotes: RemoteInfo[];
}

export function DeleteTagDialog({ repoId, tagName, remotes, onClose, onSuccess }: DeleteTagProps) {
  const [alsoDeleteRemote, setAlsoDeleteRemote] = useState(false);
  const [remoteName, setRemoteName] = useState(
    remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? ""
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      await ipc.deleteTag(repoId, tagName);
      if (alsoDeleteRemote && remoteName) {
        await ipc.deleteRemoteTag(repoId, remoteName, tagName);
      }
      onSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete tag</DialogTitle>
          <DialogDescription>
            Delete local tag <code className="font-mono">{tagName}</code>. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {remotes.length > 0 && (
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={alsoDeleteRemote}
                onChange={(e) => setAlsoDeleteRemote(e.target.checked)}
              />
              Also delete from remote
            </label>
          )}
          {alsoDeleteRemote && (
            <RemoteSelect remotes={remotes} value={remoteName} onChange={setRemoteName} />
          )}
        </div>

        {error && <ErrorNote msg={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button variant="destructive" onClick={run} disabled={loading}>
            {loading ? "Deleting…" : "Delete tag"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Push Tag ────────────────────────────────────────────────────────────────

interface PushTagProps extends BaseProps {
  tagName: string;
  remotes: RemoteInfo[];
}

export function PushTagDialog({ repoId, tagName, remotes, onClose, onSuccess }: PushTagProps) {
  const [remoteName, setRemoteName] = useState(
    remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? ""
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!remoteName) return;
    setLoading(true);
    setError(null);
    try {
      await ipc.pushTag(repoId, remoteName, tagName);
      onSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Push tag</DialogTitle>
          <DialogDescription>
            Push tag <code className="font-mono">{tagName}</code> to a remote.
          </DialogDescription>
        </DialogHeader>

        <RemoteSelect remotes={remotes} value={remoteName} onChange={setRemoteName} />

        {error && <ErrorNote msg={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={run} disabled={loading || !remoteName}>
            {loading ? "Pushing…" : "Push tag"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
