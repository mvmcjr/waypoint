import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "@/lib/store";
import { useCommits, useHeadInfo, useRefreshRepo, useRemotes, useRepoStatus } from "@/lib/queries";
import { Timeline, type TimelineHandle } from "@/components/timeline/Timeline";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { CommitDetail } from "@/components/detail/CommitDetail";
import { FileDiffPanel } from "@/components/detail/FileDiffPanel";
import { StagingFileDiffPanel } from "@/components/detail/StagingFileDiffPanel";
import { StagingPanel } from "@/components/staging/StagingPanel";
import { ConflictPanel, MergeCommitPanel } from "@/components/staging/ConflictPanel";
import { Input } from "@/components/ui/input";
import {
  CheckoutCommitDialog,
  CheckoutBranchDialog,
  CheckoutRemoteBranchDialog,
  CreateBranchDialog,
  DeleteBranchDialog,
  ResetDialog,
  RebaseDialog,
  SquashDialog,
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

const AUTO_FETCH_INTERVAL_MS = 5 * 60 * 1000;
const FOCUS_FETCH_COOLDOWN_MS = 60 * 1000;

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
  | { kind: "squash"; oids: string[] }
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
  const { activeTabId: repoId, commits, selectedOid, multiSelectedOids, searchFilter, setCommits, selectCommit, setMultiSelected, setSearchFilter } =
    useStore();
  // Anchor commit for shift-click range selection (oid of the last plain/ctrl click).
  const selectionAnchorRef = useRef<string | null>(null);

  const { data, isLoading, error } = useCommits(repoId);
  const { data: head } = useHeadInfo(repoId);
  const { data: status } = useRepoStatus(repoId);
  const { data: remotes } = useRemotes(repoId);
  const refresh = useRefreshRepo(repoId);

  const timelineRef = useRef<TimelineHandle>(null);

  // Always up-to-date ref for the active repo — lets in-flight async handlers
  // detect that the user has switched away and skip stale setDialog() calls.
  const repoIdRef = useRef(repoId);
  repoIdRef.current = repoId;

  // Tracks whether the working directory was dirty in the previous status poll,
  // so we can detect the dirty→clean transition caused by an external commit.
  const wasWorkingDirDirtyRef = useRef(false);

  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });
  const [wipSelected, setWipSelected] = useState(false);
  const [focusedFile, setFocusedFile] = useState<FileDiff | null>(null);
  // repoId is stored alongside path so we can skip the one-render flash where
  // the old path is paired with a new repoId before the reset effect fires.
  const [focusedStagingFile, setFocusedStagingFile] = useState<{ repoId: string; path: string; section: "staged" | "unstaged" } | null>(null);
  const [isFetching, setIsFetching] = useState(false);

  // Refs kept current each render so async callbacks and intervals always read
  // up-to-date values without closing over stale state.
  const remotesRef = useRef(remotes);
  remotesRef.current = remotes;
  const isFetchingRef = useRef(isFetching);
  isFetchingRef.current = isFetching;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const lastAutoFetchRef = useRef<number>(0);
  const autoFetchInFlightRef = useRef(false);

  async function silentFetch(forRepoId: string, remoteName: string) {
    if (autoFetchInFlightRef.current || isFetchingRef.current) return;
    autoFetchInFlightRef.current = true;
    lastAutoFetchRef.current = Date.now();
    try {
      await ipc.fetchRemote(forRepoId, remoteName);
      if (repoIdRef.current !== forRepoId) return;
      refreshRef.current();
    } catch {
      // silent — user can manually fetch if needed
    } finally {
      autoFetchInFlightRef.current = false;
    }
  }

  function tryAutoFetch() {
    const r = remotesRef.current;
    const id = repoIdRef.current;
    if (!id || !r || r.length === 0) return;
    const remoteName = getDefaultRemote(r);
    if (!remoteName) return;
    void silentFetch(id, remoteName);
  }

  async function handleFetch() {
    if (!remotes || remotes.length === 0 || !repoId) return;
    if (autoFetchInFlightRef.current) return;
    const remoteName = getDefaultRemote(remotes);
    if (!remoteName) return;
    const myRepoId = repoId;

    setIsFetching(true);
    const p = ipc.fetchRemote(repoId, remoteName);
    toast.promise(p, {
      loading: `Fetching from ${remoteName}…`,
      success: `Fetched from ${remoteName}`,
      error: (e) => `Fetch failed: ${e}`,
    });
    try {
      await p;
      if (repoIdRef.current !== myRepoId) return;
      refresh();
    } catch {
      // error already shown by toast
    } finally {
      setIsFetching(false);
    }
  }

  const [isPulling, setIsPulling] = useState(false);

  async function handlePull() {
    if (!remotes || remotes.length === 0 || !repoId || !head?.branch) return;
    const remoteName = getDefaultRemote(remotes);
    if (!remoteName) return;
    const myRepoId = repoId;
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
      if (repoIdRef.current !== myRepoId) return; // user switched repos mid-flight
      if (result.kind === "conflicts") {
        setDialog({ kind: "pull-conflicts" });
      }
      refresh();
    } catch (e) {
      if (repoIdRef.current !== myRepoId) return;
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
    const myRepoId = repoId;
    setIsPushing(true);
    const p = ipc.pushBranch(repoId, remoteName, branchName, false);
    toast.promise(p, {
      loading: `Pushing ${branchName}…`,
      success: `Pushed ${branchName} to ${remoteName}`,
      error: () => null, // handled below with dialog
    });
    try {
      await p;
      if (repoIdRef.current !== myRepoId) return; // user switched repos mid-flight
      refresh();
    } catch (e) {
      if (repoIdRef.current !== myRepoId) return;
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

  // RepoView is a single persistent component instance shared across all tabs
  // (App.tsx renders one <RepoView /> regardless of which tab is active).
  // Local panel state — focusedFile, focusedStagingFile, wipSelected, dialog —
  // is NOT cleared by switchTab in the Zustand store, so without this reset
  // those panels survive the tab switch and show stale/wrong-repo content.
  // isFetching/isPulling/isPushing are also reset so the new repo's toolbar
  // buttons aren't frozen in a spinner from the previous repo's in-flight op.
  useEffect(() => {
    setFocusedFile(null);
    setFocusedStagingFile(null);
    setWipSelected(false);
    setDialog({ kind: "none" });
    setIsFetching(false);
    setIsPulling(false);
    setIsPushing(false);
    wasWorkingDirDirtyRef.current = false;
  }, [repoId]);

  // Tauri's WebView doesn't fire browser focus/visibilitychange events, so
  // refetchOnWindowFocus won't work. Use the native Tauri focus event instead.
  // Also auto-fetch on focus (with a cooldown so rapid alt-tabs don't spam).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          refresh();
          if (Date.now() - lastAutoFetchRef.current > FOCUS_FETCH_COOLDOWN_MS) {
            tryAutoFetch();
          }
        }
      })
      .then((fn) => {
        if (cancelled) fn(); // cleanup already ran — unregister immediately
        else unlisten = fn;
      });
    return () => { cancelled = true; unlisten?.(); };
  // tryAutoFetch reads from refs — safe to omit from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // Listen for FS watcher events emitted by the Rust backend when an external
  // git operation modifies the repo (commit from CLI, branch move, fetch, etc.).
  // A second refresh fires 800 ms later to handle the race where the debounce
  // triggers before git finishes writing refs: the first walk_commits runs with
  // stale refs and React Query deduplicates the second watcher fire against the
  // in-flight request, caching the stale result. The delayed retry ensures a
  // correct re-fetch after all writes are guaranteed on disk.
  useEffect(() => {
    if (!repoId) return;
    let unlisten: (() => void) | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    listen<string>('repo-changed', (event) => {
      if (event.payload !== repoId) return;
      refresh();
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { retryTimer = null; refresh(); }, 800);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [repoId, refresh]);

  // Fallback for when the FS watcher fires mid-commit (before git has finished
  // writing refs). The watcher's per-path leading-edge timer can deliver the
  // first object-write event 300 ms early; React Query deduplicates the second
  // watcher fire against the in-flight request, so walk_commits runs with stale
  // refs and the result is stored as fresh. Status polling is immune because it
  // runs on its own independent interval, well after the commit is fully on disk.
  // When status goes dirty→clean, the commit is guaranteed complete: refresh commits.
  useEffect(() => {
    if (!status) return;
    const isDirty = status.staged_count > 0 || status.unstaged_count > 0 || status.merge_in_progress;
    const wasDirty = wasWorkingDirDirtyRef.current;
    wasWorkingDirDirtyRef.current = isDirty;
    if (wasDirty && !isDirty) refresh();
  }, [status, refresh]);

  // Auto-fetch once when a repo is opened. 2 s delay lets the remotes query
  // complete before tryAutoFetch checks remotesRef.
  useEffect(() => {
    if (!repoId) return;
    const timer = setTimeout(tryAutoFetch, 2000);
    return () => clearTimeout(timer);
  // tryAutoFetch reads from refs — intentionally only fires on repo open
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);

  // Auto-fetch every 5 minutes in the background.
  useEffect(() => {
    if (!repoId) return;
    const timer = setInterval(tryAutoFetch, AUTO_FETCH_INTERVAL_MS);
    return () => clearInterval(timer);
  // tryAutoFetch reads from refs — repoId dep resets the interval on tab switch
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);

  // After amend or rebase, the selected commit's OID no longer exists in the
  // new commit list. Clear the stale selection so the detail panel doesn't linger.
  useEffect(() => {
    if (!data || !selectedOid) return;
    if (!data.some((c) => c.commit.oid === selectedOid)) selectCommit(null);
  }, [data, selectedOid, selectCommit]);

  // Auto-open WIP panel when a merge with conflicts starts, or when the user
  // switches to a repo that already has a merge in progress.  repoId is in the
  // dep array so the effect re-fires on tab switch even when merge_in_progress
  // is already true in both the old and new repo (value unchanged → no re-fire
  // without repoId, leaving ConflictPanel closed on the new repo).
  useEffect(() => {
    if (status?.merge_in_progress) {
      setWipSelected(true);
      selectCommit(null);
    }
  }, [status?.merge_in_progress, repoId, selectCommit]);

  function handleSelectCommit(oid: string, mods: { ctrl: boolean; shift: boolean }) {
    setWipSelected(false);
    setFocusedFile(null);
    setFocusedStagingFile(null);

    // Shift-click: select the contiguous range from the anchor to this commit.
    if (mods.shift && selectionAnchorRef.current) {
      const order = filteredCommits.map((c) => c.commit.oid);
      const a = order.indexOf(selectionAnchorRef.current);
      const b = order.indexOf(oid);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        selectCommit(oid); // detail panel follows the clicked commit (also resets multi)
        setMultiSelected(order.slice(lo, hi + 1)); // re-apply the full range
        return;
      }
    }

    // Ctrl/Cmd-click: toggle this commit in the selection.
    if (mods.ctrl) {
      const set = new Set(multiSelectedOids);
      const added = !set.has(oid);
      if (added) set.add(oid);
      else set.delete(oid);
      const next = [...set];

      if (next.length === 0) {
        // Removed the last selected commit — clear selection entirely.
        selectionAnchorRef.current = null;
        selectCommit(null);
        return;
      }
      // Detail panel follows the toggled commit when adding, otherwise falls
      // back to another still-selected commit (never the one just removed).
      const detailOid = added ? oid : next[next.length - 1];
      selectionAnchorRef.current = detailOid;
      selectCommit(detailOid); // also resets multi to [detailOid]
      setMultiSelected(next);  // re-apply the full set
      return;
    }

    // Plain click: single selection.
    selectionAnchorRef.current = oid;
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

  const selectedItem = useMemo(
    () => filteredCommits.find((c) => c.commit.oid === selectedOid) ?? null,
    [filteredCommits, selectedOid],
  );

  function handleRefSelect(ref: RefInfo) {
    if (!ref.target_oid) return;
    handleSelectCommit(ref.target_oid, { ctrl: false, shift: false });
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
    } else if (action.kind === "create-tag") {
      setDialog({ kind: "create-tag", oid: action.oid });
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
    } else if (action.kind === "squash") {
      setDialog({ kind: "squash", oids: action.oids });
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
    setFocusedStagingFile(null);
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
          ) : focusedStagingFile && repoId && focusedStagingFile.repoId === repoId ? (
            <StagingFileDiffPanel
              repoId={repoId}
              path={focusedStagingFile.path}
              section={focusedStagingFile.section}
              onClose={() => setFocusedStagingFile(null)}
            />
          ) : wipSelected && repoId && mergeInProgress ? (
            <ConflictPanel repoId={repoId} />
          ) : (
            <Timeline
              ref={timelineRef}
              repoId={repoId}
              commits={filteredCommits}
              selectedOid={selectedOid}
              multiSelectedOids={multiSelectedOids}
              headOid={head?.oid ?? null}
              headBranch={head?.branch ?? null}
              onSelectOid={handleSelectCommit}
              onCommitAction={handleCommitAction}
              onRefAction={handleRefAction}
              onWipClick={handleWipClick}
              wipSelected={wipSelected}
              searchActive={searchActive}
            />
          )}

          {/* Right panel: merge commit widget or staging view */}
          {wipSelected && repoId && (
            <div className="w-80 shrink-0">
              {mergeInProgress ? (
                <MergeCommitPanel repoId={repoId} onDone={handleCommitSuccess} />
              ) : (
                <StagingPanel
                  repoId={repoId}
                  onCommitSuccess={handleCommitSuccess}
                  onFileClick={(path, section) => setFocusedStagingFile({ repoId: repoId!, path, section })}
                />
              )}
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
      {repoId && dialog.kind === "squash" && (
        <SquashDialog
          repoId={repoId}
          oids={dialog.oids}
          onClose={() => setDialog({ kind: "none" })}
          onSuccess={() => { setDialog({ kind: "none" }); selectCommit(null); refresh(); }}
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
          onLeaveStaged={() => { setDialog({ kind: "none" }); setWipSelected(true); selectCommit(null); refresh(); }}
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
