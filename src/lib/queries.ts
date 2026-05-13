import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { ipc } from "./ipc";

export function useCommits(repoId: string | null) {
  return useQuery({
    queryKey: ["commits", repoId],
    queryFn: () => ipc.walkCommits(repoId!, 2000),
    enabled: !!repoId,
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
    refetchOnWindowFocus: "always",
  });
}

export function useMergeStatus(repoId: string | null) {
  return useQuery({
    queryKey: ["merge-status", repoId],
    queryFn: () => ipc.getMergeStatus(repoId!),
    enabled: !!repoId,
    refetchInterval: 2000,
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
  }, [qc, repoId]);
}
