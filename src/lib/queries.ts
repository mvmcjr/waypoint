import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { ipc } from "./ipc";

export function useCommits(repoId: string | null) {
  return useQuery({
    queryKey: ["commits", repoId],
    // No limit: walk the entire graph. Rendering is virtualized and the per-commit
    // payload is lean (no body), so even very large repos load in one pass.
    queryFn: () => ipc.walkCommits(repoId!),
    enabled: !!repoId,
    staleTime: Infinity,
  });
}

/** Full commit detail (incl. body), fetched lazily for the selected commit. */
export function useCommit(repoId: string | null, oid: string | null) {
  return useQuery({
    queryKey: ["commit", repoId, oid],
    queryFn: () => ipc.getCommit(repoId!, oid!),
    enabled: !!repoId && !!oid,
    staleTime: Infinity,
  });
}

/**
 * Whether `oid` is in the history of `refName` (or HEAD, when `refName` is
 * null). `tipOid` is the current tip of that ref — including it in the query
 * key means the answer recomputes whenever that branch/HEAD moves, with no
 * manual invalidation needed.
 */
export function useCommitInRef(
  repoId: string | null,
  oid: string | null,
  refName: string | null,
  tipOid: string | null,
) {
  return useQuery({
    queryKey: ["commit-in-ref", repoId, oid, refName, tipOid],
    queryFn: () => ipc.isCommitInRef(repoId!, oid!, refName),
    enabled: !!repoId && !!oid && !!tipOid,
    staleTime: Infinity,
  });
}

export function useRefs(repoId: string | null) {
  return useQuery({
    queryKey: ["refs", repoId],
    queryFn: () => ipc.listRefs(repoId!),
    enabled: !!repoId,
    staleTime: Infinity,
  });
}

export function useCommitDiff(repoId: string | null, oid: string | null) {
  return useQuery({
    queryKey: ["diff", repoId, oid],
    queryFn: () => ipc.getCommitDiff(repoId!, oid!),
    enabled: !!repoId && !!oid,
    staleTime: Infinity,
  });
}

export function useWorkdirFileDiff(
  repoId: string | null,
  path: string | null,
  staged: boolean,
) {
  return useQuery({
    queryKey: ["workdir-diff", repoId, path, staged],
    queryFn: () => ipc.getWorkdirDiff(repoId!, path!, staged),
    enabled: !!repoId && !!path,
    staleTime: 0,
  });
}

export function useHeadInfo(repoId: string | null) {
  return useQuery({
    queryKey: ["head", repoId],
    queryFn: () => ipc.getHeadInfo(repoId!),
    enabled: !!repoId,
    staleTime: Infinity,
  });
}

export function useFileStatus(repoId: string | null) {
  return useQuery({
    queryKey: ["staging", repoId],
    queryFn: () => ipc.listStatus(repoId!),
    enabled: !!repoId,
    refetchInterval: 2000,
  });
}

export function useRepoStatus(repoId: string | null) {
  return useQuery({
    queryKey: ["status", repoId],
    queryFn: () => ipc.getRepoStatus(repoId!),
    enabled: !!repoId,
    refetchInterval: 3000,
  });
}

export function useStashes(repoId: string | null) {
  return useQuery({
    queryKey: ["stashes", repoId],
    queryFn: () => ipc.listStashes(repoId!),
    enabled: !!repoId,
    staleTime: Infinity,
  });
}

export function useMergeStatus(repoId: string | null) {
  return useQuery({
    queryKey: ["merge-status", repoId],
    queryFn: () => ipc.getMergeStatus(repoId!),
    enabled: !!repoId,
    staleTime: Infinity,
    // Merge state lives in .git/ (MERGE_HEAD, CHERRY_PICK_HEAD, the index), which
    // the FS watcher already covers via repo-changed → refresh, and every
    // conflict mutation calls useRefreshRepo. So only poll while a merge is
    // actually in flight — as a safety net for index edits the watcher skips —
    // and stay idle the rest of the time instead of scanning every 2s.
    refetchInterval: (query) =>
      query.state.data?.in_progress ? 2000 : false,
  });
}

export function useRemotes(repoId: string | null) {
  return useQuery({
    queryKey: ["remotes", repoId],
    queryFn: () => ipc.listRemotes(repoId!),
    enabled: !!repoId,
    staleTime: Infinity,
  });
}

/** Invalidates commits, refs, head, and status after a mutating action. */
export function useRefreshRepo(repoId: string | null) {
  const qc = useQueryClient();
  return useCallback(() => {
    qc.invalidateQueries({ queryKey: ["commits", repoId] });
    qc.invalidateQueries({ queryKey: ["refs", repoId] });
    qc.invalidateQueries({ queryKey: ["head", repoId] });
    qc.invalidateQueries({ queryKey: ["status", repoId] });
    qc.invalidateQueries({ queryKey: ["staging", repoId] });
    qc.invalidateQueries({ queryKey: ["merge-status", repoId] });
    qc.invalidateQueries({ queryKey: ["stashes", repoId] });
    // Remotes are cached with staleTime: Infinity, so without this a remote added
    // (or removed) while the repo is open never shows up — the Fetch/Pull/Push
    // group stays hidden until the app restarts.
    qc.invalidateQueries({ queryKey: ["remotes", repoId] });
    qc.invalidateQueries({ queryKey: ["workdir-diff", repoId] });
  }, [qc, repoId]);
}
