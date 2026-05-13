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
  CreateBranchDialog,
  ResetDialog,
  RebaseDialog,
  MergeDialog,
  CherryPickDialog,
  PullDialog,
  PushDialog,
} from "@/components/actions/Dialogs";
import type { CommitAction } from "@/components/timeline/CommitContextMenu";
import { ipc, type FileDiff, type PullResult, type RefInfo } from "@/lib/ipc";
import { RefreshCw, ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";

// ─── Dialog state ──────────────────────────────────────────────────────────

type DialogState =
  | { kind: "none" }
  | { kind: "checkout-detached"; oid: string }
  | { kind: "checkout-branch"; branchName: string }
  | { kind: "create-branch"; oid: string }
  | { kind: "reset"; oid: string }
  | { kind: "rebase"; oid: string }
  | { kind: "merge"; oid: string; label: string }
  | { kind: "cherry-pick"; oid: string; summary: string }
  | { kind: "pull" }
  | { kind: "push" };

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
    const remoteName = remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? "";
    if (!remoteName) return;

    setIsFetching(true);
    try {
      await ipc.fetchRemote(repoId, remoteName);
      refresh();
    } catch (e) {
      console.error("Fetch failed", e);
    } finally {
      setIsFetching(false);
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

  function handleCommitAction(action: CommitAction) {
    if (action.kind === "checkout-detached") {
      setDialog({ kind: "checkout-detached", oid: action.oid });
    } else if (action.kind === "create-branch") {
      setDialog({ kind: "create-branch", oid: action.oid });
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

  function handlePullResult(result: PullResult) {
    setDialog({ kind: "none" });
    if (result.kind === "conflicts") {
      setWipSelected(true);
      selectCommit(null);
    }
    refresh();
  }

  const searchActive = searchFilter.trim().length > 0;
  const mergeInProgress = !!status?.merge_in_progress;
  const hasRemotes = (remotes?.length ?? 0) > 0;

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        repoId={repoId}
        onCheckoutBranch={(branchName) => setDialog({ kind: "checkout-branch", branchName })}
        onSelectRef={handleRefSelect}
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
                  disabled={!head?.branch}
                  onClick={() => setDialog({ kind: "pull" })}
                >
                  <ArrowDown size={11} />
                  Pull
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs gap-1"
                  disabled={!head?.branch}
                  onClick={() => setDialog({ kind: "push" })}
                >
                  <ArrowUp size={11} />
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
      {repoId && remotes && head?.branch && dialog.kind === "pull" && (
        <PullDialog
          repoId={repoId}
          remotes={remotes}
          currentBranch={head.branch}
          onClose={() => setDialog({ kind: "none" })}
          onSuccess={handlePullResult}
        />
      )}
      {repoId && remotes && head?.branch && dialog.kind === "push" && (
        <PushDialog
          repoId={repoId}
          remotes={remotes}
          currentBranch={head.branch}
          onClose={() => setDialog({ kind: "none" })}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  );
}
