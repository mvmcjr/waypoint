import { useEffect, useState } from "react";
import { FolderGit2, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import { useOpenRepo } from "@/lib/useOpenRepo";
import { truncatePath } from "@/lib/utils";

/**
 * Shown when the user picks a folder that isn't a Git repository. Offers to run
 * `git init` there and open it, instead of dead-ending on an error message.
 */
export function InitRepoDialog() {
  const path = useStore((s) => s.initPromptPath);
  const setPath = useStore((s) => s.setInitPromptPath);
  const openRepo = useOpenRepo();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Repo this folder already sits inside, if any — initializing here would nest one
  // repository inside another's working tree, so it takes an explicit confirmation.
  const [enclosing, setEnclosing] = useState<string | null>(null);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setEnclosing(null);
    ipc.checkInitTarget(path)
      .then((t) => { if (!cancelled) setEnclosing(t.enclosing_repo); })
      .catch(() => { /* surfaced by the init attempt instead */ });
    return () => { cancelled = true; };
  }, [path]);

  function close() {
    if (busy) return;
    setError(null);
    setPath(null);
  }

  async function handleInit() {
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.initRepo(path, enclosing !== null);
      await openRepo(path);
      // Only close once the repo is actually open — closing first would hide any
      // failure from the init/open round trip, leaving the user with no feedback.
      setPath(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={path !== null} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader className="gap-2">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0 border border-primary/20">
              <FolderGit2 className="size-4" />
            </div>
            <DialogTitle className="text-base font-semibold tracking-tight text-foreground">
              Not a Git repository
            </DialogTitle>
          </div>
          <DialogDescription className="text-sm leading-relaxed text-muted-foreground mt-2">
            This folder isn&apos;t a Git repository yet. Initialize one here?
          </DialogDescription>
        </DialogHeader>

        <p className="text-[11px] font-mono text-muted-foreground/60 break-all bg-muted/30 rounded px-2 py-1.5">
          {path ? truncatePath(path, 64) : ""}
        </p>

        {enclosing && (
          <div className="flex gap-2 text-xs text-amber-400/90 bg-amber-400/5 border border-amber-400/20 rounded px-2.5 py-2">
            <TriangleAlert className="size-3.5 shrink-0 mt-px" />
            <span className="leading-relaxed">
              This folder is already inside the repository at{" "}
              <span className="font-mono break-all">{truncatePath(enclosing, 48)}</span>.
              Initializing here creates a repo nested inside another one.
            </span>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleInit} disabled={busy}>
            {busy ? "Initializing…" : enclosing ? "Initialize Anyway" : "Initialize Repository"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
