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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ipc, type RemoteInfo, type PullResult } from "@/lib/ipc";

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

// ─── Fetch ─────────────────────────────────────────────────────────────────

interface FetchProps {
  repoId: string;
  remotes: RemoteInfo[];
  onClose: () => void;
  onSuccess: () => void;
}

export function FetchDialog({ repoId, remotes, onClose, onSuccess }: FetchProps) {
  const [remoteName, setRemoteName] = useState(
    remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? ""
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      await ipc.fetchRemote(repoId, remoteName);
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
          <DialogTitle>Fetch</DialogTitle>
          <DialogDescription>
            Download objects and refs from remote without merging.
          </DialogDescription>
        </DialogHeader>

        <RemoteSelect remotes={remotes} value={remoteName} onChange={setRemoteName} />

        {error && <ErrorNote msg={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={run} disabled={loading || !remoteName}>
            {loading ? "Fetching…" : "Fetch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Pull ──────────────────────────────────────────────────────────────────

interface PullProps {
  repoId: string;
  remotes: RemoteInfo[];
  currentBranch: string;
  onClose: () => void;
  onSuccess: (result: PullResult) => void;
}

export function PullDialog({ repoId, remotes, currentBranch, onClose, onSuccess }: PullProps) {
  const [remoteName, setRemoteName] = useState(
    remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? ""
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const result = await ipc.pullBranch(repoId, remoteName);
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
          <DialogTitle>Pull</DialogTitle>
          <DialogDescription>
            Fetch and merge{" "}
            <code className="font-mono">{remoteName}/{currentBranch}</code>{" "}
            into <code className="font-mono">{currentBranch}</code>.
          </DialogDescription>
        </DialogHeader>

        <RemoteSelect remotes={remotes} value={remoteName} onChange={setRemoteName} />

        {error && <ErrorNote msg={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={run} disabled={loading || !remoteName}>
            {loading ? "Pulling…" : "Pull"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Push ──────────────────────────────────────────────────────────────────

interface PushProps {
  repoId: string;
  remotes: RemoteInfo[];
  currentBranch: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function PushDialog({ repoId, remotes, currentBranch, onClose, onSuccess }: PushProps) {
  const [remoteName, setRemoteName] = useState(
    remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? ""
  );
  const [force, setForce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      await ipc.pushBranch(repoId, remoteName, currentBranch, force);
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
          <DialogTitle>Push</DialogTitle>
          <DialogDescription>
            Push <code className="font-mono">{currentBranch}</code>{" "}
            to <code className="font-mono">{remoteName}</code>.
          </DialogDescription>
        </DialogHeader>

        <RemoteSelect remotes={remotes} value={remoteName} onChange={setRemoteName} />

        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            className="accent-primary"
          />
          Force push (overwrites remote history)
        </label>

        {force && (
          <p className="text-xs text-destructive font-semibold">
            ⚠ Force push will overwrite the remote branch and may cause data loss for collaborators.
          </p>
        )}

        {error && <ErrorNote msg={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button
            variant={force ? "destructive" : "default"}
            onClick={run}
            disabled={loading || !remoteName}
          >
            {loading ? "Pushing…" : force ? "Force Push" : "Push"}
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
}

export function CherryPickDialog({ repoId, oid, summary, onClose, onSuccess, onConflicts }: CherryPickProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const result = await ipc.cherryPick(repoId, oid);
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
