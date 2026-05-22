import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "@/lib/store";
import { useCommits, useHeadInfo, useRefreshRepo, useRemotes, useRepoStatus } from "@/lib/queries";
import { Timeline, type TimelineHandle } from "@/components/timeline/Timeline";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { CommitDetail } from "@/components/detail/CommitDetail";
import { FileDiffPanel } from "@/components/detail/FileDiffPanel";
import { StagingFileDiffPanel } from "@/components/detail/StagingFileDiffPanel";
import { StagingPanel } from "@/components/staging/StagingPanel";
import { ConflictPanel } from "@/components/staging/ConflictPanel";
import { Input } from "@/components/ui/input";
import {
  CheckoutCommitDialog,
  CheckoutBranchDialog,
  CheckoutRemoteBranchDialog,
  CreateBranchDialog,
  DeleteBranchDialog,
  ResetDialog,
  RebaseDialog,
  MergeDialog,
  CherryPickDialog,
  PullConflictsDialog,
  PushRejectedDialog,
  RemoteErrorDialog,
  CreateTagDialog,
  DeleteTagDialog,
  PushTagDialog,
} from "@/components/actions/Dialogs";
import type { CommitAction } from "@/components/timeline/CommitContextMenu";
import type { RefAction } from "@/components/sidebar/RefTree";
import { ipc, type FileDiff, type RefInfo, type RemoteInfo } from "@/lib/ipc";
import { RefreshCw, ArrowDown, ArrowUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

function getDefaultRemote(remotes: RemoteInfo[]): string {
  return remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? "";
}

// ─── Dialog state ──────────────────────────────────────────────────────────

type DialogState =
  | { kind: "none" }
  | { kind: "checkout-detached"; oid: string }
  | { kind: "checkout-branch"; branchName: string }
  | { kind: "checkout-remote-branch"; remoteBranch: string }
  | { kind: "create-branch"; oid: string }
  | { kind: "delete-branch"; branchName: string }
  | { kind: "reset"; oid: string }
  | { kind: "rebase"; oid: string }
  | { kind: "merge"; oid: string; label: string }
  | { kind: "cherry-pick"; oid: string; summary: string }
  | { kind: "pull-conflicts" }
  | { kind: "push-rejected"; branchName: string; remoteName: string }
  | { kind: "remote-error"; message: string }
  | { kind: "create-tag"; oid: string }
  | { kind: "delete-tag"; tagName: string }
  | { kind: "push-tag"; tagName: string };

// ─── Main view ─────────────────────────────────────────────────────────────

export function RepoView() {
  const { activeTabId: repoId, commits, selectedOid, searchFilter, setCommits, selectCommit, setSearchFilter } =
    useStore();

  const { data, isLoading, error } = useCommits(repoId);
  const { data: head } = useHeadInfo(repoId);
  const { data: status } = useRepoStatus(repoId);
  const { data: remotes } = useRemotes(repoId);
  const refresh = useRefreshRepo(repoId);

  const timelineRef = useRef<TimelineHandle>(null);

  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });
  const [wipSelected, setWipSelected] = useState(false);
  const [focusedFile, setFocusedFile] = useState<FileDiff | null>(null);
  const [focusedStagingFile, setFocusedStagingFile] = useState<{ path: string; section: "staged" | "unstaged" } | null>(null);
  const [isFetching, setIsFetching] = useState(false);

  async function handleFetch() {
    if (!remotes || remotes.length === 0 || !repoId) return;
    const remoteName = getDefaultRemote(remotes);
    if (!remoteName) return;

    setIsFetching(true);
    try {
      await toast.promise(ipc.fetchRemote(repoId, remoteName), {
        loading: `Fetching from ${remoteName}…`,
        success: `Fetched from ${remoteName}`,
        error: (e) => `Fetch failed: ${e}`,
      });
      refresh();
    } finally {
      setIsFetching(false);
    }
  }

  const [isPulling, setIsPulling] = useState(false);

  async function handlePull() {
    if (!remotes || remotes.length === 0 || !repoId || !head?.branch) return;
    const remoteName = getDefaultRemote(remotes);
    if (!remoteName) return;
    setIsPulling(true);
    const p = ipc.pullBranch(repoId, remoteName);
    toast.promise(p, {
      loading: `Pulling from ${remoteName}…`,
      success: (result) =>
        result.kind === "up_to_date"
          ? "Already up to date"
          : result.kind === "fast_forward"
          ? "Pulled (fast-forward)"
          : "Pulled and merged",
      error: (e) => `Pull failed: ${e}`,
    });
    try {
      const result = await p;
      if (result.kind === "conflicts") {
        setDialog({ kind: "pull-conflicts" });
      }
      refresh();
    } catch (e) {
      setDialog({ kind: "remote-error", message: String(e) });
    } finally {
      setIsPulling(false);
    }
  }

  const [isPushing, setIsPushing] = useState(false);

  async function handlePushBranch(branchName: string) {
    if (!remotes || remotes.length === 0 || !repoId) return;
    const remoteName = getDefaultRemote(remotes);
    if (!remoteName) return;
    setIsPushing(true);
    const p = ipc.pushBranch(repoId, remoteName, branchName, false);
    toast.promise(p, {
      loading: `Pushing ${branchName}…`,
      success: `Pushed ${branchName} to ${remoteName}`,
      error: () => null, // handled below with dialog
    });
    try {
      await p;
      refresh();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("non-fast-forward") || msg.includes("rejected") || msg.includes("fetch first")) {
        setDialog({ kind: "push-rejected", branchName, remoteName });
      } else {
        setDialog({ kind: "remote-error", message: msg });
      }
    } finally {
      setIsPushing(false);
    }
  }

  useEffect(() => {
    if (data) setCommits(data);
  }, [data, setCommits]);

  // Tauri's WebView doesn't fire browser focus/visibilitychange events, so
  // refetchOnWindowFocus won't work. Use the native Tauri focus event instead.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) refresh();
      })
      .then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [refresh]);

  // Auto-open WIP panel when a merge with conflicts starts.
  useEffect(() => {
    if (status?.merge_in_progress) {
      setWipSelected(true);
      selectCommit(null);
    }
  }, [status?.merge_in_progress, selectCommit]);

  function handleSelectCommit(oid: string) {
    setWipSelected(false);
    setFocusedFile(null);
    setFocusedStagingFile(null);
    selectCommit(oid);
  }

  function handleWipClick() {
    setWipSelected(true);
    setFocusedFile(null);
    setFocusedStagingFile(null);
    selectCommit(null);
  }

  const filteredCommits = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    if (!q) return commits;
    return commits.filter(
      (c) =>
        c.commit.summary.toLowerCase().includes(q) ||
        c.commit.author_name.toLowerCase().includes(q) ||
        c.commit.author_email.toLowerCase().includes(q) ||
        c.commit.oid.startsWith(q)
    );
  }, [commits, searchFilter]);

  const selectedItem = filteredCommits.find((c) => c.commit.oid === selectedOid) ?? null;

  function handleRefSelect(ref: RefInfo) {
    if (!ref.target_oid) return;
    handleSelectCommit(ref.target_oid);
    // Defer scroll until after React re-renders the selection
    setTimeout(() => timelineRef.current?.scrollToOid(ref.target_oid!), 0);
  }

  function handleRefAction(action: RefAction) {
    if (action.kind === "checkout-branch") {
      setDialog({ kind: "checkout-branch", branchName: action.branchName });
    } else if (action.kind === "checkout-tag") {
      setDialog({ kind: "checkout-detached", oid: action.oid });
    } else if (action.kind === "merge") {
      setDialog({ kind: "merge", oid: action.oid, label: action.label });
    } else if (action.kind === "rebase") {
      setDialog({ kind: "rebase", oid: action.oid });
    } else if (action.kind === "checkout-remote-branch") {
      setDialog({ kind: "checkout-remote-branch", remoteBranch: action.remoteBranch });
    } else if (action.kind === "push") {
      handlePushBranch(action.branchName);
    } else if (action.kind === "delete-branch") {
      setDialog({ kind: "delete-branch", branchName: action.branchName });
    } else if (action.kind === "push-tag") {
      setDialog({ kind: "push-tag", tagName: action.tagName });
    } else if (action.kind === "delete-tag") {
      setDialog({ kind: "delete-tag", tagName: action.tagName });
    }
  }

  function handleCommitAction(action: CommitAction) {
    if (action.kind === "checkout-detached") {
      setDialog({ kind: "checkout-detached", oid: action.oid });
    } else if (action.kind === "checkout-branch") {
      setDialog({ kind: "checkout-branch", branchName: action.branchName });
    } else if (action.kind === "checkout-remote-branch") {
      setDialog({ kind: "checkout-remote-branch", remoteBranch: action.remoteBranch });
    } else if (action.kind === "create-branch") {
      setDialog({ kind: "create-branch", oid: action.oid });
    } else if (action.kind === "create-tag") {
      setDialog({ kind: "create-tag", oid: action.oid });
    } else if (action.kind === "reset") {
      setDialog({ kind: "reset", oid: action.oid });
    } else if (action.kind === "rebase") {
      setDialog({ kind: "rebase", oid: action.oid });
    } else if (action.kind === "merge") {
      setDialog({ kind: "merge", oid: action.oid, label: action.label });
    } else if (action.kind === "cherry-pick") {
      setDialog({ kind: "cherry-pick", oid: action.oid, summary: action.summary });
    }
  }

  function handleSuccess() {
    setDialog({ kind: "none" });
    refresh();
  }

  function handleMergeConflicts() {
    setDialog({ kind: "none" });
    setWipSelected(true);
    selectCommit(null);
    refresh();
  }

  function handleCommitSuccess() {
    setWipSelected(false);
    refresh();
  }

  const searchActive = searchFilter.trim().length > 0;
  const mergeInProgress = !!status?.merge_in_progress;
  const hasRemotes = (remotes?.length ?? 0) > 0;

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        repoId={repoId}
        onSelectRef={handleRefSelect}
        onRefAction={handleRefAction}
      />

      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Toolbar */}
        <header className="shrink-0 border-b border-border px-3 py-1.5 flex items-center gap-3">
          <span className="text-sm font-semibold text-foreground shrink-0">
            {head?.branch ? (
              <span className="text-teal-400">⎇ {head.branch}</span>
            ) : head ? (
              <span className="text-amber-400/90">⎇ detached {head.oid.slice(0, 8)}</span>
            ) : (
              "Timeline"
            )}
          </span>

          <Input
            className="h-7 text-xs max-w-64"
            placeholder="Search by message, author, or hash…"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
          />

          {isLoading && (
            <span className="text-xs text-muted-foreground shrink-0">Loading…</span>
          )}
          {error && (
            <span className="text-xs text-destructive shrink-0">Error: {String(error)}</span>
          )}

          <div className="ml-auto flex items-center gap-1 shrink-0">
            {hasRemotes && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs gap-1"
                  disabled={isFetching}
                  onClick={handleFetch}
                >
                  <RefreshCw size={11} className={isFetching ? "animate-spin" : ""} />
                  Fetch
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs gap-1"
                  disabled={isPulling || !head?.branch}
                  onClick={handlePull}
                >
                  {isPulling ? <RefreshCw size={11} className="animate-spin" /> : <ArrowDown size={11} />}
                  Pull
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs gap-1"
                  disabled={isPushing || !head?.branch}
                  onClick={() => head?.branch && handlePushBranch(head.branch)}
                >
                  {isPushing ? <RefreshCw size={11} className="animate-spin" /> : <ArrowUp size={11} />}
                  Push
                </Button>
                <div className="w-px h-3.5 bg-border mx-0.5" />
              </>
            )}
            <span className="text-xs text-muted-foreground">
              {searchActive
                ? `${filteredCommits.length} / ${commits.length} commits`
                : commits.length > 0
                ? `${commits.length} commits`
                : null}
            </span>
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          {focusedFile && selectedItem ? (
            <FileDiffPanel
              file={focusedFile}
              commitSummary={selectedItem.commit.summary}
              onClose={() => setFocusedFile(null)}
            />
          ) : focusedStagingFile && repoId ? (
            <StagingFileDiffPanel
              repoId={repoId}
              path={focusedStagingFile.path}
              section={focusedStagingFile.section}
              onClose={() => setFocusedStagingFile(null)}
            />
          ) : (
            <Timeline
              ref={timelineRef}
              repoId={repoId}
              commits={filteredCommits}
              selectedOid={selectedOid}
              headOid={head?.oid ?? null}
              headBranch={head?.branch ?? null}
              onSelectOid={handleSelectCommit}
              onCommitAction={handleCommitAction}
              onWipClick={handleWipClick}
              wipSelected={wipSelected}
              searchActive={searchActive}
            />
          )}

          {/* Right panel: conflict resolver, staging view, or commit detail */}
          {wipSelected && repoId && (
            <div className="w-80 shrink-0">
              {mergeInProgress
                ? <ConflictPanel repoId={repoId} onDone={handleCommitSuccess} />
                : <StagingPanel
                    repoId={repoId}
                    onCommitSuccess={handleCommitSuccess}
                    onFileClick={(path, section) => setFocusedStagingFile({ path, section })}
                  />
              }
            </div>
          )}
          {!wipSelected && selectedItem && repoId && (
            <CommitDetail
              repoId={repoId}
              item={selectedItem}
              onFileClick={(file) => setFocusedFile(file)}
            />
          )}
        </div>
      </div>

      {/* ─── Dialogs ─────────────────────────────────────────── */}
      {repoId && dialog.kind === "checkout-detached" && (
        <CheckoutCommitDialog
          repoId={repoId}
          oid={dialog.oid}
          onClose={() => setDialog({ kind: "none" })}
          onSuccess={handleSuccess}
        />
      )}
      {repoId && dialog.kind === "checkout-branch" && (
        <CheckoutBranchDialog
          repoId={repoId}
          branchName={dialog.branchName}
          onClose={() => setDialog({ kind: "none" })}
          onSuccess={handleSuccess}
        />
      )}
      {repoId && dialog.kind === "checkout-remote-branch" && (
        <CheckoutRemoteBranchDialog
          repoId={repoId}
          remoteBranch={dialog.remoteBranch}
          onClose={() => setDialog({ kind: "none" })}
          onSuccess={handleSuccess}
        />
      )}
      {repoId && dialog.kind === "create-branch" && (
        <CreateBranchDialog
          repoId={repoId}
          oid={dialog.oid}
          onClose={() => setDialog({ kind: "none" })}
          onSuccess={handleSuccess}
        />
      )}
      {repoId && dialog.kind === "reset" && (
        <ResetDialog
          repoId={repoId}
          oid={dialog.oid}
          onClose={() => setDialog({ kind: "none" })}
          onSuccess={handleSuccess}
        />
      )}
      {repoId && dialog.kind === "rebase" && (
        <RebaseDialog
          repoId={repoId}
          ontoOid={dialog.oid}
          currentBranch={head?.branch ?? null}
          onClose={() => setDialog({ kind: "none" })}
          onSuccess={handleSuccess}
        />
      )}
      {repoId && dialog.kind === "merge" && (
        <MergeDialog
          repoId={repoId}
          oid={dialog.oid}
          label={dialog.label}
          currentBranch={head?.branch ?? null}
          onClose={() => setDialog({ kind: "none" })}
          onSuccess={handleSuccess}
          onConflicts={handleMergeConflicts}
        />
      )}
      {repoId && dialog.kind === "cherry-pick" && (
        <CherryPickDialog
          repoId={repoId}
          oid={dialog.oid}
          summary={dialog.summary}
          onClose={() => setDialog({ kind: "none" })}
          onSuccess={handleSuccess}
          onConflicts={handleMergeConflicts}
        />
      )}
      {repoId && dialog.kind === "delete-branch" && (
        <DeleteBranchDialog
          repoId={repoId}
          branchName={dialog.branchName}
          onClose={() => setDialog({ kind: "none" })}
          onSuccess={handleSuccess}
        />
      )}
      {repoId && dialog.kind === "pull-conflicts" && (
        <PullConflictsDialog
          repoId={repoId}
          onClose={() => setDialog({ kind: "none" })}
          onAbort={() => { setDialog({ kind: "none" }); refresh(); }}
        />
      )}
      {repoId && dialog.kind === "push-rejected" && (
        <PushRejectedDialog
          repoId={repoId}
          remoteName={dialog.remoteName}
          branchName={dialog.branchName}
          onClose={() => setDialog({ kind: "none" })}
          onSuccess={() => { setDialog({ kind: "none" }); refresh(); }}
        />
      )}
      {dialog.kind === "remote-error" && (
        <RemoteErrorDialog
          message={dialog.message}
          onClose={() => setDialog({ kind: "none" })}
        />
      )}
      {repoId && dialog.kind === "create-tag" && (
        <CreateTagDialog
          repoId={repoId}
          oid={dialog.oid}
          remotes={remotes ?? []}
          onClose={() => setDialog({ kind: "none" })}
          onSuccess={handleSuccess}
        />
      )}
      {repoId && dialog.kind === "delete-tag" && (
        <DeleteTagDialog
          repoId={repoId}
          tagName={dialog.tagName}
          remotes={remotes ?? []}
          onClose={() => setDialog({ kind: "none" })}
          onSuccess={handleSuccess}
        />
      )}
      {repoId && remotes && dialog.kind === "push-tag" && (
        <PushTagDialog
          repoId={repoId}
          tagName={dialog.tagName}
          remotes={remotes}
          onClose={() => setDialog({ kind: "none" })}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  );
}
