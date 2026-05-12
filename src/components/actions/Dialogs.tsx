import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ipc } from "@/lib/ipc";

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

// ─── Checkout Commit (detached HEAD) ───────────────────────────────────────

interface CheckoutCommitProps extends BaseProps {
  oid: string;
}

export function CheckoutCommitDialog({ repoId, oid, onClose, onSuccess }: CheckoutCommitProps) {
  const [force, setForce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      await ipc.checkoutCommit(repoId, oid, force);
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
          <DialogTitle>Checkout commit</DialogTitle>
          <DialogDescription>
            This will create a <strong>detached HEAD</strong> at{" "}
            <code className="font-mono">{short(oid)}</code>.
          </DialogDescription>
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

// ─── Checkout Branch ───────────────────────────────────────────────────────

interface CheckoutBranchProps extends BaseProps {
  branchName: string;
}

export function CheckoutBranchDialog({ repoId, branchName, onClose, onSuccess }: CheckoutBranchProps) {
  const [force, setForce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      await ipc.checkoutBranch(repoId, branchName, force);
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
          <DialogTitle>Checkout branch</DialogTitle>
          <DialogDescription>
            Switch to <code className="font-mono">{branchName}</code>
          </DialogDescription>
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
