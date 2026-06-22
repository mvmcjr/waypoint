import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ipc } from "@/lib/ipc";
import { useRefreshRepo } from "@/lib/queries";

interface Props {
  repoId: string;
  index: number;
  currentName: string;
  onClose: () => void;
}

/** Rename a stash by rewriting its reflog message. Shared by the sidebar and timeline menus. */
export function StashRenameDialog({ repoId, index, currentName, onClose }: Props) {
  const refresh = useRefreshRepo(repoId);
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.renameStash(repoId, index, trimmed);
      refresh();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename stash</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          placeholder="Stash name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          autoFocus
        />
        {error && <p className="text-xs text-destructive break-words">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy ? "Renaming…" : "Rename"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
