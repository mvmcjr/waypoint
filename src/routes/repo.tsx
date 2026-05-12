import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "@/lib/store";
import { useCommits, useHeadInfo, useRefreshRepo, useRepoStatus } from "@/lib/queries";
import { Timeline } from "@/components/timeline/Timeline";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { CommitDetail } from "@/components/detail/CommitDetail";
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
} from "@/components/actions/Dialogs";
import type { CommitAction } from "@/components/timeline/CommitContextMenu";

// ─── Dialog state ──────────────────────────────────────────────────────────

type DialogState =
  | { kind: "none" }
  | { kind: "checkout-detached"; oid: string }
  | { kind: "checkout-branch"; branchName: string }
  | { kind: "create-branch"; oid: string }
  | { kind: "reset"; oid: string }
  | { kind: "rebase"; oid: string }
  | { kind: "merge"; oid: string; label: string };

// ─── Main view ─────────────────────────────────────────────────────────────

export function RepoView() {
  const { activeTabId: repoId, commits, selectedOid, searchFilter, setCommits, selectCommit, setSearchFilter } =
    useStore();

  const { data, isLoading, error } = useCommits(repoId);
  const { data: head } = useHeadInfo(repoId);
  const { data: status } = useRepoStatus(repoId);
  const refresh = useRefreshRepo(repoId);

  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });
  const [wipSelected, setWipSelected] = useState(false);

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
    selectCommit(oid);
  }

  function handleWipClick() {
    setWipSelected(true);
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

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        repoId={repoId}
        onCheckoutBranch={(branchName) => setDialog({ kind: "checkout-branch", branchName })}
      />

      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Toolbar */}
        <header className="shrink-0 border-b border-border px-3 py-1.5 flex items-center gap-3">
          <span className="text-sm font-semibold text-foreground shrink-0">
            {head?.branch ? (
              <span className="text-green-400">⎇ {head.branch}</span>
            ) : head ? (
              <span className="text-yellow-400">⎇ detached {head.oid.slice(0, 8)}</span>
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

          <span className="ml-auto text-xs text-muted-foreground shrink-0">
            {searchActive
              ? `${filteredCommits.length} / ${commits.length} commits`
              : commits.length > 0
              ? `${commits.length} commits`
              : null}
          </span>
        </header>

        <div className="flex flex-1 overflow-hidden">
          <Timeline
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

          {/* Right panel: conflict resolver, staging view, or commit detail */}
          {wipSelected && repoId && (
            <div className="w-80 shrink-0">
              {mergeInProgress
                ? <ConflictPanel repoId={repoId} onDone={handleCommitSuccess} />
                : <StagingPanel repoId={repoId} onCommitSuccess={handleCommitSuccess} />
              }
            </div>
          )}
          {!wipSelected && selectedItem && repoId && (
            <CommitDetail repoId={repoId} item={selectedItem} />
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
    </div>
  );
}
